// Messaging (one, a filtered group, or everyone), job call-outs with response
// buttons, and credential renewal reminders.
const express = require('express');
const db = require('../db');
const config = require('../config');
const M = require('../model');
const mail = require('../mail');
const auth = require('../auth');
const { esc, nl2br, fmtDate, fmtDateTime, layout, bare, options, badge } = require('../views');
const { filterBar, pilotRowsTable } = require('./pilots');

const router = express.Router();
const flashOf = (req) => req.query.msg ? String(req.query.msg) : '';
const idsFrom = (v) => [].concat(v || []).flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean);

// ---------- Merge fields ----------
function missingItems(p) {
  return M.readiness(p).partA.filter(i => !i.have).map(i => '• ' + i.label).join('\n') || '• Nothing – you’re all set';
}
function merge(text, p) {
  return String(text)
    .replace(/\{first_name\}/g, M.firstName(p))
    .replace(/\{name\}/g, p.fullName || '')
    .replace(/\{state\}/g, p.state || '')
    .replace(/\{home_base\}/g, p.homeBase || '')
    .replace(/\{missing\}/g, missingItems(p));
}

const TEMPLATES = [
  { id: 'next_steps', label: 'Next steps (lists what each pilot is missing)', subject: 'Aspex Pilot Network – your next steps',
    body: `Hi {first_name},

Thanks again for registering with the Aspex Pilot Network. We've got your details on file.

Before you can work on any client site with us, we still need the following from you:
{missing}

Please reply to this email with copies of your certificates when you have them, and I'll update your record.

Kind regards,
Kimberly Olsen
Aspex Drone Services` },
  { id: 'update', label: 'General update', subject: 'Aspex Pilot Network – update',
    body: `Hi {first_name},



Kind regards,
Kimberly Olsen
Aspex Drone Services` },
  { id: 'welcome', label: 'Welcome / registration received', subject: 'Welcome to the Aspex Pilot Network',
    body: `Hi {first_name},

Thanks for registering your interest in the Aspex Pilot Network. We've received your details.

This isn't an employment vacancy or a promise of regular work. We'll contact you when a suitable project comes up in your area, and scope, availability and rates are agreed individually for each job.

Kind regards,
Kimberly Olsen
Aspex Drone Services` },
];

// ---------- Sending ----------
// Buttons for a job call-out email ("I'm interested" / "Not available"), unique to each pilot.
function jobButtons(jobId, p) {
  const link = (a) => `${config.baseUrl}/r/${jobId}/${p.id}/${a}/${auth.linkToken(jobId, p.id)}`;
  return [{ label: 'I\u2019m interested', url: link('interested'), primary: true }, { label: 'Not available', url: link('unavailable') }];
}

// Send (or re-send) a saved message to some of its recipients, recording each result.
function deliver(msg, pilots) {
  const buttonsFor = msg.kind === 'job' && msg.jobId ? (p) => jobButtons(msg.jobId, p) : () => [];
  const items = pilots.map(p => ({
    pilotId: p.id, to: p.email, subject: merge(msg.subject, p), text: merge(msg.body, p), buttons: buttonsFor(p),
  }));
  mail.sendBatch(items, (item, ok, err) => {
    const m = db.get('messages', msg.id);
    const r = m.recipients.find(x => x.pilotId === item.pilotId);
    if (ok) Object.assign(r, { status: 'sent', sentAt: db.now(), error: '' });
    else Object.assign(r, { status: 'failed', error: String((err && err.message) || err), failedAt: db.now() });
    db.update('messages', m.id, { recipients: m.recipients });
  });
}

function startSend({ subject, body, pilots, kind = 'message', jobId = null }) {
  const msg = db.insert('messages', {
    subject, body, kind, jobId,
    recipients: pilots.map(p => ({ pilotId: p.id, name: p.fullName, email: p.email, status: 'queued' })),
  });
  deliver(msg, pilots);
  return msg;
}

// ---------- Messages ----------
router.get('/messages', (req, res) => {
  const list = db.all('messages').slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.send(layout({ title: 'Messages', active: '/messages', flash: flashOf(req), body: `
<div class="head"><h1>Messages</h1><div class="actions"><a class="btn" href="/messages/new">New message</a></div></div>
${config.mailDryRun ? '<div class="flash warn">Test mode: emails are being saved to data/outbox, not sent. Set up Microsoft Graph sending (see README) to send for real.</div>' : ''}
<div class="tablewrap"><table class="list"><thead><tr><th>Subject</th><th>Type</th><th>To</th><th>Sent</th><th>Status</th></tr></thead><tbody>
${list.map(m => {
    const sent = m.recipients.filter(r => r.status === 'sent').length, failed = m.recipients.filter(r => r.status === 'failed').length;
    return `<tr><td><a href="/messages/${m.id}"><b>${esc(m.subject)}</b></a></td><td>${badge({ message: 'Message', job: 'Job call-out', reminder: 'Reminder' }[m.kind] || m.kind)}</td>
<td>${m.recipients.length === 1 ? esc(m.recipients[0].name) : m.recipients.length + ' pilots'}</td><td class="sub">${fmtDateTime(m.createdAt)}</td>
<td>${badge(sent + ' sent', 'good')} ${failed ? badge(failed + ' failed', 'bad') : ''} ${m.recipients.length - sent - failed ? badge((m.recipients.length - sent - failed) + ' sending', 'warn') : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">Nothing sent yet.</td></tr>'}
</tbody></table></div>` }));
});

router.get('/messages/new', (req, res) => {
  const ids = idsFrom(req.query.ids);
  const pilots = ids.length ? ids.map(id => db.get('pilots', id)).filter(Boolean) : M.filterPilots(req.query);
  const tpl = TEMPLATES.find(t => t.id === req.query.template);
  const subject = req.query.subject || (tpl ? tpl.subject : '');
  const body = req.query.body || (tpl ? tpl.body : TEMPLATES[1].body);
  const keep = new URLSearchParams(Object.entries(req.query).filter(([k, v]) => v && !['template', 'mode', 'subject', 'body'].includes(k))).toString();
  res.send(layout({ title: 'New message', active: '/messages', body: `
<div class="head"><h1>New message</h1></div>
${ids.length ? `<p class="sub">Sending to the ${pilots.length} pilot${pilots.length === 1 ? '' : 's'} you selected. <a href="/messages/new">Choose by filter instead</a></p>` :
    `<section class="card"><h2>Who to send to</h2>${filterBar(req.query, '/messages/new')}</section>`}
<form method="post" action="/messages" class="card">
<h2>Recipients <span class="count">${pilots.length}</span></h2>
<div class="recips">${pilots.map(p => `<label class="chip"><input type="checkbox" name="ids" value="${p.id}" checked> ${esc(p.fullName)} <span class="sub">${esc(p.state || p.homeBase)}</span></label>`).join('') || '<p class="empty">No pilots match.</p>'}</div>
<h2>Message</h2>
<div class="tplbar">Start from: ${TEMPLATES.map(t => `<a href="/messages/new?${keep}&template=${t.id}">${esc(t.label)}</a>`).join(' · ')}</div>
<label>Subject<input name="subject" value="${esc(subject)}" required></label>
<label>Message<textarea name="body" rows="14" required>${esc(body)}</textarea></label>
<p class="sub">Each pilot gets their own email from ${esc(config.smtp.from)}. You can use <code>{first_name}</code>, <code>{name}</code>, <code>{state}</code>, <code>{home_base}</code> and <code>{missing}</code> (the Part A items that pilot hasn't told us they have).</p>
<button data-confirm="Send this email now?">Send</button>
</form>` }));
});

router.post('/messages', (req, res) => {
  const pilots = idsFrom(req.body.ids).map(id => db.get('pilots', id)).filter(Boolean);
  if (!pilots.length) return res.redirect('/messages/new?msg=' + encodeURIComponent('No recipients selected.'));
  const msg = startSend({ subject: req.body.subject, body: req.body.body, pilots });
  res.redirect(`/messages/${msg.id}?msg=` + encodeURIComponent(`Sending to ${pilots.length} pilot${pilots.length === 1 ? '' : 's'}…`));
});

router.get('/messages/:id', (req, res) => {
  const m = db.get('messages', req.params.id);
  if (!m) return res.status(404).send(layout({ title: 'Not found', body: '<p>Message not found.</p>' }));
  const pending = m.recipients.some(r => r.status === 'queued');
  const job = m.jobId && db.get('jobs', m.jobId);
  res.send(layout({ title: m.subject, active: '/messages', flash: flashOf(req), body: `
${pending ? '<meta http-equiv="refresh" content="4">' : ''}
<div class="head"><div><a href="/messages" class="muted">← Messages</a><h1>${esc(m.subject)}</h1>
<div class="sub">${fmtDateTime(m.createdAt)}${job ? ` · Job: <a href="/jobs/${job.id}">${esc(job.title)}</a>` : ''}</div></div></div>
<div class="cols"><section class="card"><h2>Message</h2><div class="msgbody">${nl2br(m.body)}</div></section>
<section class="card"><h2>Recipients</h2><table class="list compact"><tbody>${m.recipients.map(r => `<tr><td><a href="/pilots/${r.pilotId}">${esc(r.name)}</a><div class="sub">${esc(r.email)}</div></td>
<td>${badge(r.status, r.status === 'sent' ? 'good' : r.status === 'failed' ? 'bad' : 'warn')}${r.error ? `<div class="sub bad">${esc(r.error)}</div>` : ''}</td></tr>`).join('')}</tbody></table>
${pending ? '<p class="sub">Sending… this page refreshes itself.</p>' : ''}
${!pending && m.recipients.some(r => r.status === 'failed') ? `<form method="post" action="/messages/${m.id}/resend"><button>Resend to the ${m.recipients.filter(r => r.status === 'failed').length} that failed</button></form>
<p class="sub">Sending method: ${{ graph: 'Microsoft Graph', smtp: 'SMTP (' + esc(config.smtp.host) + ':' + config.smtp.port + ')', test: 'test mode (not sent)' }[mail.method()]}. <a href="/settings/test-email">Test email settings</a></p>` : ''}</section></div>` }));
});

router.post('/messages/:id/resend', (req, res) => {
  const m = db.get('messages', req.params.id);
  if (!m) return res.redirect('/messages');
  const failed = m.recipients.filter(r => r.status === 'failed');
  const pilots = failed.map(r => db.get('pilots', r.pilotId)).filter(Boolean);
  for (const r of failed) if (pilots.some(p => p.id === r.pilotId)) Object.assign(r, { status: 'queued', error: '' });
  db.update('messages', m.id, { recipients: m.recipients });
  deliver(m, pilots);
  res.redirect(`/messages/${m.id}?msg=` + encodeURIComponent(`Resending to ${pilots.length} pilot${pilots.length === 1 ? '' : 's'}…`));
});

// ---------- Renewal reminder for one credential ----------
router.post('/quals/:id/remind', (req, res) => {
  const q = db.get('qualifications', req.params.id);
  const p = q && db.get('pilots', q.pilotId);
  if (!p) return res.redirect('/pilots');
  const st = M.expiryStatus(q);
  const when = st === 'expired' ? `expired on ${fmtDate(q.expiresOn)}` : `expires on ${fmtDate(q.expiresOn)}`;
  startSend({
    kind: 'reminder', pilots: [p], subject: `Your ${M.qualLabel(q.type)} ${st === 'expired' ? 'has expired' : 'is due for renewal'}`,
    body: `Hi {first_name},

Our records show your ${M.qualLabel(q.type)}${q.number ? ' (' + q.number + ')' : ''} ${when}.

When you've renewed it, please reply to this email with a copy of the new certificate so I can update your record. We can't send you to a client site while it's out of date.

Kind regards,
Kimberly Olsen
Aspex Drone Services`,
  });
  db.insert('records', { pilotId: p.id, type: 'note', date: db.today(), by: 'System', text: `Renewal reminder sent for ${M.qualLabel(q.type)} (${when}).` });
  res.redirect(`/pilots/${p.id}?msg=` + encodeURIComponent('Reminder sent.'));
});

// ---------- Jobs ----------
const JOB_STATUS = [['open', 'Open – finding pilots'], ['filled', 'Filled'], ['completed', 'Completed'], ['cancelled', 'Cancelled']];
const jobStatusLabel = (s) => (JOB_STATUS.find(x => x[0] === s) || [s, s])[1];

function jobSummary(j) {
  const lines = [
    ['Job', j.title], ['Client / type', j.client], ['Site', j.site], ['Location', [j.location, j.state].filter(Boolean).join(', ')],
    ['Dates', [fmtDate(j.startDate), j.endDate && j.endDate !== j.startDate ? fmtDate(j.endDate) : ''].filter(Boolean).join(' – ')],
    ['Suits', { A: 'Part A pilots (sub-2 kg)', B: 'Part B certified operators', any: 'Any pilot in the network' }[j.part]],
    ['Requirements', j.requirements], ['Rate', j.payNotes], ['Please respond by', fmtDate(j.respondBy)],
  ].filter(([, v]) => v);
  return lines.map(([k, v]) => `${k}: ${v}`).join('\n') + (j.details ? '\n\n' + j.details : '');
}

function jobForm(j = {}, ids = []) {
  return `<form method="post" action="${j.id ? '/jobs/' + j.id : '/jobs'}" class="card grid3">
${ids.map(id => `<input type="hidden" name="ids" value="${esc(id)}">`).join('')}
<label class="full">Job title<input name="title" value="${esc(j.title)}" required placeholder="e.g. Thermography – 120 MW solar farm"></label>
<label>Client / type of work<input name="client" value="${esc(j.client)}" placeholder="e.g. Solar farm thermography"></label>
<label>Site<input name="site" value="${esc(j.site)}"></label>
<label>Nearest town<input name="location" value="${esc(j.location)}"></label>
<label>State<select name="state">${options(M.STATES, j.state, { blank: '—' })}</select></label>
<label>Start date<input type="date" name="startDate" value="${esc(j.startDate)}"></label>
<label>End date<input type="date" name="endDate" value="${esc(j.endDate)}"></label>
<label>Suits<select name="part">${options([['any', 'Any pilot'], ['A', 'Part A (sub-2 kg)'], ['B', 'Part B (certified)']], j.part || 'any')}</select></label>
<label>Respond by<input type="date" name="respondBy" value="${esc(j.respondBy)}"></label>
<label>Rate / pay notes<input name="payNotes" value="${esc(j.payNotes)}" placeholder="e.g. Day rate agreed individually"></label>
<label class="full">Requirements<input name="requirements" value="${esc(j.requirements)}" placeholder="e.g. Mavic 3T, White Card, public liability insurance"></label>
<label class="full">Job details (sent to pilots)<textarea name="details" rows="6">${esc(j.details)}</textarea></label>
<label class="full">Private notes (not sent)<textarea name="privateNotes" rows="2">${esc(j.privateNotes)}</textarea></label>
<div class="full"><button>${j.id ? 'Save job' : 'Create job'}</button></div></form>`;
}
const jobFields = (b) => ({
  title: b.title, client: b.client, site: b.site, location: b.location, state: b.state, startDate: b.startDate,
  endDate: b.endDate, part: b.part, respondBy: b.respondBy, payNotes: b.payNotes, requirements: b.requirements,
  details: b.details, privateNotes: b.privateNotes,
});

router.get('/jobs', (req, res) => {
  const list = db.all('jobs').slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.send(layout({ title: 'Jobs', active: '/jobs', flash: flashOf(req), body: `
<div class="head"><h1>Jobs</h1><div class="actions"><a class="btn" href="/jobs/new">New job</a></div></div>
<div class="tablewrap"><table class="list"><thead><tr><th>Job</th><th>Where</th><th>Dates</th><th>Status</th><th>Responses</th></tr></thead><tbody>
${list.map(j => {
    const rs = db.where('jobResponses', r => r.jobId === j.id);
    const n = (a) => rs.filter(r => r.answer === a).length;
    return `<tr><td><a href="/jobs/${j.id}"><b>${esc(j.title)}</b></a><div class="sub">${esc(j.client)}</div></td>
<td>${esc([j.location, j.state].filter(Boolean).join(', '))}</td><td class="sub">${fmtDate(j.startDate)}</td>
<td>${badge(jobStatusLabel(j.status), j.status === 'open' ? 'warn' : j.status === 'cancelled' ? 'plain' : 'good')}</td>
<td>${rs.length} invited · ${badge(n('interested') + ' interested', 'good')} ${n('unavailable') ? badge(n('unavailable') + ' not available', 'plain') : ''} ${rs.some(r => r.assigned) ? badge(rs.filter(r => r.assigned).length + ' assigned', 'good') : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">No jobs yet.</td></tr>'}
</tbody></table></div>` }));
});

router.get('/jobs/new', (req, res) => {
  res.send(layout({ title: 'New job', active: '/jobs', body: `<div class="head"><h1>New job</h1></div>${jobForm({}, idsFrom(req.query.ids))}` }));
});

// From the pilot list: choose an open job (or make a new one) for the selected pilots.
router.get('/jobs/pick', (req, res) => {
  const ids = idsFrom(req.query.ids);
  const open = db.where('jobs', j => j.status === 'open');
  res.send(layout({ title: 'Choose a job', active: '/jobs', body: `
<div class="head"><h1>Send a job to ${ids.length} pilot${ids.length === 1 ? '' : 's'}</h1></div>
${open.length ? `<section class="card"><h2>Send an existing open job</h2><ul class="timeline">${open.map(j =>
    `<li><a href="/jobs/${j.id}?${ids.map(i => 'ids=' + i).join('&')}#invite"><b>${esc(j.title)}</b></a> · ${esc([j.location, j.state].filter(Boolean).join(', '))} · ${fmtDate(j.startDate)}</li>`).join('')}</ul></section>` : ''}
<h2>Or create a new job</h2>${jobForm({}, ids)}` }));
});

router.post('/jobs', (req, res) => {
  const j = db.insert('jobs', { ...jobFields(req.body), status: 'open' });
  const ids = idsFrom(req.body.ids);
  res.redirect(`/jobs/${j.id}?${ids.map(i => 'ids=' + i).join('&')}&msg=${encodeURIComponent('Job created. Now choose who to send it to.')}#invite`);
});

router.post('/jobs/:id', (req, res) => {
  db.update('jobs', req.params.id, jobFields(req.body));
  res.redirect(`/jobs/${req.params.id}?msg=` + encodeURIComponent('Job saved.'));
});

router.post('/jobs/:id/status', (req, res) => {
  const j = db.get('jobs', req.params.id);
  if (!j) return res.redirect('/jobs');
  const status = req.body.status;
  const wasCompleted = j.status === 'completed';
  db.update('jobs', j.id, { status });
  if (status === 'completed' && !wasCompleted) {
    for (const r of db.where('jobResponses', x => x.jobId === j.id && x.assigned)) {
      const p = db.get('pilots', r.pilotId);
      if (!p) continue;
      db.insert('records', { pilotId: p.id, type: p.stage === 'supervised' ? 'supervised_job' : 'note', date: j.endDate || j.startDate || db.today(),
        by: 'System', text: `Completed job: ${j.title}${j.site ? ' (' + j.site + ')' : ''}` });
    }
  }
  res.redirect(`/jobs/${j.id}?msg=` + encodeURIComponent('Status: ' + jobStatusLabel(status)));
});

router.post('/jobs/:id/assign', (req, res) => {
  const r = db.all('jobResponses').find(x => x.jobId === req.params.id && x.pilotId === req.body.pilotId);
  if (r) db.update('jobResponses', r.id, { assigned: !r.assigned });
  res.redirect(`/jobs/${req.params.id}`);
});

router.post('/jobs/:id/delete', (req, res) => {
  db.removeWhere('jobResponses', r => r.jobId === req.params.id);
  db.remove('jobs', req.params.id);
  res.redirect('/jobs?msg=' + encodeURIComponent('Job deleted.'));
});

router.get('/jobs/:id', (req, res) => {
  const j = db.get('jobs', req.params.id);
  if (!j) return res.status(404).send(layout({ title: 'Not found', body: '<p>Job not found.</p>' }));
  const rs = db.where('jobResponses', r => r.jobId === j.id);
  const preIds = idsFrom(req.query.ids);
  // Candidate list: pre-selected pilots, or filtered list (defaults to the job's state and Part).
  const fq = { ...req.query };
  if (!preIds.length && !('state' in req.query) && j.state) fq.state = j.state;
  if (!preIds.length && !('part' in req.query) && j.part !== 'any') fq.part = j.part;
  const candidates = preIds.length ? preIds.map(id => db.get('pilots', id)).filter(Boolean) : M.filterPilots(fq);
  const invited = new Set(rs.map(r => r.pilotId));
  const assignedIds = rs.filter(r => r.assigned).map(r => r.pilotId);
  const ansLabel = { invited: 'No reply yet', interested: 'Interested', unavailable: 'Not available' };

  res.send(layout({ title: j.title, active: '/jobs', flash: flashOf(req), body: `
<div class="head"><div><a href="/jobs" class="muted">← Jobs</a><h1>${esc(j.title)}</h1>
<div class="sub">${badge(jobStatusLabel(j.status), j.status === 'open' ? 'warn' : 'good')} ${esc([j.location, j.state].filter(Boolean).join(', '))} · ${fmtDate(j.startDate)}</div></div>
<form method="post" action="/jobs/${j.id}/status" class="stages">${JOB_STATUS.map(([v, l]) => `<button name="status" value="${v}" class="${j.status === v ? 'on' : ''}">${l}</button>`).join('')}</form></div>

<section class="card"><h2>Responses</h2>
<div class="tablewrap"><table class="list"><thead><tr><th>Pilot</th><th>Base</th><th>Reply</th><th>Note</th><th>Assigned</th></tr></thead><tbody>
${rs.map(r => { const p = db.get('pilots', r.pilotId) || { fullName: '(deleted)' }; return `<tr><td><a href="/pilots/${r.pilotId}">${esc(p.fullName)}</a></td><td>${esc(p.homeBase)}</td>
<td>${badge(ansLabel[r.answer] || r.answer, r.answer === 'interested' ? 'good' : r.answer === 'unavailable' ? 'plain' : 'warn')}<div class="sub">${r.answeredAt ? fmtDateTime(r.answeredAt) : 'Invited ' + fmtDateTime(r.invitedAt)}</div></td>
<td>${nl2br(r.note || '')}</td>
<td><form method="post" action="/jobs/${j.id}/assign"><input type="hidden" name="pilotId" value="${r.pilotId}"><button class="${r.assigned ? '' : 'ghost'} small">${r.assigned ? '✓ Assigned' : 'Assign'}</button></form></td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">Not sent to anyone yet.</td></tr>'}
</tbody></table></div>
${assignedIds.length ? `<p><a class="btn ghost" href="/messages/new?ids=${assignedIds.join(',')}&subject=${encodeURIComponent('Re: ' + j.title)}">Email the assigned pilot${assignedIds.length > 1 ? 's' : ''}</a></p>` : ''}
${rs.length ? `<p><a class="btn ghost" href="/messages/new?ids=${rs.map(r => r.pilotId).join(',')}&subject=${encodeURIComponent('Update: ' + j.title)}">Email everyone invited</a></p>` : ''}
</section>

<section class="card" id="invite"><h2>Send this job to pilots</h2>
${preIds.length ? '' : filterBar(fq, `/jobs/${j.id}`) }
<form method="post" action="/jobs/${j.id}/send">
<div class="recips">${candidates.map(p => `<label class="chip"><input type="checkbox" name="ids" value="${p.id}"${preIds.length || !invited.has(p.id) ? ' checked' : ''}> ${esc(p.fullName)} <span class="sub">${esc(p.state || p.homeBase)}${invited.has(p.id) ? ' · already sent' : ''}</span></label>`).join('') || '<p class="empty">No pilots match these filters.</p>'}</div>
<label>Subject<input name="subject" value="${esc('Job available: ' + j.title)}"></label>
<label>Message (the job details are added below it, then “I'm interested” and “Not available” buttons)<textarea name="intro" rows="5">Hi {first_name},

We have a job coming up that may suit you. Details are below – please let me know if you're interested and available.</textarea></label>
<details><summary>Preview the job details that will be included</summary><div class="msgbody">${nl2br(jobSummary(j))}</div></details>
<button data-confirm="Send this job now?">Send job</button>
</form></section>

<details class="card"><summary><b>Edit job</b></summary>${jobForm(j)}
<form method="post" action="/jobs/${j.id}/delete"><button class="link danger" data-confirm="Delete this job and its responses?">Delete job</button></form></details>` }));
});

router.post('/jobs/:id/send', (req, res) => {
  const j = db.get('jobs', req.params.id);
  if (!j) return res.redirect('/jobs');
  const pilots = idsFrom(req.body.ids).map(id => db.get('pilots', id)).filter(Boolean);
  if (!pilots.length) return res.redirect(`/jobs/${j.id}?msg=` + encodeURIComponent('No pilots selected.') + '#invite');
  for (const p of pilots) {
    const existing = db.all('jobResponses').find(r => r.jobId === j.id && r.pilotId === p.id);
    if (!existing) db.insert('jobResponses', { jobId: j.id, pilotId: p.id, answer: 'invited', invitedAt: db.now(), assigned: false, note: '' });
  }
  const body = (req.body.intro || '') + '\n\n' + jobSummary(j) + '\n\nKind regards,\nKimberly Olsen\nAspex Drone Services';
  startSend({ kind: 'job', jobId: j.id, pilots, subject: req.body.subject || 'Job available: ' + j.title, body });
  res.redirect(`/jobs/${j.id}?msg=` + encodeURIComponent(`Job sent to ${pilots.length} pilot${pilots.length === 1 ? '' : 's'}.`));
});

// ---------- Public: pilot responds to a job from the email ----------
// The email link opens a confirm page (a GET never records anything, because
// Outlook's link scanners open links automatically).
const publicRouter = express.Router();
function responseContext(req) {
  const { jobId, pilotId, answer, token } = req.params;
  if (!['interested', 'unavailable'].includes(answer) || !auth.checkLinkToken(token, jobId, pilotId)) return null;
  const job = db.get('jobs', jobId), pilot = db.get('pilots', pilotId);
  const resp = db.all('jobResponses').find(r => r.jobId === jobId && r.pilotId === pilotId);
  if (!job || !pilot) return null;
  return { job, pilot, resp, answer };
}
publicRouter.get('/r/:jobId/:pilotId/:answer/:token', (req, res) => {
  const c = responseContext(req);
  if (!c) return res.status(404).send(bare({ title: 'Link not valid', body: '<h1>This link isn’t valid</h1><p>Please reply to the email instead.</p>' }));
  const yes = c.answer === 'interested';
  res.send(bare({ title: c.job.title, body: `
<p class="brandline"><span class="dot"></span>Aspex Drone Services</p>
<h1>${esc(c.job.title)}</h1>
<div class="msgbody">${nl2br(jobSummary(c.job))}</div>
${c.job.status !== 'open' ? '<p class="flash warn">This job is no longer open, but you can still send a note.</p>' : ''}
<form method="post">
<p>Hi ${esc(M.firstName(c.pilot))}, you're telling us you're <b>${yes ? 'interested and available' : 'not available'}</b> for this job.</p>
<label>Anything to add? (optional)<textarea name="note" rows="3" placeholder="${yes ? 'e.g. available from the 12th, can bring my own Mavic 3T' : ''}">${esc(c.resp && c.resp.note)}</textarea></label>
<button>${yes ? 'Confirm – I’m interested' : 'Confirm – not available'}</button>
</form>
<p class="sub">Changed your mind? <a href="${config.baseUrl}/r/${c.job.id}/${c.pilot.id}/${yes ? 'unavailable' : 'interested'}/${req.params.token}">${yes ? 'I’m not available' : 'I’m interested after all'}</a></p>` }));
});
publicRouter.post('/r/:jobId/:pilotId/:answer/:token', (req, res) => {
  const c = responseContext(req);
  if (!c) return res.status(404).send(bare({ title: 'Link not valid', body: '<h1>This link isn’t valid</h1>' }));
  const fields = { answer: c.answer, answeredAt: db.now(), note: String((req.body && req.body.note) || '').slice(0, 2000) };
  if (c.resp) db.update('jobResponses', c.resp.id, fields);
  else db.insert('jobResponses', { jobId: c.job.id, pilotId: c.pilot.id, invitedAt: db.now(), assigned: false, ...fields });
  // Let you know straight away.
  mail.send({
    to: config.adminEmail,
    subject: `${c.pilot.fullName} is ${c.answer === 'interested' ? 'INTERESTED in' : 'not available for'}: ${c.job.title}`,
    text: `${c.pilot.fullName} (${c.pilot.homeBase || c.pilot.state || ''}) replied: ${c.answer === 'interested' ? 'interested and available' : 'not available'}.${fields.note ? '\n\nTheir note:\n' + fields.note : ''}`,
    buttons: [{ label: 'Open the job', url: `${config.baseUrl}/jobs/${c.job.id}`, primary: true }],
  }).catch(e => console.error('Admin notify failed:', e.message));
  res.send(bare({ title: 'Thanks', body: `<p class="brandline"><span class="dot"></span>Aspex Drone Services</p><h1>Thanks, ${esc(M.firstName(c.pilot))}</h1>
<p>${c.answer === 'interested' ? 'We’ve noted that you’re interested. We’ll be in touch to confirm details.' : 'We’ve noted that you’re not available for this one. We’ll keep you in mind for the next job.'}</p>` }));
});

module.exports = { router, publicRouter, TEMPLATES, startSend };
