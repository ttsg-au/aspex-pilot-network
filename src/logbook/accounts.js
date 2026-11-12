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
// Links use the address the request came in on, so they work whatever BASE_URL says.
const siteOf = (req) => `${req.protocol}://${req.get('host')}`;
function makeLink(u, base) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.update('lbUsers', u.id, { inviteHash: sha(token), inviteExp: Date.now() + INVITE_DAYS * 864e5 });
  return `${base}/logbook/set-password?u=${u.id}&t=${token}`;
}
function linkUser(req) {
  const u = db.get('lbUsers', String(req.query.u || req.body?.u || ''));
  const t = String(req.query.t || req.body?.t || '');
  if (!u || u.disabled || !u.inviteHash || !(u.inviteExp > Date.now())) return null;
  const a = Buffer.from(sha(t)), b = Buffer.from(u.inviteHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
}
async function sendInvite(u, base, { reset = false } = {}) {
  const link = makeLink(u, base);
  const first = (u.name || '').split(' ')[0] || 'there';
  const text = reset
    ? `Hi ${first},\n\nHere's the link to set a new password for your Aspex flight logbook. It works for ${INVITE_DAYS} days.\n\nIf you didn't ask for this, you can ignore this email.`
    : `Hi ${first},

You've been given your own **Aspex flight logbook** - a private record of your flights, drones and batteries, built from your DJI flight records. It's free for Aspex Pilot Network members, and it's yours to use for all your flying. Aspex only sees your flights on Aspex jobs.

**Getting started**

**1. Set your password.** Click the button below (the link works for ${INVITE_DAYS} days). After that, log in any time at ${base}/logbook/ with this email address.

**2. Windows PC: get Import Flights (once).** In your logbook click **Import flights**, then **Download Import Flights**, and save it to your desktop. It's personal to you - it sends flights to your logbook only, so don't share it.

**3. Import your flights.** Plug your DJI controller into the PC by USB and **switch the drone on as well** - with most DJI controllers the flight files only show up while the drone is on and linked. Then double-click **Import Flights** on your desktop. It copies new flights off the controller, sends them to your logbook, opens it, and closes itself.

**The first time you run it, Windows may warn you** because it's a downloaded program: in your browser click **Keep** if asked, and if Windows shows "Windows protected your PC", click **More info**, then **Run anyway**. It only asks once.

**On a Mac?** Skip steps 2 and 3. Copy the flight files (DJIFlightRecord_....txt) off your controller, then in your logbook click **Import flights** and drag them in.

**4. Fill in the Me tab** - your name, ARN and RePL details - so your CASA logs and reminders are right.

Any questions, just reply to this email.`;
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
  if (u && !u.disabled && auth.loginAllowed(req.ip)) { auth.noteFailedLogin(req.ip); try { await sendInvite(u, siteOf(req), { reset: true }); } catch (e) { console.error('logbook reset email:', e.message); } }
  res.redirect('/logbook/forgot?sent=1');
});

// ---------- admin (behind the pilot network admin login) ----------
const admin = express.Router();
const status = (u) => u.disabled ? '<span class="badge bad">Turned off</span>' : u.pwHash ? `<span class="badge good">Active</span>` : '<span class="badge warn">Invited</span>';

// Pilots with a signed contractor agreement who haven't been given a logbook yet.
function waitingPilots() {
  const M = require('../model');
  return db.all('pilots').filter(p => p.email && p.stage !== 'not_proceeding' && M.agreementOf(p)
    && !users().some(u => u.pilotId === p.id || u.email === normEmail(p.email)))
    .sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
}
function waitingSection(req) {
  const done = req.query.sent != null ? `<div class="flash${Number(req.query.failed) ? ' bad' : ''}"><b>${Number(req.query.sent)} invite${Number(req.query.sent) === 1 ? '' : 's'} sent.</b>${Number(req.query.failed) ? ` ${Number(req.query.failed)} couldn't be sent: they're still listed below, so try again or use their pilot page.` : ''}</div>` : '';
  const list = waitingPilots();
  if (!list.length) return done;
  return `${done}<section class="card"><h2>Signed pilots without a logbook (${list.length})</h2>
<p class="sub">These pilots have a signed contractor agreement but haven't been invited to the logbook. Untick anyone you want to leave out, then send. Each gets the invite email with the getting-started steps.</p>
<form method="post" action="/logbook-accounts/invite-many">
${list.map(p => `<label class="tick"><input type="checkbox" name="ids" value="${esc(p.id)}" checked><span><b>${esc(p.fullName || p.email)}</b> <span class="sub">${esc(p.email)}${p.region || p.state ? ' · ' + esc(p.region || p.state) : ''}</span></span></label>`).join('')}
<button data-confirm="Email a logbook invite to the ticked pilots?">Send invites to ticked pilots</button></form></section>`;
}
admin.post('/logbook-accounts/invite-many', async (req, res) => {
  const want = new Set([].concat(req.body.ids || []));
  let sent = 0, failed = 0;
  for (const p of waitingPilots().filter(p => want.has(p.id))) {
    const u = createUser({ email: p.email, name: p.fullName, role: 'pilot', pilotId: p.id });
    try { await sendInvite(u, siteOf(req)); sent++; }
    catch (e) { console.error('logbook invite to', p.email, e.message); db.remove('lbUsers', u.id); failed++; }
  }
  res.redirect(`/logbook-accounts?sent=${sent}&failed=${failed}`);
});

admin.get('/logbook-accounts', (req, res) => {
  const list = users().slice().sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) || a.name.localeCompare(b.name));
  const count = (u) => db.all('lbFlights').filter(f => f.uid === u.id && f.isFlight).length;
  const unowned = db.all('lbFlights').filter(f => !f.uid).length;
  const msg = { saved: 'Saved.', deleted: 'Account deleted.', taken: 'That email already has a logbook account.', bademail: 'That doesn\u2019t look like an email address.' }[req.query.m];
  const link = msg ? `<div class="flash${['taken', 'bademail'].includes(req.query.m) ? ' bad' : ''}">${msg}</div>` : req.query.link ? `<div class="flash"><b>Invite sent.</b> If the email doesn't arrive, send them this link yourself (works for ${INVITE_DAYS} days):<br><input readonly style="width:100%" value="${esc(req.query.link)}" onclick="this.select()"></div>` : '';
  res.send(layout({ title: 'Logbook accounts', active: '/logbook/', flash: link, body: `
<div class="head"><div><h1>Logbook accounts</h1><div class="sub">Each person logs in to their own flight logbook with their email and password. Give a network pilot access from their pilot page (“Give logbook access”).</div></div>
<div class="actions"><a class="btn" href="/logbook/">Open my logbook</a></div></div>
${waitingSection(req)}
${!list.some(u => u.role === 'owner') ? `<section class="card"><h2>Set up your own logbook account first</h2>
<p>${unowned ? `Your logbook (${unowned} flight records) will move into this account.` : ''} You'll get an email to set your password.</p>
<form method="post" action="/logbook-accounts/owner" class="grid"><label>Your name<input name="name" required></label><label>Your email<input type="email" name="email" required></label><div class="full"><button>Create my account</button></div></form></section>` : ''}
<section class="card"><table><tr><th colspan="2">Name and email</th><th>Type</th><th>Status</th><th>Flights</th><th>Last login</th><th></th></tr>
${list.map(u => `<tr><td colspan="2"><form method="post" action="/logbook-accounts/${esc(u.id)}/edit" style="display:flex;gap:6px;align-items:center;margin:0">
<input name="name" value="${esc(u.name)}" style="width:150px" required><input type="email" name="email" value="${esc(u.email)}" style="width:210px" required>
<button class="ghost sm" title="Save name and email">Save</button>${u.pilotId ? ` <a href="/pilots/${esc(u.pilotId)}" class="sub">pilot record</a>` : ''}</form></td><td>${u.role === 'owner' ? 'You (Aspex)' : 'Network pilot'}</td>
<td>${status(u)}</td><td>${count(u)}</td><td>${u.lastLogin ? fmtDateTime(u.lastLogin) : '<span class="sub">never</span>'}</td>
<td><form method="post" action="/logbook-accounts/${esc(u.id)}/invite" style="display:inline"><button class="ghost sm">${u.pwHash ? 'Send password reset' : 'Resend invite'}</button></form>
${u.role === 'owner' ? '' : `<form method="post" action="/logbook-accounts/${esc(u.id)}/${u.disabled ? 'enable' : 'disable'}" style="display:inline"><button class="ghost sm">${u.disabled ? 'Turn back on' : 'Turn off'}</button></form>
<form method="post" action="/logbook-accounts/${esc(u.id)}/delete" style="display:inline"><button class="danger sm" data-confirm="Delete the logbook account for ${esc(u.name || u.email)}?${count(u) ? ` Their ${count(u)} flights will be deleted too.` : ''}">Delete</button></form>`}</td></tr>`).join('') || '<tr><td colspan="7" class="sub">No accounts yet.</td></tr>'}
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
  try { link = await sendInvite(u, siteOf(req)); } catch (e) { link = makeLink(u, siteOf(req)); }
  res.redirect('/logbook-accounts?link=' + encodeURIComponent(link));
});
admin.post('/pilots/:id/logbook-invite', async (req, res) => {
  const p = db.get('pilots', req.params.id);
  if (!p || !p.email) return res.redirect('/pilots/' + req.params.id);
  let u = users().find(x => x.pilotId === p.id) || byEmail(p.email);
  if (!u) u = createUser({ email: p.email, name: p.fullName, role: 'pilot', pilotId: p.id });
  else if (u.pilotId === p.id && u.email !== normEmail(p.email) && !byEmail(p.email)) u = db.update('lbUsers', u.id, { email: normEmail(p.email) }); // pilot's email was corrected
  let link = '';
  try { link = await sendInvite(u, siteOf(req)); } catch (e) { link = makeLink(u, siteOf(req)); }
  res.redirect('/logbook-accounts?link=' + encodeURIComponent(link));
});
admin.post('/logbook-accounts/:id/invite', async (req, res) => {
  const u = db.get('lbUsers', req.params.id);
  let link = '';
  if (u) { try { link = await sendInvite(u, siteOf(req), { reset: !!u.pwHash }); } catch (e) { link = makeLink(u, siteOf(req)); } }
  res.redirect('/logbook-accounts' + (link ? '?link=' + encodeURIComponent(link) : ''));
});
for (const act of ['disable', 'enable']) admin.post(`/logbook-accounts/:id/${act}`, (req, res) => {
  const u = db.get('lbUsers', req.params.id);
  if (u && u.role !== 'owner') db.update('lbUsers', u.id, { disabled: act === 'disable' });
  res.redirect('/logbook-accounts');
});

admin.post('/logbook-accounts/:id/edit', (req, res) => {
  const u = db.get('lbUsers', req.params.id);
  if (!u) return res.redirect('/logbook-accounts');
  const email = normEmail(req.body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.redirect('/logbook-accounts?m=bademail');
  const other = byEmail(email);
  if (other && other.id !== u.id) return res.redirect('/logbook-accounts?m=taken');
  const ch = { name: String(req.body.name || '').slice(0, 120), email };
  if (email !== u.email) Object.assign(ch, { inviteHash: '', inviteExp: 0 });   // old invite link stops working
  db.update('lbUsers', u.id, ch);
  res.redirect('/logbook-accounts?m=saved');
});
admin.post('/logbook-accounts/:id/delete', async (req, res) => {
  const u = db.get('lbUsers', req.params.id);
  if (!u || u.role === 'owner') return res.redirect('/logbook-accounts');
  for (const f of db.all('lbFlights').filter(f => f.uid === u.id)) { if (f.trackFile) db.deleteFile(f.trackFile); }
  db.removeWhere('lbFlights', f => f.uid === u.id);
  db.removeWhere('lbOps', r => r.uid === u.id);
  db.removeWhere('lbState', r => r.uid === u.id);
  db.remove('lbUsers', u.id);
  await db.flush();
  res.redirect('/logbook-accounts?m=deleted');
});

// Button on a pilot's page.
function pilotButton(p) {
  const u = users().find(x => x.pilotId === p.id) || (p.email && byEmail(p.email));
  if (u) return `<a class="btn ghost" href="/logbook-accounts" title="${u.pwHash ? 'Has a logbook' : 'Invited, password not set yet'}">Logbook: ${u.disabled ? 'off' : u.pwHash ? 'active' : 'invited'}</a>`;
  if (!p.email) return '';
  return `<form method="post" action="/pilots/${esc(p.id)}/logbook-invite" style="display:inline"><button class="ghost" data-confirm="Email ${esc(p.fullName)} an invite to their own flight logbook?">Give logbook access</button></form>`;
}

module.exports = { pub, admin, requireUser, current, byUploadKey, pilotButton };
