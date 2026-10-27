// Dashboard, login, adding/importing pilots, and the website form webhook.
const express = require('express');
const db = require('../db');
const config = require('../config');
const M = require('../model');
const auth = require('../auth');
const mail = require('../mail');
const intake = require('../intake');
const { esc, fmtDate, fmtDateTime, layout, bare, options, badge, expiryBadge } = require('../views');

const router = express.Router();     // admin-only
const publicRouter = express.Router();
const flashOf = (req) => req.query.msg ? String(req.query.msg) : '';

// ---------- Login ----------
publicRouter.get('/login', (req, res) => {
  const setup = !config.adminPasswordHash;
  res.send(bare({ title: 'Log in · Aspex Pilot Network', body: `
<p class="brandline"><span class="dot"></span>Aspex Drone Services</p>
<h1>Pilot Network</h1>
${setup ? '<p class="flash warn">No admin password set yet. Run <code>npm run set-password</code> on the server, then restart the app.</p>' : ''}
${req.query.err ? '<p class="flash bad">That email or password isn’t right.</p>' : ''}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(req.query.next || '/')}">
<label>Email<input type="email" name="email" value="${esc(config.adminEmail)}" required></label>
<label>Password<input type="password" name="password" required autofocus></label>
<button>Log in</button></form>` }));
});
publicRouter.post('/login', (req, res) => {
  const ip = req.ip;
  if (!auth.loginAllowed(ip)) return res.status(429).send(bare({ title: 'Wait', body: '<p>Too many attempts. Try again in 15 minutes.</p>' }));
  const { email = '', password = '', next = '/' } = req.body || {};
  if (email.trim().toLowerCase() === config.adminEmail.toLowerCase() && auth.checkPassword(password, config.adminPasswordHash)) {
    auth.makeSession(res, config.adminEmail);
    return res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  }
  auth.noteFailedLogin(ip);
  res.redirect('/login?err=1&next=' + encodeURIComponent(next));
});
publicRouter.post('/logout', (req, res) => { res.clearCookie(auth.COOKIE, { path: '/' }); res.redirect('/login'); });

// ---------- Website form → app ----------
// Point the website form's webhook at: https://<this app>/api/register?key=<WEBHOOK_SECRET>
publicRouter.post('/api/register', (req, res) => {
  const key = req.query.key || req.get('x-webhook-key') || (req.body && req.body.key);
  if (!config.webhookSecret || key !== config.webhookSecret) return res.status(401).json({ ok: false, error: 'bad key' });
  try {
    const reg = intake.normalise(req.body || {});
    if (!reg.email) return res.status(400).json({ ok: false, error: 'no email field found' });
    const { pilot, isNew } = intake.upsertFromRegistration(reg, 'website form');
    res.json({ ok: true, id: pilot.id, isNew });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Dashboard ----------
router.get('/', (req, res) => {
  const pilots = db.all('pilots');
  const active = pilots.filter(p => !['not_proceeding', 'on_hold'].includes(p.stage));
  const byStage = M.STAGES.map(s => [s, pilots.filter(p => p.stage === s.id).length]);
  const byState = M.STATES.map(s => [s, active.filter(p => p.state === s).length]);
  const unknownState = active.filter(p => !p.state).length;
  const newOnes = pilots.filter(p => p.stage === 'registered').sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const quals = db.all('qualifications').map(q => ({ q, p: db.get('pilots', q.pilotId), st: M.expiryStatus(q) })).filter(x => x.p);
  const expiring = quals.filter(x => x.st === 'expired' || x.st === 'soon').sort((a, b) => a.q.expiresOn.localeCompare(b.q.expiresOn));
  const unverified = quals.filter(x => !x.q.verified && x.p.stage !== 'not_proceeding');
  const openJobs = db.where('jobs', j => j.status === 'open');
  const recentReplies = db.where('jobResponses', r => r.answeredAt).sort((a, b) => b.answeredAt.localeCompare(a.answeredAt)).slice(0, 8);
  const priority = ['QLD', 'TAS', 'SA'];

  res.send(layout({ title: 'Dashboard', active: '/', flash: flashOf(req), body: `
<div class="head"><h1>Dashboard</h1><div class="actions"><a class="btn" href="/messages/new">Message pilots</a> <a class="btn ghost" href="/jobs/new">New job</a></div></div>
${db.mode() !== 'mysql' ? '<div class="flash bad"><b>Records are not being saved to a database.</b> On GoDaddy they will be lost the next time the app restarts. Add the MySQL settings to the app\u2019s secrets (see the README), then restart.</div>' : ''}
${db.status().lastWriteError ? `<div class="flash bad"><b>The last save to the database failed</b> (${esc(db.status().lastWriteError.message)}). Download a backup from <a href="/backup">Backup</a> now.</div>` : ''}
${config.mailDryRun ? '<div class="flash warn">Test mode: emails are saved to data/outbox, not sent. Add the Microsoft 365 password (SMTP_PASS) in .env to send for real.</div>' : ''}
<div class="stats">
<a class="stat" href="/pilots"><b>${active.length}</b><span>Active pilots</span></a>
<a class="stat" href="/pilots?stage=registered"><b>${newOnes.length}</b><span>New, not contacted</span></a>
<a class="stat" href="/pilots?stage=approved"><b>${pilots.filter(p => p.stage === 'approved').length}</b><span>Approved for solo work</span></a>
<a class="stat ${expiring.length ? 'warn' : ''}" href="#expiring"><b>${expiring.length}</b><span>Credentials expired / expiring</span></a>
<a class="stat" href="/jobs"><b>${openJobs.length}</b><span>Open jobs</span></a>
</div>

<div class="cols">
<section class="card"><h2>Where pilots are</h2>
<div class="statebars">${byState.map(([s, n]) => `<a href="/pilots?state=${s}" class="${priority.includes(s) ? 'prio' : ''}"><span>${s}</span><i style="width:${Math.min(100, n * 12)}%"></i><b>${n}</b></a>`).join('')}
${unknownState ? `<a href="/pilots"><span>?</span><i style="width:${Math.min(100, unknownState * 12)}%"></i><b>${unknownState}</b></a>` : ''}</div>
<p class="sub">Highlighted: priority recruiting states (North Queensland, Tasmania, South Australia).${unknownState ? ' “?” = state not worked out from their home base – set it on their record.' : ''}</p></section>
<section class="card"><h2>Pathway</h2><ul class="stagecounts">${byStage.map(([s, n]) => `<li><a href="/pilots?stage=${s.id}">${badge(s.label, 'stage-' + s.id)}</a> <b>${n}</b></li>`).join('')}</ul></section>
</div>

<div class="cols">
<section class="card"><h2>New registrations to follow up</h2>
<ul class="timeline">${newOnes.slice(0, 10).map(p => `<li><a href="/pilots/${p.id}"><b>${esc(p.fullName)}</b></a> · ${esc(p.homeBase)} ${p.state ? '<span class="state">' + p.state + '</span>' : ''} · <span class="sub">${fmtDateTime(p.registeredAt || p.createdAt)}</span></li>`).join('') || '<li class="empty">All caught up.</li>'}</ul>
${newOnes.length ? `<p><a class="btn ghost" href="/messages/new?ids=${newOnes.map(p => p.id).join(',')}&template=next_steps">Send these ${newOnes.length} their next steps</a></p>` : ''}</section>
<section class="card"><h2>Latest job replies</h2>
<ul class="timeline">${recentReplies.map(r => { const p = db.get('pilots', r.pilotId) || {}; const j = db.get('jobs', r.jobId) || {};
    return `<li><a href="/pilots/${r.pilotId}"><b>${esc(p.fullName)}</b></a> ${badge(r.answer === 'interested' ? 'Interested' : 'Not available', r.answer === 'interested' ? 'good' : 'plain')} <a href="/jobs/${r.jobId}">${esc(j.title)}</a> <span class="sub">${fmtDateTime(r.answeredAt)}</span></li>`; }).join('') || '<li class="empty">No replies yet.</li>'}</ul></section>
</div>

<section class="card" id="expiring"><h2>Credentials expired or expiring within ${config.expiryWarnDays} days</h2>
<div class="tablewrap"><table class="list"><tbody>${expiring.map(({ q, p, st }) => `<tr><td><a href="/pilots/${p.id}">${esc(p.fullName)}</a></td><td>${esc(M.qualLabel(q.type))} ${esc(q.number)}</td><td>${expiryBadge(st, q.expiresOn)}</td>
<td><form method="post" action="/quals/${q.id}/remind"><button class="ghost small">Email reminder</button></form></td></tr>`).join('') || '<tr><td class="empty">Nothing expiring.</td></tr>'}</tbody></table></div></section>

<section class="card"><h2>Credentials waiting for you to check <span class="count">${unverified.length}</span></h2>
<p class="sub">These came from the registration form or were added without being verified. Open the pilot, look at the certificate, and tick “Verified by me”.</p>
<ul class="timeline">${Object.values(unverified.reduce((acc, x) => { (acc[x.p.id] ||= { p: x.p, list: [] }).list.push(x.q); return acc; }, {})).map(({ p, list }) =>
    `<li><a href="/pilots/${p.id}"><b>${esc(p.fullName)}</b></a> · ${list.map(q => esc(M.qualLabel(q.type).split(' (')[0])).join(', ')}</li>`).join('') || '<li class="empty">All checked.</li>'}</ul></section>
` }));
});

// ---------- Add / import ----------
router.get('/import', (req, res) => {
  res.send(layout({ title: 'Add or import pilots', active: '/import', flash: flashOf(req), body: `
<div class="head"><h1>Add or import pilots</h1></div>
<div class="cols">
<section class="card"><h2>Paste a registration email</h2>
<p class="sub">Copy the whole body of an “Expression of Interest – Pilot Network” email from Outlook and paste it here. If that pilot is already in the system (same email), their form answers are updated.</p>
<form method="post" action="/import/email"><textarea name="text" rows="14" placeholder="Pilot: …&#10;Email: …&#10;Business: …" required></textarea><button>Import</button></form></section>
<section class="card"><h2>Add a pilot by hand</h2>
<form method="post" action="/import/manual" class="grid2">
<label>Full name<input name="fullName" required></label>
<label>Email<input type="email" name="email" required></label>
<label>Mobile<input name="mobile"></label>
<label>Business name and ABN<input name="business"></label>
<label>Home base (town, state)<input name="homeBase"></label>
<label>Travel<select name="travel">${options(M.TRAVEL_OPTIONS, '', { blank: '—' })}</select></label>
<label>Interested in<select name="interest">${options([['Part A – Solar (sub-2 kg)', 'Part A'], ['Part B – Certified operators (ReOC)', 'Part B'], ['Part A – Solar (sub-2 kg), Part B – Certified operators (ReOC)', 'Both']], '')}</select></label>
<label>ARN<input name="arn"></label>
<div class="full"><button>Add pilot</button></div></form></section>
</div>
<section class="card"><h2>Import a file of registrations</h2>
<p class="sub">Upload <code>seed-registrations.json</code> (the earlier sign-ups). Pilots already in the system (same email) are updated, not duplicated.</p>
<form method="post" action="/import/file" enctype="multipart/form-data"><input type="file" name="file" accept=".json" required> <button>Import file</button></form></section>
<section class="card"><h2>Import credentials</h2>
<p class="sub">Upload a credentials file (prepared from pilots' emailed documents). It adds each document to the right pilot, fills in numbers and dates, and ticks it verified. Pilots are matched by email address; nothing is deleted.</p>
<form method="post" action="/import/credentials" enctype="multipart/form-data"><input type="file" name="file" accept=".json" required> <button>Import credentials</button></form></section>
<section class="card"><h2>Connect the website form</h2>
<p>New registrations can come straight in from the form on aspex.com.au. In WordPress, add a webhook to the pilot network form that posts to:</p>
<pre>${esc(config.baseUrl)}/api/register?key=${config.webhookSecret ? esc(config.webhookSecret) : '&lt;WEBHOOK_SECRET from .env&gt;'}</pre>
<p class="sub">See the README for the step-by-step. Until then, paste each notification email above.</p></section>` }));
});

router.post('/import/email', (req, res) => {
  const reg = intake.parseNotificationEmail(req.body.text || '');
  if (!reg.email) return res.redirect('/import?msg=' + encodeURIComponent('Couldn’t find an “Email:” line in that text.'));
  const { pilot, isNew } = intake.upsertFromRegistration(reg, 'pasted email');
  res.redirect(`/pilots/${pilot.id}?msg=` + encodeURIComponent(isNew ? 'Pilot added from the email.' : 'Existing pilot updated from the email.'));
});
// Upload of seed-registrations.json: [{ receivedAt, text, state? }, ...]
const multer = require('multer');
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
router.post('/import/file', memUpload.single('file'), (req, res) => {
  let list;
  try { list = JSON.parse(req.file.buffer.toString('utf8')); } catch { list = null; }
  if (!Array.isArray(list)) return res.redirect('/import?msg=' + encodeURIComponent('That file isn\u2019t a registrations file.'));
  let added = 0, updated = 0;
  for (const s of list) {
    const reg = intake.parseNotificationEmail(s.text || '');
    if (!reg.email) continue;
    const { pilot, isNew } = intake.upsertFromRegistration(reg, 'website form (imported from email)');
    if (isNew) {
      added++;
      const when = s.receivedAt && !isNaN(Date.parse(s.receivedAt)) ? new Date(s.receivedAt).toISOString() : pilot.registeredAt;
      db.update('pilots', pilot.id, { registeredAt: when, ...(s.state && !pilot.state ? { state: s.state } : {}) });
    } else updated++;
  }
  res.redirect('/pilots?msg=' + encodeURIComponent(`Imported: ${added} added, ${updated} updated.`));
});
router.post('/import/manual', (req, res) => {
  const { pilot, isNew } = intake.upsertFromRegistration({ ...req.body }, 'manual entry');
  res.redirect(`/pilots/${pilot.id}?msg=` + encodeURIComponent(isNew ? 'Pilot added.' : 'A pilot with that email already existed – updated.'));
});

// ---------- Import credentials (documents received by email) ----------
// File shape: { app: 'aspex-pilot-network-credentials', pilots: [ { email, set: {...pilot fields},
//   record: 'note text', credentials: [ { type, number, detail, issuedOn, expiresOn, verified, note,
//   file: { name, mime, base64 } } ] } ] }
const bigUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
const PILOT_FIELDS = ['homeBase', 'state', 'region', 'phoneType', 'fullName', 'mobile', 'business', 'abn', 'travel'];
router.post('/import/credentials', bigUpload.single('file'), async (req, res) => {
  let bundle;
  try { bundle = JSON.parse(req.file.buffer.toString('utf8')); } catch { bundle = null; }
  if (!bundle || bundle.app !== 'aspex-pilot-network-credentials' || !Array.isArray(bundle.pilots)) {
    return res.redirect('/import?msg=' + encodeURIComponent('That isn\u2019t a credentials file.'));
  }
  const report = [];
  for (const entry of bundle.pilots) {
    const pilot = db.all('pilots').find(p => (p.email || '').toLowerCase() === String(entry.email || '').toLowerCase());
    if (!pilot) { report.push(`${entry.email}: no pilot with this email – skipped`); continue; }
    const set = {};
    for (const k of PILOT_FIELDS) if (entry.set && entry.set[k] !== undefined) set[k] = entry.set[k];
    if (Object.keys(set).length) db.update('pilots', pilot.id, set);
    let added = 0, updated = 0;
    for (const c of entry.credentials || []) {
      let stored = null;
      if (c.file && c.file.base64) {
        const id = await db.saveFile(Buffer.from(c.file.base64, 'base64'), c.file.name || 'certificate', c.file.mime || 'application/octet-stream');
        stored = { file: id, fileName: c.file.name || 'certificate' };
      }
      const fields = {};
      for (const k of ['number', 'detail', 'issuedOn', 'expiresOn', 'note']) if (c[k] !== undefined) fields[k] = c[k];
      if (c.verified) { fields.verified = true; fields.verifiedOn = db.today(); }
      if (stored) Object.assign(fields, stored);
      // Update the matching credential if there is one (same type, and same number if both have one); otherwise add it.
      const existing = db.where('qualifications', q => q.pilotId === pilot.id && q.type === c.type)
        .find(q => !q.number || !c.number || q.number.replace(/\s/g, '') === String(c.number).replace(/\s/g, ''));
      if (existing) {
        if (stored && existing.file) db.deleteFile(existing.file);
        db.update('qualifications', existing.id, fields); updated++;
      } else {
        db.insert('qualifications', { pilotId: pilot.id, type: c.type || 'other', number: '', detail: '', issuedOn: '', expiresOn: '', verified: false, file: null, note: '', ...fields });
        added++;
      }
    }
    if (entry.record && !db.all('records').some(r => r.pilotId === pilot.id && r.text === entry.record)) db.insert('records', { pilotId: pilot.id, type: 'note', date: db.today(), by: 'Kimberly Olsen', text: entry.record });
    report.push(`${pilot.fullName}: ${updated} updated, ${added} added`);
  }
  await db.flush();
  res.redirect('/pilots?msg=' + encodeURIComponent('Credentials imported – ' + report.join('; ')));
});

// ---------- Backup and restore ----------
router.get('/backup', (req, res) => {
  const counts = Object.entries(db.exportAll()).map(([c, rows]) => `${c}: ${rows.length}`).join(' · ');
  res.send(layout({ title: 'Backup', active: '/backup', flash: flashOf(req), body: `
<div class="head"><h1>Backup</h1></div>
<section class="card"><h2>Where your records are kept</h2>
<p>${db.mode() === 'mysql' ? 'In the app\u2019s MySQL database. They survive restarts and updates.' : '<b class="bad">In a local file only. They will be lost when the app restarts on GoDaddy.</b>'}</p>
<p class="sub">${esc(counts)}</p></section>
<section class="card"><h2>Download a backup</h2>
<p>A single file with every pilot, credential, record, flight, message and job. Certificate files themselves aren\u2019t included. Keep it somewhere safe; it contains pilots\u2019 personal details.</p>
<a class="btn" href="/backup/download">Download backup</a></section>
<section class="card"><h2>Restore from a backup</h2>
<p class="sub">Adds back everything in the file. Records that already exist with the same ID are replaced by the backup\u2019s version; nothing else is deleted.</p>
<form method="post" action="/backup/restore" enctype="multipart/form-data"><input type="file" name="file" accept=".json" required> <button data-confirm="Restore from this backup?">Restore</button></form></section>` }));
});
router.get('/backup/download', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="aspex-pilot-network-backup-${db.today()}.json"`);
  res.send(JSON.stringify({ app: 'aspex-pilot-network', exportedAt: db.now(), ...db.exportAll() }, null, 1));
});
router.post('/backup/restore', memUpload.single('file'), async (req, res) => {
  let saved;
  try { saved = JSON.parse(req.file.buffer.toString('utf8')); } catch { saved = null; }
  if (!saved || saved.app !== 'aspex-pilot-network') return res.redirect('/backup?msg=' + encodeURIComponent('That isn\u2019t a backup file from this app.'));
  await db.importAll(saved);
  res.redirect('/backup?msg=' + encodeURIComponent('Backup restored.'));
});

// ---------- Settings check ----------
router.get('/settings/test-email', async (req, res) => {
  try {
    const status = await mail.verify();
    await mail.send({ to: config.adminEmail, subject: 'Aspex Pilot Network – test email', text: 'If you can read this, sending from the pilot network app works.' });
    res.redirect('/?msg=' + encodeURIComponent(status + ' Test email sent to ' + config.adminEmail + '.'));
  } catch (e) {
    res.redirect('/?msg=' + encodeURIComponent('Email test failed: ' + e.message));
  }
});

module.exports = { router, publicRouter };
