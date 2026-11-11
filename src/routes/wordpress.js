// Website logins: create members-area logins on aspex.com.au for pilots.
const express = require('express');
const config = require('../config');
const db = require('../db');
const M = require('../model');
const WP = require('../wordpress');
const { esc, fmtDate, layout } = require('../views');

const router = express.Router();
const flashOf = (req) => req.query.msg ? String(req.query.msg) : '';

router.get('/settings/website', (req, res) => {
  const s = WP.getSettings();
  const wp = config.wordpress;
  const done = db.all('pilots').filter(p => p.wpLogin).length;
  res.send(layout({ title: 'Website logins', active: '/pilots', flash: flashOf(req), body: `
<div class="head"><div><a href="/pilots" class="muted">← Pilots</a><h1>Website logins</h1></div></div>
<section class="card"><h2>Connection to ${esc(wp.url)}</h2>
${wp.configured
    ? `<p>Login details found for WordPress user <b>${esc(wp.user)}</b>. ${done} pilot${done === 1 ? ' has' : 's have'} a website login made by the app.</p>
<form method="post" action="/settings/website/test"><button>Test the connection</button></form>`
    : `<div class="flash bad">Not set up yet. Found: WP_USER ${wp.found.user ? '✓' : '✗'}, WP_APP_PASSWORD ${wp.found.appPassword ? '✓' : '✗'}.</div>
<ol><li>In WordPress, go to <b>Users → Profile</b> (logged in as an Administrator) and scroll to <b>Application Passwords</b>.</li>
<li>Type a name such as <i>Pilot app</i> and click <b>Add New Application Password</b>. Copy the password it shows (it's only shown once).</li>
<li>In the pilot app's hosting <b>Secrets</b>, add <code>WP_USER</code> = your WordPress username and <code>WP_APP_PASSWORD</code> = that password, then republish.</li></ol>
<p class="sub">If there's no Application Passwords section, your host or a security plugin has turned them off.</p>`}
</section>
<form method="post" action="/settings/website" class="card">
<h2>Pilot role</h2>
<label>WordPress role given to pilots<input name="role" value="${esc(s.role)}" required></label>
<p class="sub">Use the role's internal name, as shown under <b>Users → Roles</b> (Members plugin), e.g. <code>pilot</code>. This is what gives access to the Pilot Hub and Training Hub.</p>
<h2>Email to pilots with their new login</h2>
<label>Subject<input name="subject" value="${esc(s.subject)}" required></label>
<label>Message<textarea name="body" rows="16" required>${esc(s.body)}</textarea></label>
<p class="sub">You can use <code>{first_name}</code>, <code>{name}</code> and <code>{email}</code>. Sent from the app when a login is created, and listed on the Messages page.</p>
<button>Save</button>
</form>` }));
});

router.post('/settings/website', (req, res) => {
  const b = req.body;
  WP.saveSettings({ role: String(b.role || '').trim() || 'subscriber', subject: String(b.subject || '').trim() || WP.DEFAULTS.subject, body: String(b.body || '').trim() || WP.DEFAULTS.body });
  res.redirect('/settings/website?msg=' + encodeURIComponent('Saved.'));
});

router.post('/settings/website/test', async (req, res) => {
  let msg;
  try {
    const t = await WP.test();
    msg = t.canCreate ? `Connected as ${t.name} (${t.username}). This account can create users. All good.`
      : `Connected as ${t.name}, but this account can't create users. Use an Administrator account.`;
  } catch (e) { msg = 'Connection failed: ' + e.message; }
  res.redirect('/settings/website?msg=' + encodeURIComponent(msg));
});

// Create logins for one or more pilots (from a pilot's page or the ticked pilots on the list).
router.post('/wordpress/logins', async (req, res) => {
  const ids = [].concat(req.body.ids || []).flatMap(x => String(x).split(',')).filter(Boolean);
  const back = req.body.back || (ids.length === 1 ? '/pilots/' + ids[0] : '/pilots');
  const pilots = ids.map(id => db.get('pilots', id)).filter(Boolean);
  if (!pilots.length) return res.redirect(back + '?msg=' + encodeURIComponent('No pilots selected.'));
  const s = WP.getSettings();
  const made = [], skipped = [], failed = [];
  for (const p of pilots) {
    if (!M.agreementOf(p)) { skipped.push(`${p.fullName} (no signed agreement)`); continue; }
    if (p.wpLogin) { skipped.push(`${p.fullName} (already has one)`); continue; }
    try {
      const r = await WP.createLogin(p);
      db.update('pilots', p.id, { wpLogin: { id: r.id, status: r.status, at: new Date().toISOString(), role: s.role } });
      db.insert('records', { pilotId: p.id, type: 'note', date: db.today(),
        text: r.status === 'created' ? `Website login created (role ${s.role}); login email sent.` : `Already had a website account; ${r.status === 'updated' ? 'role ' + s.role + ' added' : 'already had role ' + s.role}; login email sent.` });
      made.push(db.get('pilots', p.id));
    } catch (e) {
      failed.push(`${p.fullName}: ${e.message}`);
      if (/login|REST API|reach|role|create users/.test(e.message)) break; // same problem for everyone: stop
    }
  }
  if (made.length) require('./comms').startSend({ subject: s.subject, body: s.body, pilots: made, kind: 'login' });
  const parts = [];
  if (made.length) parts.push(`Website login made for ${made.map(p => p.fullName).join(', ')}. Login email${made.length > 1 ? 's are' : ' is'} on the way.`);
  if (skipped.length) parts.push('Skipped: ' + skipped.join('; ') + '.');
  if (failed.length) parts.push('Not done: ' + failed.join('; '));
  res.redirect(back + (back.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(parts.join(' ')));
});

// Small panel for the pilot's page.
function loginPanel(p) {
  if (p.wpLogin) return `<span class="sub">Website login made ${fmtDate(p.wpLogin.at)}</span>`;
  if (!M.agreementOf(p)) return '';
  return `<form method="post" action="/wordpress/logins" style="display:inline"><input type="hidden" name="ids" value="${p.id}"><button class="ghost">Create website login</button></form>`;
}

module.exports = { router, loginPanel };
