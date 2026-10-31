// Pilot list, pilot record, credentials, pathway records and flight hours.
const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const M = require('../model');
const V = require('../views');
const { esc, nl2br, fmtDate, fmtDateTime, layout, options, badge, expiryBadge } = V;

const router = express.Router();
// Certificates are kept in memory while uploading, then saved to the database.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(pdf|jpe?g|png|heic|webp)$/i.test(file.originalname)),
});
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp' };
const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
async function storeUpload(file) {
  if (!file) return null;
  const id = await db.saveFile(file.buffer, file.originalname, file.mimetype || mimeOf(file.originalname));
  return { file: id, fileName: file.originalname };
}

const flashOf = (req) => req.query.msg ? String(req.query.msg) : '';
const back = (res, url, msg) => res.redirect(url + (msg ? (url.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(msg) : ''));
const bool = (v) => v === 'on' || v === 'true' || v === '1';

// ---------- Filter bar (shared with messages/jobs) ----------
function filterBar(q, action, extra = '') {
  return `<form class="filters" method="get" action="${action}">
<input type="search" name="q" value="${esc(q.q)}" placeholder="Search name, email, town…">
<select name="state">${options(M.STATES, q.state, { blank: 'All states' })}</select>
<select name="part">${options([['A', 'Part A (sub-2 kg)'], ['B', 'Part B (certified)']], q.part, { blank: 'Part A or B' })}</select>
<select name="stage">${options(M.STAGES, q.stage, { blank: 'All active stages' })}</select>
<select name="qual">${options(M.QUAL_TYPES.filter(t => t.id !== 'other'), q.qual, { blank: 'Any credential' })}</select>
<select name="drone">${options(M.DRONE_OPTIONS.filter(d => d !== 'None yet'), q.drone, { blank: 'Any drone' })}</select>
<select name="travel">${options(M.TRAVEL_OPTIONS, q.travel, { blank: 'Any travel range' })}</select>
${extra}<button>Filter</button> <a href="${action}" class="muted">Clear</a>
</form>`;
}

// Green "Agreement ✓ date" when signed; red "No agreement" otherwise (they can't be given work).
const agreementBadge = (ag) => ag ? badge('Agreement ✓' + (ag.date ? ' ' + fmtDate(ag.date) : ''), 'good') : badge('No agreement', 'bad');

function pilotRowsTable(list, { selectable = true } = {}) {
  if (!list.length) return '<p class="empty">No pilots match.</p>';
  return `<div class="tablewrap"><table class="list">
<thead><tr>${selectable ? '<th><input type="checkbox" data-check-all></th>' : ''}<th>Pilot</th><th>Base</th><th>Part</th><th>Stage</th><th>Credentials</th><th>Drones</th><th>Registered</th></tr></thead>
<tbody>${list.map(p => {
    const quals = M.qualsFor(p.id).filter(q => q.type !== 'agreement');
    const ag = M.agreementOf(p);
    const qb = agreementBadge(ag) + ' ' + quals.map(q => {
      const st = M.expiryStatus(q);
      const kind = st === 'expired' ? 'bad' : st === 'soon' ? 'warn' : q.verified ? 'good' : 'plain';
      const short = { arn: 'ARN', accreditation: 'Accred.', repl: 'RePL', drone_reg: 'Drone reg', reoc: 'ReOC', insurance: 'Insurance', white_card: 'White Card', aroc: 'AROC', first_aid: 'First aid', thermography: 'Thermo', other: 'Other' }[q.type];
      return badge(short + (q.verified ? ' ✓' : ''), kind);
    }).join(' ');
    return `<tr>${selectable ? `<td><input type="checkbox" name="ids" value="${p.id}" form="bulk"></td>` : ''}
<td><a href="/pilots/${p.id}"${ag ? ' class="cleared" title="Signed agreement on file"' : ''}><b>${esc(p.fullName)}</b></a><div class="sub">${esc([p.email, p.mobile].filter(Boolean).join(' · '))}</div></td>
<td>${esc(p.homeBase)}${p.state ? ` <span class="state">${p.state}</span>` : ''}<div class="sub">${esc(p.travel)}</div></td>
<td>${p.partA ? badge('A') : ''} ${p.partB ? badge('B') : ''}</td>
<td>${badge(M.stageLabel(p.stage), 'stage-' + p.stage)}</td>
<td class="quals">${qb}</td>
<td class="sub">${esc([...(p.drones || []).filter(d => d !== 'Other'), p.dronesOther].filter(Boolean).join(', '))}</td>
<td class="sub">${fmtDate(p.registeredAt || p.createdAt)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

// ---------- List ----------
router.get('/pilots', (req, res) => {
  const q = req.query;
  const list = M.filterPilots(q);
  const qs = new URLSearchParams(Object.entries(q).filter(([k, v]) => v && k !== 'msg')).toString();
  res.send(layout({
    title: 'Pilots', active: '/pilots', flash: flashOf(req), body: `
<div class="head"><h1>Pilots <span class="count">${list.length}</span></h1>
<div class="actions"><a class="btn ghost" href="/pilots.csv${qs ? '?' + qs : ''}">Export CSV</a> <a class="btn" href="/import">Add pilot</a></div></div>
${filterBar(q, '/pilots')}
<form id="bulk" method="get" action="/messages/new" class="bulkbar">
<span data-selected-count>0 selected</span>
<button name="mode" value="message">Message selected</button>
<button formaction="/jobs/pick">Send a job to selected</button>
<span class="muted">or</span>
<a href="/messages/new?${qs}">Message everyone in this list (${list.length})</a>
</form>
${pilotRowsTable(list)}`,
  }));
});

router.get('/pilots.csv', (req, res) => {
  const list = M.filterPilots(req.query);
  const cols = ['fullName', 'email', 'mobile', 'phoneType', 'business', 'abn', 'homeBase', 'state', 'region', 'travel', 'partA', 'partB', 'stage', 'drones', 'dronesOther', 'insuranceStatus', 'coverAmount', 'whiteCard', 'registeredAt'];
  const cell = (v) => `"${String(Array.isArray(v) ? v.join('; ') : v ?? '').replace(/"/g, '""')}"`;
  const rows = [cols.join(',') + ',credentials,flightHours'].concat(list.map(p =>
    cols.map(c => cell(c === 'stage' ? M.stageLabel(p.stage) : p[c])).join(',') + ',' +
    cell(M.qualsFor(p.id).map(q => `${M.qualLabel(q.type)}${q.number ? ' ' + q.number : ''}${q.expiresOn ? ' exp ' + q.expiresOn : ''}${q.verified ? ' (verified)' : ''}`)) + ',' + M.flightHours(p.id)));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="aspex-pilots-${db.today()}.csv"`);
  res.send('﻿' + rows.join('\r\n'));
});

// ---------- Pilot record ----------
router.get('/pilots/:id', (req, res) => {
  const p = db.get('pilots', req.params.id);
  if (!p) return res.status(404).send(layout({ title: 'Not found', body: '<p>Pilot not found.</p>' }));
  const quals = M.qualsFor(p.id);
  const recs = M.recordsFor(p.id);
  const flights = M.flightsFor(p.id);
  const ready = M.readiness(p);
  const ag = M.agreementOf(p);
  const msgs = db.where('messages', m => (m.recipients || []).some(r => r.pilotId === p.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const jobs = db.where('jobResponses', r => r.pilotId === p.id).map(r => ({ r, job: db.get('jobs', r.jobId) })).filter(x => x.job);
  const today = db.today();

  const check = (items) => `<ul class="checklist">${items.map(i =>
    `<li class="${i.ok ? 'ok' : i.have ? 'part' : 'no'}"><span class="pip"></span>${esc(i.label)}${!i.ok && i.have ? ' <span class="sub">(not yet verified)</span>' : ''}</li>`).join('')}</ul>`;

  const qualRows = quals.length ? quals.map(q => `<tr>
<td><b>${esc(M.qualLabel(q.type))}</b>${q.detail ? `<div class="sub">${esc(q.detail)}</div>` : ''}${q.note ? `<div class="sub">${esc(q.note)}</div>` : ''}</td>
<td>${esc(q.number)}</td>
<td>${fmtDate(q.issuedOn)}</td>
<td>${expiryBadge(M.expiryStatus(q), q.expiresOn) || '<span class="sub">No expiry</span>'}</td>
<td>${q.verified ? badge('Verified ' + fmtDate(q.verifiedOn), 'good') : badge('Not verified', 'plain')}</td>
<td>${q.file ? `<a href="/files/${esc(q.file)}" target="_blank">${esc(q.fileName || 'View')}</a>` : ''}</td>
<td class="rowact"><details><summary>Edit</summary>
<form method="post" action="/quals/${q.id}" enctype="multipart/form-data" class="grid2 small">
<label>Number<input name="number" value="${esc(q.number)}"></label>
<label>Detail<input name="detail" value="${esc(q.detail)}"></label>
<label>${q.type === 'agreement' ? 'Date signed' : 'Issued'}<input type="date" name="issuedOn" value="${esc(q.issuedOn)}"></label>
<label>Expires<input type="date" name="expiresOn" value="${esc(q.expiresOn)}"></label>
<label>Replace file<input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.webp"></label>
<label class="inline"><input type="checkbox" name="verified"${q.verified ? ' checked' : ''}> Verified by me</label>
<label class="full">Note<input name="note" value="${esc(q.note)}"></label>
<div class="full"><button>Save</button>
${q.expiresOn ? `<button formaction="/quals/${q.id}/remind" class="ghost">Email pilot a renewal reminder</button>` : ''}
<button formaction="/quals/${q.id}/delete" class="danger" data-confirm="Delete this credential?">Delete</button></div>
</form></details></td></tr>`).join('') : '<tr><td colspan="7" class="empty">No credentials recorded yet.</td></tr>';

  const stageButtons = M.STAGES.map(s => `<button name="stage" value="${s.id}" class="${p.stage === s.id ? 'on' : ''}" title="${esc(s.hint)}">${esc(s.label)}</button>`).join('');

  res.send(layout({
    title: p.fullName, active: '/pilots', flash: flashOf(req), body: `
<div class="head"><div><a href="/pilots" class="muted">← Pilots</a><h1${ag ? ' class="cleared"' : ''}>${esc(p.fullName)}</h1>
<div>${agreementBadge(ag)}${ag && ag.version ? ' <span class="sub">' + esc(ag.version) + '</span>' : ''}</div>
<div class="sub">${esc(p.business)}${p.abn && !(p.business || '').replace(/\s/g, '').includes(p.abn.replace(/\s/g, '')) ? ' · ABN ' + esc(p.abn) : ''}</div></div>
<div class="actions"><a class="btn" href="/messages/new?ids=${p.id}">Email ${esc(M.firstName(p))}</a>
<a class="btn ghost" href="/jobs/pick?ids=${p.id}">Send a job</a> <a class="btn ghost" href="#delete">Delete…</a></div></div>

${ag ? '' : `<div class="flash bad"><b>No signed contractor agreement.</b> ${esc(M.firstName(p))} can't be given work until it's signed. When it is, add it under Credentials → “Contractor agreement (signed)” with the date signed.</div>`}
<section class="card"><h2>Pathway stage</h2>
<form method="post" action="/pilots/${p.id}/stage" class="stages">${stageButtons}</form>
<p class="sub">${esc((M.STAGES.find(s => s.id === p.stage) || {}).hint || '')}</p></section>

<div class="cols">
<section class="card"><h2>Ready for client sites (Part A)</h2>${check(ready.partA)}
${ready.partAReady ? '<p class="okline">All done – ready for client sites.</p>' : `<p class="sub"><span class="pip ok"></span>verified <span class="pip part"></span>they've told us they have it – tick “Verified by me” once you've seen the certificate <span class="pip no"></span>missing</p>`}</section>
<section class="card"><h2>ReOC track (flying under the Aspex ReOC)</h2>${check(ready.reoc)}
<p class="sub">Flight hours logged: <b>${M.flightHours(p.id)}</b></p></section>
</div>

<section class="card"><div class="head"><h2>Credentials</h2></div>
<div class="tablewrap"><table class="list"><thead><tr><th>Credential</th><th>Number</th><th>Issued</th><th>Expiry</th><th>Checked</th><th>Certificate</th><th></th></tr></thead>
<tbody>${qualRows}</tbody></table></div>
<details class="add"><summary>+ Add a credential</summary>
<form method="post" action="/pilots/${p.id}/quals" enctype="multipart/form-data" class="grid2">
<label>Type<select name="type" required>${options(M.QUAL_TYPES, '', { blank: 'Choose…' })}</select></label>
<label>Number<input name="number" placeholder="e.g. ARN, licence or policy number"></label>
<label>Detail<input name="detail" placeholder="Ratings, drone serial, insurer and cover…"></label>
<label>Certificate (PDF or photo)<input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.webp"></label>
<label>Issued (for an agreement, the date signed)<input type="date" name="issuedOn"></label>
<label>Expires<input type="date" name="expiresOn"></label>
<label class="inline"><input type="checkbox" name="verified"> Verified by me</label>
<label class="full">Note<input name="note"></label>
<div class="full"><button>Add credential</button></div></form></details></section>

<div class="cols">
<section class="card"><h2>Records &amp; history</h2>
<form method="post" action="/pilots/${p.id}/records" class="grid2">
<label>What<select name="type">${options(M.RECORD_TYPES, 'note')}</select></label>
<label>Date<input type="date" name="date" value="${today}"></label>
<label>By<input name="by" value="Kimberly Olsen"></label>
<label>Result / outcome<input name="outcome" placeholder="e.g. Competent, Passed, Signed"></label>
<label class="full">Details<textarea name="text" rows="2"></textarea></label>
<div class="full"><button>Add record</button></div></form>
<ul class="timeline">${recs.map(r => `<li><div><b>${esc(M.recordLabel(r.type))}</b> · ${fmtDate(r.date)}${r.by ? ' · ' + esc(r.by) : ''}${r.outcome ? ' · ' + badge(r.outcome, 'good') : ''}
<form method="post" action="/records/${r.id}/delete" class="inline-del"><button class="link danger" data-confirm="Delete this record?">delete</button></form></div>
${r.text ? `<div class="sub">${nl2br(r.text)}</div>` : ''}</li>`).join('') || '<li class="empty">Nothing yet.</li>'}</ul></section>

<section class="card"><h2>Flight hours</h2>
<form method="post" action="/pilots/${p.id}/flights" class="grid2">
<label>Date<input type="date" name="date" value="${today}" required></label>
<label>Minutes flown<input type="number" name="minutes" min="1" required></label>
<label>Aircraft<input name="aircraft" placeholder="e.g. Mavic 3T"></label>
<label>Site / job<input name="site"></label>
<label class="inline"><input type="checkbox" name="supervised"> Supervised</label>
<label class="full">Notes<input name="notes"></label>
<div class="full"><button>Log flight</button></div></form>
<table class="list compact"><tbody>${flights.map(f => `<tr><td>${fmtDate(f.date)}</td><td>${(f.minutes / 60).toFixed(1)} h</td><td>${esc(f.aircraft)}</td><td>${esc(f.site)}${f.supervised ? ' ' + badge('Supervised') : ''}</td>
<td><form method="post" action="/flights/${f.id}/delete"><button class="link danger" data-confirm="Delete this flight?">×</button></form></td></tr>`).join('') || '<tr><td class="empty">No flights logged.</td></tr>'}</tbody></table></section>
</div>

<section class="card"><h2>Details</h2>
<form method="post" action="/pilots/${p.id}" class="grid3">
<label>Full name<input name="fullName" value="${esc(p.fullName)}" required></label>
<label>Email<input type="email" name="email" value="${esc(p.email)}" required></label>
<label>Mobile<input name="mobile" value="${esc(p.mobile)}"></label>
<label>Main phone<select name="phoneType">${options(['iPhone', 'Android', 'Other'], p.phoneType, { blank: 'Not known' })}</select></label>
<label>Business<input name="business" value="${esc(p.business)}"></label>
<label>ABN<input name="abn" value="${esc(p.abn)}"></label>
<label>Portfolio / website<input name="portfolio" value="${esc(p.portfolio)}"></label>
<label>Home base<input name="homeBase" value="${esc(p.homeBase)}"></label>
<label>State<select name="state">${options(M.STATES, p.state, { blank: '—' })}</select></label>
<label>Region<input name="region" value="${esc(p.region)}" placeholder="e.g. North Queensland"></label>
<label>Travel<select name="travel">${options(M.TRAVEL_OPTIONS, p.travel, { blank: '—' })}</select></label>
<label class="inline"><input type="checkbox" name="partA"${p.partA ? ' checked' : ''}> Part A (sub-2 kg solar)</label>
<label class="inline"><input type="checkbox" name="partB"${p.partB ? ' checked' : ''}> Part B (certified operator)</label>
<fieldset class="full"><legend>Drones</legend>${M.DRONE_OPTIONS.map(d => `<label class="inline"><input type="checkbox" name="drones" value="${esc(d)}"${(p.drones || []).includes(d) ? ' checked' : ''}> ${esc(d)}</label>`).join('')}
<label class="inline">Other <input name="dronesOther" value="${esc(p.dronesOther)}"></label></fieldset>
<label>Insurance (as told)<input name="insuranceStatus" value="${esc(p.insuranceStatus)}"></label>
<label>Cover amount<input name="coverAmount" value="${esc(p.coverAmount)}"></label>
<label>White Card (as told)<input name="whiteCard" value="${esc(p.whiteCard)}"></label>
<label class="full">Experience<textarea name="experience" rows="3">${esc(p.experience)}</textarea></label>
<label class="full">What they want from it<textarea name="goals" rows="2">${esc(p.goals)}</textarea></label>
<label class="full">Your private notes<textarea name="notes" rows="3">${esc(p.notes)}</textarea></label>
<div class="full"><button>Save details</button> <span class="sub">Registered ${fmtDateTime(p.registeredAt || p.createdAt)} via ${esc(p.source || 'manual entry')}. Credentials claimed on form: ${esc((p.credentialsClaimed || []).join(', ') || 'none')}</span></div>
</form></section>

<div class="cols">
<section class="card"><h2>Emails sent</h2><ul class="timeline">${msgs.map(m => {
    const r = m.recipients.find(x => x.pilotId === p.id);
    return `<li><a href="/messages/${m.id}"><b>${esc(m.subject)}</b></a> · ${fmtDateTime(m.createdAt)} ${badge(r.status, r.status === 'sent' ? 'good' : r.status === 'failed' ? 'bad' : 'plain')}</li>`;
  }).join('') || '<li class="empty">None yet.</li>'}</ul></section>
<section class="card"><h2>Jobs</h2><ul class="timeline">${jobs.map(({ r, job }) =>
    `<li><a href="/jobs/${job.id}"><b>${esc(job.title)}</b></a> · ${badge(r.assigned ? 'Assigned' : { interested: 'Interested', unavailable: 'Not available', invited: 'Invited' }[r.answer] || r.answer, r.assigned ? 'good' : r.answer === 'interested' ? 'good' : r.answer === 'unavailable' ? 'plain' : 'warn')}</li>`).join('') || '<li class="empty">None yet.</li>'}</ul></section>
</div>

<section class="card danger-zone" id="delete"><h2>Delete pilot</h2>
<p class="sub">Removes ${esc(p.fullName)} and all their credentials, certificates, records and flight hours. This can't be undone. If they've just stopped working with you, set their stage to “Not proceeding” instead.</p>
<form method="post" action="/pilots/${p.id}/delete"><button class="danger" data-confirm="Delete ${esc(p.fullName)} and all their records permanently?">Delete ${esc(p.fullName)}</button></form></section>`,
  }));
});

router.post('/pilots/:id', (req, res) => {
  const b = req.body;
  const drones = [].concat(b.drones || []);
  db.update('pilots', req.params.id, {
    fullName: b.fullName, email: (b.email || '').toLowerCase().trim(), mobile: b.mobile, business: b.business, abn: b.abn,
    portfolio: b.portfolio, homeBase: b.homeBase, state: b.state, region: b.region, travel: b.travel,
    partA: bool(b.partA), partB: bool(b.partB), drones, dronesOther: b.dronesOther, phoneType: b.phoneType || '',
    insuranceStatus: b.insuranceStatus, coverAmount: b.coverAmount, whiteCard: b.whiteCard,
    experience: b.experience, goals: b.goals, notes: b.notes,
  });
  back(res, `/pilots/${req.params.id}`, 'Details saved.');
});

router.post('/pilots/:id/stage', (req, res) => {
  const p = db.get('pilots', req.params.id);
  const stage = req.body.stage;
  if (p && M.STAGES.some(s => s.id === stage) && p.stage !== stage) {
    db.update('pilots', p.id, { stage });
    db.insert('records', { pilotId: p.id, type: 'note', date: db.today(), by: 'System',
      text: `Stage changed: ${M.stageLabel(p.stage)} → ${M.stageLabel(stage)}` });
  }
  back(res, `/pilots/${req.params.id}`, 'Stage updated.');
});

router.post('/pilots/:id/delete', (req, res) => {
  const id = req.params.id;
  for (const q of M.qualsFor(id)) db.deleteFile(q.file);
  for (const c of ['qualifications', 'records', 'flightLogs', 'jobResponses']) db.removeWhere(c, r => r.pilotId === id);
  db.remove('pilots', id);
  back(res, '/pilots', 'Pilot deleted.');
});

// ---------- Credentials ----------
function qualFields(b, stored) {
  const f = {
    number: (b.number || '').trim(), detail: b.detail || '', issuedOn: b.issuedOn || '', expiresOn: b.expiresOn || '',
    note: b.note || '', verified: bool(b.verified),
  };
  if (stored) Object.assign(f, stored);
  return f;
}
// An agreement is one you've countersigned, so it counts as verified; it needs the date signed.
function agreementRules(type, f) {
  if (type !== 'agreement') return;
  f.verified = true;
  if (!f.issuedOn) f.issuedOn = db.today();
}
router.post('/pilots/:id/quals', upload.single('file'), async (req, res) => {
  const f = qualFields(req.body, await storeUpload(req.file));
  agreementRules(req.body.type, f);
  if (f.verified) f.verifiedOn = db.today();
  db.insert('qualifications', { pilotId: req.params.id, type: req.body.type || 'other', ...f });
  back(res, `/pilots/${req.params.id}`, 'Credential added.');
});
router.post('/quals/:id', upload.single('file'), async (req, res) => {
  const q = db.get('qualifications', req.params.id);
  if (!q) return res.redirect('/pilots');
  const f = qualFields(req.body, await storeUpload(req.file));
  agreementRules(q.type, f);
  if (f.verified && !q.verified) f.verifiedOn = db.today();
  if (!f.verified) f.verifiedOn = '';
  if (req.file && q.file) db.deleteFile(q.file);
  db.update('qualifications', q.id, f);
  back(res, `/pilots/${q.pilotId}`, 'Credential saved.');
});
router.post('/quals/:id/delete', (req, res) => {
  const q = db.get('qualifications', req.params.id);
  if (!q) return res.redirect('/pilots');
  db.deleteFile(q.file);
  db.remove('qualifications', q.id);
  back(res, `/pilots/${q.pilotId}`, 'Credential deleted.');
});
router.get('/files/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  const q = db.all('qualifications').find(x => x.file === name);
  const f = q && await db.readFile(name);
  if (!f) return res.status(404).send('Not found');
  res.setHeader('Content-Type', f.mime || mimeOf(q.fileName || ''));
  res.setHeader('Content-Disposition', `inline; filename="${(q.fileName || name).replace(/[^\w.\- ]/g, '')}"`);
  res.send(f.content);
});

// ---------- Records & flights ----------
router.post('/pilots/:id/records', (req, res) => {
  const b = req.body;
  db.insert('records', { pilotId: req.params.id, type: b.type || 'note', date: b.date, by: b.by, outcome: b.outcome, text: b.text });
  back(res, `/pilots/${req.params.id}`, 'Record added.');
});
router.post('/records/:id/delete', (req, res) => {
  const r = db.get('records', req.params.id);
  if (r) db.remove('records', r.id);
  back(res, r ? `/pilots/${r.pilotId}` : '/pilots', 'Record deleted.');
});
router.post('/pilots/:id/flights', (req, res) => {
  const b = req.body;
  db.insert('flightLogs', { pilotId: req.params.id, date: b.date, minutes: Number(b.minutes) || 0, aircraft: b.aircraft, site: b.site, supervised: bool(b.supervised), notes: b.notes });
  back(res, `/pilots/${req.params.id}`, 'Flight logged.');
});
router.post('/flights/:id/delete', (req, res) => {
  const f = db.get('flightLogs', req.params.id);
  if (f) db.remove('flightLogs', f.id);
  back(res, f ? `/pilots/${f.pilotId}` : '/pilots', 'Flight deleted.');
});

module.exports = { router, filterBar, pilotRowsTable };
