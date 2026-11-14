// Approvals register: CASA approvals, airport authorisations and landowner permissions, with the
// document attached, and the jobs each one covers. Every pilot keeps their own; Aspex's approvals
// linked to an Aspex job are shown to the pilots assigned to it, and a pilot's own approval can be
// linked to an Aspex job so Aspex can see it.
// Shares globals with the main page script ($, esc, toast, dateOnly, ops, saveOps, sel, newId...).

const AP_TYPES = [
  'Controlled airport - automated authorisation', 'Controlled airport - manual authorisation',
  'Other airport / helipad operator', 'Restricted area permission', 'CASA instrument or approval (outside standard conditions)',
  'BVLOS approval', 'EVLOS approval', 'Landowner / site permission', 'National park or council permit', 'Other',
];
let curAp = null;
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const apKeys = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const apDays = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(todayIso() + 'T00:00:00Z')) / 864e5);
// [label, pill class, sort group]
function apStatus(a) {
  if (a.validFrom && a.validFrom > todayIso()) return [`Starts ${dateOnly(a.validFrom)}`, '', 1];
  if (!a.validTo) return ['No end date', '', 0];
  const d = apDays(a.validTo);
  if (d < 0) return ['Expired', 'bad', 2];
  if (d <= 30) return [d === 0 ? 'Expires today' : `Expires in ${d} day${d === 1 ? '' : 's'}`, 'warn', 0];
  return ['Current', 'ok', 0];
}
const apName = a => a.title || a.type || 'Untitled approval';
const apCovers = (a, j) => { const from = j.start || '', to = j.end || j.start || '';
  return (!a.validFrom || !from || a.validFrom <= from) && (!a.validTo || !to || a.validTo >= to); };
const apFor = jobKey => Object.entries(ops.approvals || {}).filter(([, a]) => apKeys(a.jobs).includes(jobKey));
const apPill = a => { const [t, c] = apStatus(a); return `<span class="pill ${c}">${esc(t)}</span>`; };
const apDates = a => a.validFrom || a.validTo ? `${a.validFrom ? dateOnly(a.validFrom) : '…'} – ${a.validTo ? dateOnly(a.validTo) : 'no end date'}` : 'no dates';

// Does this approval look wrong for a job's site? (the site's airspace check says it isn't needed there)
function apMismatch(a, siteId) {
  const s = ops.sites?.[siteId], v = s?.boundary && s.airspace ? airspaceVerdict(s) : null, t = a.type || '';
  if (!v) return '';
  if (/controlled airport|airport \/ helipad/i.test(t) && !v.need.controlled)
    return `${s.name || 'This site'} isn't in controlled airspace or within 3 NM of a controlled aerodrome (by the site's airspace check). Check this is the right approval for it.`;
  if (/restricted area/i.test(t) && !v.need.restricted) return `${s.name || 'This site'} isn't inside a restricted area (by the site's airspace check). Check this is the right approval for it.`;
  return '';
}
const mismatchPill = (msg) => msg ? ` <span class="pill warn" title="${esc(msg)}" style="white-space:normal">⚠ ${esc(msg)}</span>` : '';

function renderApprovals() {
  const v = $('#v-approvals'); if (!v) return;
  if (!v.querySelector('#apList')) v.innerHTML = `<div class="split">
    <div class="panel"><h2>Approvals <button class="btn sm" id="newAp">+ New approval</button></h2><div id="apList" class="list"></div>
      <p class="muted" style="padding:8px 14px;font-size:12.5px">Keep each approval or permission here with its document, so it's on hand on site and you're reminded before it expires.</p></div>
    <div class="panel" id="apEdit"></div></div>`;
  $('#newAp').onclick = () => newApproval({});
  const list = Object.entries(ops.approvals || {});
  const groups = [['Current', 0], ['Not started yet', 1], ['Expired', 2]];
  const item = ([id, a]) => `<div class="it ${id === curAp ? 'on' : ''}" data-id="${id}"><b>${esc(apName(a))}</b> ${apPill(a)}${a.type ? '' : ' <span class="pill warn">type not set</span>'}
    <div class="s">${a.ref ? esc(a.ref) + ' · ' : ''}${esc(apDates(a))}${a.docFile ? ' · 📄' : ''}</div></div>`;
  const head = t => `<div style="padding:8px 12px 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b7a86;background:#f6f8f9">${t}</div>`;
  $('#apList').innerHTML = list.length ? groups.map(([t, g]) => {
    const rows = list.filter(([, a]) => apStatus(a)[2] === g).sort((x, y) => (g === 2 ? (y[1].validTo || '').localeCompare(x[1].validTo || '') : (x[1].validTo || '9999').localeCompare(y[1].validTo || '9999')));
    return rows.length ? head(`${t} (${rows.length})`) + rows.map(item).join('') : '';
  }).join('') : '<div class="empty">No approvals yet</div>';
  $('#apList').querySelectorAll('.it').forEach(el => el.onclick = () => { curAp = el.dataset.id; renderApprovals(); });
  renderApEdit();
}

async function newApproval(init) {
  const id = newId(init.title || 'approval');
  if (await saveOps({ approvals: { [id]: { type: '', ...init } } }, 'Approval added')) {
    curAp = id; showView('approvals');
  }
}

function renderApEdit() {
  const el = $('#apEdit'), a = ops.approvals?.[curAp];
  if (!a) { el.innerHTML = '<div class="empty">Pick an approval on the left, or add a new one.</div>'; return; }
  const sites = Object.entries(ops.sites).map(([id, s]) => [id, s.name || 'Untitled site']).sort((x, y) => x[1].localeCompare(y[1]));
  const mine = apKeys(a.jobs), theirs = apKeys(a.aspexJobs);
  const jobs = Object.entries(ops.jobs).sort((x, y) => (y[1].start || '').localeCompare(x[1].start || ''));
  const jobRow = ([id, j], on, attr, warn) => `<label class="aprow"><input type="checkbox" ${attr}="${id}"${on ? ' checked' : ''}>
    <span><b>${esc(j.name || 'Untitled job')}</b> <span class="muted">${j.start ? esc(dateOnly(j.start)) + (j.end && j.end !== j.start ? ' – ' + esc(dateOnly(j.end)) : '') : 'no dates'}</span>
    ${on && !apCovers(a, j) ? ' <span class="pill bad">job dates fall outside this approval</span>' : ''}${on && j.siteId ? mismatchPill(apMismatch(a, j.siteId)) : ''}${warn || ''}</span></label>`;
  const openJobs = jobs.filter(([id, j]) => mine.includes(id) || !(j.end || j.start) || (j.end || j.start) >= todayIso() || j.approvalRequired === '1');
  el.innerHTML = `
    <h2>${esc(apName(a))} ${apPill(a)} <button class="btn sm danger" id="delAp">Delete</button></h2>
    <div class="form">
      <label class="full">Type<select data-a="type"${a.type ? '' : ' style="border-color:#c0392b"'}>${sel(AP_TYPES.map(x => [x, x]), a.type || '', '— choose the type of approval —')}</select></label>
      <label class="full">Name (how you'll recognise it)<input data-a="title" value="${esc(a.title)}" placeholder="e.g. Toowoomba Wellcamp airport authorisation - Walla Walla"></label>
      <label>Issued by<input data-a="authority" value="${esc(a.authority)}" placeholder="e.g. CASA, Airservices, airport, landowner"></label>
      <label>Reference number<input data-a="ref" value="${esc(a.ref)}" placeholder="e.g. CASA.RPA.1234"></label>
      <label>Valid from<input type="date" data-a="validFrom" value="${esc(a.validFrom)}"></label>
      <label>Valid to<input type="date" data-a="validTo" value="${esc(a.validTo)}"></label>
      <label>Site<select data-a="siteId">${sel(sites, a.siteId, '— not for one site —')}</select></label>
      ${a.siteId && apMismatch(a, a.siteId) ? `<div class="full warnbox" style="margin:0">⚠ ${esc(apMismatch(a, a.siteId))}</div>` : ''}
      <label>Maximum height (ft AGL)<input data-a="heightFt" value="${esc(a.heightFt)}" placeholder="e.g. 200"></label>
      <label class="full">Area covered<input data-a="area" value="${esc(a.area)}" placeholder="e.g. within 3 NM of the aerodrome, inside the site boundary only"></label>
      <label class="full">Conditions (what you must do - shown with the job)<textarea data-a="conditions" rows="4" placeholder="e.g. Notify the tower 15 min before and after; stay below 200 ft; observer required">${esc(a.conditions)}</textarea></label>
      <label class="full">Private notes<textarea data-a="notes" rows="2">${esc(a.notes)}</textarea></label>
    </div>
    <div class="sub2"><h4>Document</h4>
      ${a.docFile ? `<p><a class="btn sm" href="api/approvals/${encodeURIComponent(curAp)}/doc" target="_blank" rel="noopener">Open ${esc(a.docName || 'document')}</a>
        <button class="btn sm ghost" id="apDocDel">Remove</button></p>` : '<p class="muted">No document attached yet.</p>'}
      <label class="btn sm ghost" style="cursor:pointer">${a.docFile ? 'Replace' : 'Attach the approval'} (PDF or photo)<input type="file" id="apDoc" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/*" hidden></label>
    </div>
    <div class="sub2"><h4>Jobs this approval covers</h4>
      ${openJobs.map(x => jobRow(x, mine.includes(x[0]), 'data-job')).join('') || '<p class="muted">No current or upcoming jobs.</p>'}
      ${myRole === 'owner' ? '<p class="muted" style="font-size:12.5px">When one of these jobs is shared with network pilots, the pilots assigned to it see this approval: its name, reference, dates, area, height, conditions and the document. Private notes stay private.</p>' : ''}
      ${aspexJobs.length ? `<h4 style="margin-top:12px">Aspex jobs</h4>
        ${aspexJobs.map(j => jobRow([j.key, j], theirs.includes(j.key), 'data-ajob', j.approvalRequired ? ' <span class="pill warn">approval needed</span>' : '')).join('')}
        <p class="muted" style="font-size:12.5px">Linking it to an Aspex job lets Aspex see this approval (not your private notes) and its document.</p>` : ''}
    </div>`;

  el.querySelectorAll('[data-a]').forEach(x => x.onchange = async () => {
    await saveOps({ approvals: { [curAp]: { [x.dataset.a]: x.value.trim() } } });
    renderApprovals();
  });
  const saveLinks = async (attr, field) => {
    const v = [...el.querySelectorAll(`[${attr}]:checked`)].map(c => c.getAttribute(attr));
    const keep = apKeys(a[field]).filter(k => !el.querySelector(`[${attr}="${k}"]`));    // links to jobs not listed here (e.g. past)
    await saveOps({ approvals: { [curAp]: { [field]: [...keep, ...v].join(',') } } });
    if (field === 'aspexJobs') await loadAspexJobs();
    renderApprovals();
  };
  el.querySelectorAll('[data-job]').forEach(c => c.onchange = () => saveLinks('data-job', 'jobs'));
  el.querySelectorAll('[data-ajob]').forEach(c => c.onchange = () => saveLinks('data-ajob', 'aspexJobs'));
  $('#delAp').onclick = async () => {
    if (!confirm(`Delete "${apName(a)}" and its document?`)) return;
    await saveOps({ approvals: { [curAp]: null } }, 'Approval deleted'); curAp = null; renderApprovals();
  };
  $('#apDoc').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 15e6) return toast('That file is over 15 MB - try a smaller PDF or photo.', 3000);
    toast('Uploading…', 10000);
    const r = await fetch(`api/approvals/${encodeURIComponent(curAp)}/doc?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
    if (!r.ok) return toast(await r.text(), 3000);
    setOps(await r.json()); toast('Document attached'); renderApprovals();
  };
  $('#apDocDel')?.addEventListener('click', async () => {
    if (!confirm('Remove the attached document?')) return;
    const r = await fetch(`api/approvals/${encodeURIComponent(curAp)}/doc`, { method: 'DELETE' });
    if (r.ok) { setOps(await r.json()); toast('Removed'); renderApprovals(); }
  });
}

// ---------- the Approvals section inside a job (your own jobs) ----------
function jobApprovalsSection(j, key) {
  const linked = apFor(key);
  const other = Object.entries(ops.approvals || {}).filter(([id, a]) => !apKeys(a.jobs).includes(key) && apStatus(a)[2] !== 2);
  return `<h4>Approvals</h4>
    <label class="aprow"><input type="checkbox" id="apReq"${j.approvalRequired === '1' ? ' checked' : ''}>
      <span>This job needs an approval or permission <span class="muted">(e.g. near a controlled airport, above 400 ft, restricted area, BVLOS, landowner permission)</span></span></label>
    ${j.approvalRequired === '1' ? `<div class="form" style="padding:6px 0"><label class="full">What's needed<input data-f="approvalNote" value="${esc(j.approvalNote)}" placeholder="e.g. Wellcamp airport authorisation, flying within 3 NM"></label></div>` : ''}
    ${jobAirspaceHint(j)}
    <div id="apWarn"></div>
    <table class="sum">${linked.map(([id, a]) => `<tr><td><a href="#" data-open-ap="${id}">${esc(apName(a))}</a>${a.ref ? ` <span class="muted">${esc(a.ref)}</span>` : ''}</td>
      <td>${esc(apDates(a))}</td><td>${apPill(a)}${!apCovers(a, j) ? ' <span class="pill bad">doesn’t cover the job dates</span>' : ''}${j.siteId ? mismatchPill(apMismatch(a, j.siteId)) : ''}</td>
      <td>${a.docFile ? `<a href="api/approvals/${encodeURIComponent(id)}/doc" target="_blank" rel="noopener">📄 Document</a>` : '<span class="muted">no document</span>'}</td></tr>`).join('')
      || '<tr><td class="muted">No approvals linked to this job.</td></tr>'}</table>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <button class="btn sm" id="apNewForJob">+ New approval for this job</button>
      ${other.length ? `<select id="apLink" style="font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px"><option value="">Link an existing approval…</option>${other.map(([id, a]) => `<option value="${id}">${esc(apName(a))} (${esc(apDates(a))})</option>`).join('')}</select>` : ''}
    </div>`;
}
// What the site's airspace check says, inside the job (with a one-click "needs an approval").
function jobAirspaceHint(j) {
  const s = ops.sites[j.siteId];
  if (!s) return '<p class="muted" style="font-size:12.5px">Choose a site with a boundary to check its airspace.</p>';
  if (!s.boundary || !s.airspace) return `<p class="muted" style="font-size:12.5px">The site's airspace hasn't been checked yet: open the site on the <a href="#" data-goto-site="${esc(j.siteId)}">Sites tab</a> and click <b>Check airspace</b>.</p>`;
  const v = airspaceVerdict(s);
  return `<div style="font-size:12.5px;color:var(--muted);margin-top:6px">Site airspace check:</div>${verdictBox(v, true)}
    ${(v.level === 'hi' || v.level === 'md') && j.approvalRequired !== '1' ? '<button class="btn sm" id="apReqYes" style="margin-bottom:8px">Mark this job as needing an approval</button>' : ''}`;
}
// Warning when a job needs an approval and none covering its dates is linked. pilotCovering = approvals network pilots hold for it.
function updateApWarn(j, key, pilotCovering = 0) {
  const el = $('#apWarn'); if (!el) return;
  if (j.approvalRequired !== '1') { el.innerHTML = ''; return; }
  const own = apFor(key).filter(([, a]) => apCovers(a, j)).length;
  el.innerHTML = own || pilotCovering ? `<p class="pill ok" style="margin:4px 0 8px">✓ ${own ? 'An approval covering the job dates is linked' : 'A network pilot has linked an approval covering the job dates'}</p>`
    : `<p class="pill bad" style="margin:4px 0 8px;white-space:normal">⚠ This job needs an approval, and none covering ${j.start ? 'its dates' : 'it'} is linked yet${j.networkJobId ? ' (by you or a pilot on the job)' : ''}.</p>`;
}
function bindJobApprovals(root, j, key) {
  $('#apReqYes')?.addEventListener('click', async () => { await saveOps({ jobs: { [key]: { approvalRequired: '1' } } }); renderJobEdit(); });
  root.querySelectorAll('[data-goto-site]').forEach(x => x.onclick = e => { e.preventDefault(); curSite = x.dataset.gotoSite; showView('sites'); });
  $('#apReq')?.addEventListener('change', async e => { await saveOps({ jobs: { [key]: { approvalRequired: e.target.checked ? '1' : '' } } }); renderJobEdit(); });
  root.querySelectorAll('[data-open-ap]').forEach(x => x.onclick = e => { e.preventDefault(); curAp = x.dataset.openAp; showView('approvals'); });
  $('#apNewForJob')?.addEventListener('click', () => { const jj = ops.jobs[key] || j;
    newApproval({ title: jj.approvalNote || '', jobs: key, siteId: jj.siteId || '', validFrom: jj.start || '', validTo: jj.end || jj.start || '' }); });
  $('#apLink')?.addEventListener('change', async e => {
    const id = e.target.value; if (!id) return;
    await saveOps({ approvals: { [id]: { jobs: [...apKeys(ops.approvals[id].jobs), key].join(',') } } }, 'Approval linked'); renderJobEdit();
  });
  updateApWarn(j, key);
}

// ---------- on an Aspex job (pilot view) ----------
function aspexApprovalsView(j) {
  const list = j.approvals || [];
  const v = j.site?.boundary && j.site?.airspace ? airspaceVerdict(j.site) : null;
  if (!j.approvalRequired && !list.length && !(v && v.level !== 'ok')) return '';
  const covered = list.some(a => a.covers);
  return `<div class="apbox"><b>Approvals</b>${v ? `<div style="font-size:12.5px;color:var(--muted);margin-top:6px">Site airspace check:</div>${verdictBox(v, true)}` : ''}
    ${j.approvalRequired ? `<div style="margin:4px 0">This job needs an approval or permission${j.approvalNote ? `: <b>${esc(j.approvalNote)}</b>` : ''}.
      ${covered ? '<span class="pill ok">✓ covered</span>' : '<span class="pill bad">none covering the job dates yet</span>'}</div>` : ''}
    <table class="sum">${list.map(a => `<tr><td><b>${esc(a.title || a.type)}</b>${a.ref ? ` <span class="muted">${esc(a.ref)}</span>` : ''}<div class="muted" style="font-size:12px">${a.from === 'Aspex' ? 'Held by Aspex' : 'Yours'}${a.authority ? ' · issued by ' + esc(a.authority) : ''}${a.heightFt ? ` · max ${esc(a.heightFt)} ft` : ''}${a.area ? ' · ' + esc(a.area) : ''}</div>
      ${a.conditions ? `<div style="white-space:pre-wrap;font-size:12.5px;margin-top:3px"><b>Conditions:</b> ${esc(a.conditions)}</div>` : ''}</td>
      <td>${esc(apDates(a))}${a.covers ? '' : ' <span class="pill bad">doesn’t cover the job dates</span>'}</td>
      <td>${a.docName ? `<a href="${a.from === 'Aspex' ? `api/aspex-jobs/${encodeURIComponent(j.key)}/approval/${encodeURIComponent(a.key)}/doc` : `api/approvals/${encodeURIComponent(a.key)}/doc`}" target="_blank" rel="noopener">📄 Document</a>` : '<span class="muted">no document</span>'}</td></tr>`).join('')
      || '<tr><td class="muted">No approvals linked yet.</td></tr>'}</table>
    <p style="margin:8px 0 0"><button class="btn sm ghost" data-ap-new>+ Add my own approval for this job</button>
      <span class="muted" style="font-size:12px">If Aspex is arranging it, it'll appear here once it's in.</span></p></div>`;
}
function bindAspexApprovals(card, j) {
  card.querySelector('[data-ap-new]')?.addEventListener('click', () => newApproval({ title: j.approvalNote || '', aspexJobs: j.key, validFrom: j.start || '', validTo: j.end || j.start || '' }));
}
