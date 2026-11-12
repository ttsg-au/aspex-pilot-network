// Settings → Target regions: which locations new registrations are accepted from.
const express = require('express');
const S = require('../screening');
const { esc, layout } = require('../views');

const router = express.Router();
const flashOf = (req) => req.query.msg ? String(req.query.msg) : '';

router.get('/settings/regions', (req, res) => {
  const s = S.getSettings();
  const box = (r) => `<label class="tick"><input type="checkbox" name="regions" value="${r.id}" ${s.regions.includes(r.id) ? 'checked' : ''}>
<span><b>${esc(r.label)}</b>${r.hint ? `<br><span class="sub">${esc(r.hint)}</span>` : ''}</span></label>`;
  res.send(layout({ title: 'Target regions', active: '/pilots', flash: flashOf(req), body: `
<div class="head"><div><a href="/pilots" class="muted">← Pilots</a><h1>Target regions</h1></div></div>
<form method="post" action="/settings/regions" class="card">
<label class="tick"><input type="checkbox" name="enabled" value="1" ${s.enabled ? 'checked' : ''}>
<span><b>Automatically screen new registrations by location</b><br><span class="sub">Applies to new pilots from the website form or a pasted registration email. Pilots already in the system aren't changed.</span></span></label>
<label class="tick"><input type="checkbox" name="reocAnywhere" value="1" ${s.reocAnywhere ? 'checked' : ''}>
<span><b>Accept pilots with their own ReOC from anywhere</b><br><span class="sub">They fly under their own ReOC on the Part B agreement, so location doesn't decline them. They still need to sign the sub-2 kg agreement too.</span></span></label>
<h2>Recruiting in</h2>
<p class="sub">Tick the places you're looking for pilots. A new registration from anywhere else is marked "Not proceeding" and sent the email below. If they don't give a state in their home base, they're declined without an email. Queensland and WA registrations are placed on the map to tell which part of the state they're in; if the town can't be found, the pilot is left for you to check, with a note on their record.</p>
<div class="regiongrid">${S.REGIONS.map(box).join('')}</div>
<h2>Email to pilots outside these regions</h2>
<label>Subject<input name="subject" value="${esc(s.subject)}" required></label>
<label>Message<textarea name="body" rows="14" required>${esc(s.body)}</textarea></label>
<p class="sub">You can use <code>{first_name}</code>, <code>{name}</code>, <code>{state}</code> and <code>{home_base}</code>. Sent automatically from the app, and listed on the Messages page.</p>
<button>Save</button>
</form>` }));
});

router.post('/settings/regions', (req, res) => {
  const b = req.body;
  const valid = S.REGIONS.map(r => r.id);
  S.saveSettings({
    enabled: !!b.enabled,
    reocAnywhere: !!b.reocAnywhere,
    regions: [].concat(b.regions || []).filter(r => valid.includes(r)),
    subject: String(b.subject || '').trim() || S.getSettings().subject,
    body: String(b.body || '').trim() || S.getSettings().body,
  });
  res.redirect('/settings/regions?msg=' + encodeURIComponent('Saved.'));
});

module.exports = { router };
