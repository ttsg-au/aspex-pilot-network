// Logbook accounts: each person (you, and each network pilot you invite) has their own
// email + password and a private logbook. Separate from the pilot network admin login.
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const mail = require('../mail');
const store = require('./store');
const { esc, bare, layout, fmtDateTime } = require('../views');

const COOKIE = 'aspex_lb';
const DAYS = 30;
const INVITE_DAYS = 7;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sign = (v) => crypto.createHmac('sha256', config.sessionSecret + ':logbook').update(v).digest('base64url');
const normEmail = (e) => String(e || '').trim().toLowerCase();

const users = () => db.all('lbUsers');
const byEmail = (e) => users().find(u => u.email === normEmail(e));
const byUploadKey = (k) => k && users().find(u => u.uploadKey && u.uploadKey.length === k.length && crypto.timingSafeEqual(Buffer.from(u.uploadKey), Buffer.from(k)));

function createUser({ email, name, role, pilotId = '' }) {
  return db.insert('lbUsers', { email: normEmail(email), name: String(name || '').slice(0, 120), role, pilotId,
    pwHash: '', uploadKey: crypto.randomBytes(18).toString('base64url'), djiApiKey: '', disabled: false });
}

// ---------- sessions ----------
function startSession(res, u) {
  const payload = Buffer.from(JSON.stringify({ uid: u.id, v: (u.pwHash || '').slice(-8), exp: Date.now() + DAYS * 864e5 })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https'), maxAge: DAYS * 864e5, path: '/' });
}
function current(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const u = s.exp > Date.now() && db.get('lbUsers', s.uid);
    // a password change logs out other sessions
    return u && !u.disabled && (u.pwHash || '').slice(-8) === s.v ? u : null;
  } catch { return null; }
}
function requireUser(req, res, next) {
  const u = current(req);
  if (!u) {
    if (req.originalUrl.startsWith('/logbook/api/')) return res.status(401).type('text').send('Logged out - reload the page to log in again.');
    return res.redirect('/logbook/login?next=' + encodeURIComponent(req.originalUrl));
  }
  req.lb = u;
  next();
}

// ---------- invite / reset links ----------
function makeLink(u) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.update('lbUsers', u.id, { inviteHash: sha(token), inviteExp: Date.now() + INVITE_DAYS * 864e5 });
  return `${config.baseUrl}/logbook/set-password?u=${u.id}&t=${token}`;
}
function linkUser(req) {
  const u = db.get('lbUsers', String(req.query.u || req.body?.u || ''));
  const t = String(req.query.t || req.body?.t || '');
  if (!u || u.disabled || !u.inviteHash || !(u.inviteExp > Date.now())) return null;
  const a = Buffer.from(sha(t)), b = Buffer.from(u.inviteHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
}
async function sendInvite(u, { reset = false } = {}) {
  const link = makeLink(u);
  const first = (u.name || '').split(' ')[0] || 'there';
  const text = reset
    ? `Hi ${first},\n\nHere's the link to set a new password for your Aspex flight logbook. It works for ${INVITE_DAYS} days.\n\nIf you didn't ask for this, you can ignore this email.`
    : `Hi ${first},\n\nYou've been given your own **Aspex flight logbook** - a private record of your flights, drones and batteries, built from your DJI flight records.\n\nClick below to set your password. The link works for ${INVITE_DAYS} days. After that, log in any time at ${config.baseUrl}/logbook/ with this email address.`;
  await mail.send({ to: u.email, subject: reset ? 'Reset your Aspex flight logbook password' : 'Your Aspex flight logbook', text,
    buttons: [{ label: reset ? 'Set a new password' : 'Set your password', url: link, primary: true }] });
  return link;
}

// ---------- pages anyone can reach ----------
const pub = express.Router();
const page = (title, inner) => bare({ title: title + ' · Aspex flight logbook', body: `<div class="card"><h1>${esc(title)}</h1>${inner}</div>` });
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/logbook') && !n.startsWith('//')) ? n : '/logbook/';

pub.get('/logbook/login', (req, res) => {
  if (current(req)) return res.redirect('/logbook/');
  res.send(page('Flight logbook', `<form method="post" action="/logbook/login">
<input type="hidden" name="next" value="${esc(req.query.next || '')}">
${req.query.e ? '<p class="flash bad">That email and password don’t match.</p>' : ''}${req.query.done ? '<p class="flash">Password set - log in below.</p>' : ''}
<label>Email<input type="email" name="email" required autofocus autocomplete="username"></label>
<label>Password<input type="password" name="password" required autocomplete="current-password"></label>
<button>Log in</button></form>
<p class="sub"><a href="/logbook/forgot">Forgotten your password?</a></p>`));
});
pub.post('/logbook/login', (req, res) => {
  const ip = req.ip;
  if (!auth.loginAllowed(ip)) return res.status(429).send(page('Flight logbook', '<p>Too many attempts. Wait 15 minutes and try again.</p>'));
  const u = byEmail(req.body.email);
  if (!u || u.disabled || !auth.checkPassword(String(req.body.password || ''), u.pwHash)) {
    auth.noteFailedLogin(ip);
    return res.redirect('/logbook/login?e=1&next=' + encodeURIComponent(req.body.next || ''));
  }
  db.update('lbUsers', u.id, { lastLogin: new Date().toISOString() });
  startSession(res, u);
  res.redirect(safeNext(req.body.next));
});
pub.get('/logbook/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.redirect('/logbook/login'); });

pub.get('/logbook/set-password', (req, res) => {
  const u = linkUser(req);
  if (!u) return res.send(page('Link expired', '<p>This link has expired or was already used. <a href="/logbook/forgot">Get a new one</a>.</p>'));
  res.send(page('Set your password', `<p>Logbook for <b>${esc(u.email)}</b></p>
<form method="post" action="/logbook/set-password"><input type="hidden" name="u" value="${esc(u.id)}"><input type="hidden" name="t" value="${esc(req.query.t)}">
${req.query.short ? '<p class="flash bad">Use at least 10 characters, and type it the same twice.</p>' : ''}
<label>New password (at least 10 characters)<input type="password" name="pw" minlength="10" required autocomplete="new-password"></label>
<label>Type it again<input type="password" name="pw2" minlength="10" required autocomplete="new-password"></label>
<button>Set password</button></form>`));
});
pub.post('/logbook/set-password', (req, res) => {
  const u = linkUser(req);
  if (!u) return res.redirect('/logbook/set-password');
  const pw = String(req.body.pw || '');
  if (pw.length < 10 || pw !== req.body.pw2) return res.redirect(`/logbook/set-password?u=${u.id}&t=${encodeURIComponent(req.body.t)}&short=1`);
  const v = db.update('lbUsers', u.id, { pwHash: auth.hashPassword(pw), inviteHash: '', inviteExp: 0, lastLogin: new Date().toISOString() });
  startSession(res, v);
  res.redirect('/logbook/');
});
pub.get('/logbook/forgot', (req, res) => res.send(page('Forgotten password', req.query.sent
  ? '<p>If that email has a logbook, a link to set a new password is on its way.</p>'
  : `<form method="post" action="/logbook/forgot"><label>Your email<input type="email" name="email" required></label><button>Email me a link</button></form>`)));
pub.post('/logbook/forgot', async (req, res) => {
  const u = byEmail(req.body.email);
  if (u && !u.disabled && auth.loginAllowed(req.ip)) { auth.noteFailedLogin(req.ip); try { await sendInvite(u, { reset: true }); } catch (e) { console.error('logbook reset email:', e.message); } }
  res.redirect('/logbook/forgot?sent=1');
});

// ---------- admin (behind the pilot network admin login) ----------
const admin = express.Router();
const status = (u) => u.disabled ? '<span class="badge bad">Turned off</span>' : u.pwHash ? `<span class="badge good">Active</span>` : '<span class="badge warn">Invited</span>';

admin.get('/logbook-accounts', (req, res) => {
  const list = users().slice().sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) || a.name.localeCompare(b.name));
  const count = (u) => db.all('lbFlights').filter(f => f.uid === u.id && f.isFlight).length;
  const unowned = db.all('lbFlights').filter(f => !f.uid).length;
  const link = req.query.link ? `<div class="flash"><b>Invite sent.</b> If the email doesn't arrive, send them this link yourself (works for ${INVITE_DAYS} days):<br><input readonly style="width:100%" value="${esc(req.query.link)}" onclick="this.select()"></div>` : '';
  res.send(layout({ title: 'Logbook accounts', active: '/logbook/', flash: link, body: `
<div class="head"><div><h1>Logbook accounts</h1><div class="sub">Each person logs in to their own flight logbook with their email and password. Give a network pilot access from their pilot page (“Give logbook access”).</div></div>
<div class="actions"><a class="btn" href="/logbook/">Open my logbook</a></div></div>
${!list.some(u => u.role === 'owner') ? `<section class="card"><h2>Set up your own logbook account first</h2>
<p>${unowned ? `Your logbook (${unowned} flight records) will move into this account.` : ''} You'll get an email to set your password.</p>
<form method="post" action="/logbook-accounts/owner" class="grid"><label>Your name<input name="name" required></label><label>Your email<input type="email" name="email" required></label><div class="full"><button>Create my account</button></div></form></section>` : ''}
<section class="card"><table><tr><th>Name</th><th>Email</th><th>Type</th><th>Status</th><th>Flights</th><th>Last login</th><th></th></tr>
${list.map(u => `<tr><td>${u.pilotId ? `<a href="/pilots/${esc(u.pilotId)}">${esc(u.name)}</a>` : esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role === 'owner' ? 'You (Aspex)' : 'Network pilot'}</td>
<td>${status(u)}</td><td>${count(u)}</td><td>${u.lastLogin ? fmtDateTime(u.lastLogin) : '<span class="sub">never</span>'}</td>
<td><form method="post" action="/logbook-accounts/${esc(u.id)}/invite" style="display:inline"><button class="ghost sm">${u.pwHash ? 'Send password reset' : 'Resend invite'}</button></form>
${u.role === 'owner' ? '' : `<form method="post" action="/logbook-accounts/${esc(u.id)}/${u.disabled ? 'enable' : 'disable'}" style="display:inline"><button class="ghost sm">${u.disabled ? 'Turn back on' : 'Turn off'}</button></form>`}</td></tr>`).join('') || '<tr><td colspan="7" class="sub">No accounts yet.</td></tr>'}
</table></section>` }));
});
admin.post('/logbook-accounts/owner', async (req, res) => {
  if (users().some(u => u.role === 'owner')) return res.redirect('/logbook-accounts');
  const email = normEmail(req.body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.redirect('/logbook-accounts');
  const u = createUser({ email, name: req.body.name, role: 'owner' });
  const claimed = await store.claimUnowned(u.id);
  if (claimed.djiApiKey) db.update('lbUsers', u.id, { djiApiKey: claimed.djiApiKey });
  let link = '';
  try { link = await sendInvite(u); } catch (e) { link = makeLink(u); }
  res.redirect('/logbook-accounts?link=' + encodeURIComponent(link));
});
admin.post('/pilots/:id/logbook-invite', async (req, res) => {
  const p = db.get('pilots', req.params.id);
  if (!p || !p.email) return res.redirect('/pilots/' + req.params.id);
  let u = users().find(x => x.pilotId === p.id) || byEmail(p.email);
  if (!u) u = createUser({ email: p.email, name: p.fullName, role: 'pilot', pilotId: p.id });
  let link = '';
  try { link = await sendInvite(u); } catch (e) { link = makeLink(u); }
  res.redirect('/logbook-accounts?link=' + encodeURIComponent(link));
});
admin.post('/logbook-accounts/:id/invite', async (req, res) => {
  const u = db.get('lbUsers', req.params.id);
  let link = '';
  if (u) { try { link = await sendInvite(u, { reset: !!u.pwHash }); } catch (e) { link = makeLink(u); } }
  res.redirect('/logbook-accounts' + (link ? '?link=' + encodeURIComponent(link) : ''));
});
for (const act of ['disable', 'enable']) admin.post(`/logbook-accounts/:id/${act}`, (req, res) => {
  const u = db.get('lbUsers', req.params.id);
  if (u && u.role !== 'owner') db.update('lbUsers', u.id, { disabled: act === 'disable' });
  res.redirect('/logbook-accounts');
});

// Button on a pilot's page.
function pilotButton(p) {
  const u = users().find(x => x.pilotId === p.id) || (p.email && byEmail(p.email));
  if (u) return `<a class="btn ghost" href="/logbook-accounts" title="${u.pwHash ? 'Has a logbook' : 'Invited, password not set yet'}">Logbook: ${u.disabled ? 'off' : u.pwHash ? 'active' : 'invited'}</a>`;
  if (!p.email) return '';
  return `<form method="post" action="/pilots/${esc(p.id)}/logbook-invite" style="display:inline"><button class="ghost" data-confirm="Email ${esc(p.fullName)} an invite to their own flight logbook?">Give logbook access</button></form>`;
}

module.exports = { pub, admin, requireUser, current, byUploadKey, pilotButton };
