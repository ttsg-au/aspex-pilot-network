// CASA records: your pilot details ("Me"), the CASA fields on each flight, the drone
// maintenance log, and the three Part 101 MOS chapter 10 logs (Reports).
// Shares globals with the main page script ($, esc, num, hrs, all, inv, ops, toast...).

let me = {};
const OPS3 = ['VLOS', 'EVLOS', 'BVLOS'];

// ---------- night: sun more than 6° below the horizon (outside civil twilight) ----------
function sunElevation(lat, lon, date) {
  const r = Math.PI / 180, d = date / 864e5 + 2440587.5 - 2451545.0;      // days since J2000
  const g = (357.529 + 0.98560028 * d) * r, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * r, e = (23.439 - 0.00000036 * d) * r;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon) * r) - ra;
  return Math.asin(Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(ha)) / r;
}
// Minutes flown at night: checks the sun at take-off, middle and landing.
function nightMin(f) {
  if (f.takeoffLat == null || !f.startUtc) return 0;
  const t0 = Date.parse(f.startUtc), dur = (f.durationMin || 0) * 60e3;
  const pts = [0, 0.5, 1].map(x => sunElevation(f.takeoffLat, f.takeoffLon, t0 + dur * x) < -6);
  return (pts.filter(Boolean).length / 3) * (f.durationMin || 0);
}
const dayNight = f => { const n = nightMin(f); return n === 0 ? 'Day' : n >= (f.durationMin || 0) - 0.01 ? 'Night' : 'Day / night'; };
const picOf = f => f.pic || me.fullName || '';
const opOf = f => f.opType || ops.jobs[jobOf(f)]?.opType || me.defaultOpType || 'VLOS';
const svcOf = f => f.serviceable || 'yes';

// ---------- CASA fields in the flight drawer ----------
function renderCasa(f) {
  const el = $('#dCasa'); if (!el) return;
  if (!f.isFlight) { el.innerHTML = ''; return; }
  const day = all.filter(x => x.isFlight && sessionKey(x) === sessionKey(f));
  el.innerHTML = `<div class="section">CASA record</div>
    <div class="grid casa">
      <label><span class="k">Pilot in command</span><input id="cPic" value="${esc(f.pic || '')}" placeholder="${esc(me.fullName || 'your name - set it under Me')}"></label>
      <label><span class="k">Other pilot / observer</span><input id="cOther" value="${esc(f.otherPilot || '')}"></label>
      <label><span class="k">Operation</span><select id="cOp">${OPS3.map(o => `<option${o === opOf(f) ? ' selected' : ''}>${o}</option>`).join('')}</select></label>
      <div><span class="k">Day / night</span><span class="v">${dayNight(f)}${nightMin(f) ? ` <span class="muted">(${num(nightMin(f), 1)} min night)</span>` : ''}</span></div>
      <label><span class="k">Serviceable after flight</span><select id="cSvc"><option value="yes"${svcOf(f) === 'yes' ? ' selected' : ''}>Yes</option><option value="no"${svcOf(f) === 'no' ? ' selected' : ''}>No - defect</option></select></label>
      <label style="grid-column:span 3"${svcOf(f) === 'no' ? '' : ' hidden'} id="cDefWrap"><span class="k">Defect (goes in the technical log)</span><input id="cDef" value="${esc(f.defect || '')}" placeholder="what's wrong, what was done"></label>
    </div>
    ${day.length > 1 ? `<label style="font-size:12.5px;display:block;margin-top:6px"><input type="checkbox" id="cDay" checked> apply pilot and operation to all ${day.length} flights that day</label>` : ''}
    <label style="display:block;margin-top:8px"><span class="k">Notes</span><input id="cNotes" style="width:100%" value="${esc(f.notes || '')}"></label>`;
  const save = async (fields, many) => {
    const list = many && $('#cDay')?.checked ? day : [f];
    for (const x of list) {
      const r = await fetch('api/flights/' + x.sha256, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
      if (r.ok) Object.assign(x, await r.json());
    }
    toast(list.length > 1 ? `Saved for ${list.length} flights` : 'Saved'); renderFlights();
  };
  $('#cPic').onchange = e => save({ pic: e.target.value.trim() }, true);
  $('#cOther').onchange = e => save({ otherPilot: e.target.value.trim() }, true);
  $('#cOp').onchange = e => save({ opType: e.target.value }, true);
  $('#cSvc').onchange = e => { $('#cDefWrap').hidden = e.target.value !== 'no'; save({ serviceable: e.target.value }); };
  $('#cDef').onchange = e => save({ defect: e.target.value.trim() });
  $('#cNotes').onchange = e => save({ notes: e.target.value.trim() });
}

// ---------- Me (pilot details) ----------
async function loadMe() { try { me = await (await fetch('api/profile')).json(); } catch { me = {}; } }
function renderMe() {
  const exp = me.replExpiry ? Math.round((Date.parse(me.replExpiry) - Date.now()) / 864e5) : null;
  const flights = all.filter(f => f.isFlight);
  const mins = flights.reduce((s, f) => s + (f.durationMin || 0), 0);
  $('#v-me').innerHTML = `<div class="panel" style="max-width:820px"><h2>My pilot details <span class="hint">used as pilot in command and at the top of your remote pilot log</span></h2>
    ${exp != null && exp < 60 ? `<div class="pill ${exp < 0 ? 'bad' : 'warn'}" style="display:block;margin:12px 14px 0;padding:8px 10px">${exp < 0 ? 'Your licence expiry date has passed.' : `Your licence expires in ${exp} days.`}</div>` : ''}
    <div class="form2" style="padding:14px">
      <label>Full name<input data-p="fullName" value="${esc(me.fullName || '')}"></label>
      <label>ARN (Aviation Reference Number)<input data-p="arn" value="${esc(me.arn || '')}"></label>
      <label>RePL number<input data-p="replNo" value="${esc(me.replNo || '')}"></label>
      <label>RePL expiry (if any)<input type="date" data-p="replExpiry" value="${esc(me.replExpiry || '')}"></label>
      <label style="grid-column:span 2">RePL category / ratings (e.g. multirotor up to 25 kg, aeroplane)<input data-p="replClass" value="${esc(me.replClass || '')}"></label>
      <label style="grid-column:span 2">Other qualifications (AROC, night, EVLOS/BVLOS approvals…)<textarea data-p="otherQuals" rows="3">${esc(me.otherQuals || '')}</textarea></label>
      <label>Insurance expiry<input type="date" data-p="insuranceExpiry" value="${esc(me.insuranceExpiry || '')}"></label>
      <label>Weekly reminder email<select data-p="remindersOff"><option value=""${me.remindersOff ? '' : ' selected'}>On - Mondays, when something is due</option><option value="1"${me.remindersOff ? ' selected' : ''}>Off</option></select></label>
      <label>Usual operation type<select data-p="defaultOpType">${OPS3.map(o => `<option${o === (me.defaultOpType || 'VLOS') ? ' selected' : ''}>${o}</option>`).join('')}</select></label>
    </div>
    <div style="padding:0 14px 14px"><b>Coming up</b> <span class="muted">- what your Monday email will include</span>
      <div id="remList" class="muted" style="margin-top:6px">Checking…</div>
      <button class="btn sm ghost" id="remSend" style="margin-top:8px">Email me this now</button></div>
    <div class="note">Totals in this logbook: ${num(flights.length)} flights, ${hrs(mins)} hours, of which ${hrs(flights.reduce((s, f) => s + nightMin(f), 0))} h at night. Flights where you set someone else as pilot in command are not counted in your remote pilot log.</div></div>`;
  fetch('api/reminders').then(r => r.json()).then(it => {
    const all3 = [['Licences and paperwork', it.paperwork], ['Drones', it.drones], ['Batteries', it.batteries]].filter(x => x[1].length);
    $('#remList').innerHTML = all3.length ? all3.map(([t, l]) => `<div style="margin-top:6px"><b style="color:var(--ink)">${t}</b>${l.map(x => `<div>${x.level === 'red' ? '🔴' : '🟠'} ${esc(x.text)}</div>`).join('')}</div>`).join('') : 'Nothing due - no email this week.';
  }).catch(() => { $('#remList').textContent = ''; });
  $('#remSend').onclick = async () => {
    const r = await fetch('api/reminders/send', { method: 'POST' });
    toast(r.ok ? `Sent to ${(await r.json()).to}` : await r.text(), 3000);
  };
  $('#v-me').querySelectorAll('[data-p]').forEach(el => el.onchange = async () => {
    const r = await fetch('api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [el.dataset.p]: el.value.trim() }) });
    if (r.ok) { me = { ...me, ...(await r.json()) }; toast('Saved'); } else toast('Could not save');
  });
}

// ---------- drone maintenance ----------
const MAINT_TYPES = ['50-hour inspection', 'Routine inspection', 'Pre-job inspection', 'Part replaced', 'Firmware update', 'Repair', 'Calibration', 'Other'];
const CHECKS = ['Propellers - clockwise (CW)', 'Propellers - counter-clockwise (CCW)', 'Arms and folding hinges', 'Motors spin freely, no noise or heat',
  'Airframe and shell (cracks, loose screws)', 'Gimbal and cameras', 'Lenses and sensor windows clean', 'Vision / obstacle sensors',
  'Battery contacts and latches', 'Remote controller and antennas', 'Compass / IMU calibration checked', 'Firmware checked (aircraft, controller, batteries)',
  'Firmware updated', 'Test hover OK'];
const acHours = (sn, upTo) => all.filter(f => f.isFlight && f.aircraftSn === sn && (!upTo || f.startLocal.slice(0, 10) <= upTo)).reduce((s, f) => s + (f.durationMin || 0), 0) / 60;
const maintFor = sn => Object.entries(ops.maint || {}).filter(([, m]) => m.sn === sn).sort((a, b) => (b[1].date || '').localeCompare(a[1].date || ''));
function inspectionDue(sn) {
  const every = Number(inv.aircraft[sn]?.inspectEveryH) || 50;
  const last = maintFor(sn).find(([, m]) => /inspection/i.test(m.type));
  const since = acHours(sn) - (last ? Number(last[1].hoursAt) || acHours(sn, last[1].date) : 0);
  return { every, last: last?.[1], since: Math.max(0, since), left: every - Math.max(0, since) };
}
function dueBadge(sn) {
  const d = inspectionDue(sn);
  const cls = d.left < 0 ? 'bad' : d.left < 5 ? 'warn' : 'ok';
  return `<span class="pill ${cls}">${d.left < 0 ? `Inspection overdue by ${num(-d.left, 1)} h` : `Next inspection in ${num(d.left, 1)} h`}</span>`;
}
const checkList = c => (c || '').split('|').filter(Boolean);
const checkSummaryText = c => { const l = checkList(c); return l.length === CHECKS.length ? `all ${CHECKS.length} checklist items` : l.join(', '); };
function checkSummary(c) {
  const l = checkList(c);
  if (!l.length) return '–';
  if (l.length === CHECKS.length) return `<details><summary>All ${l.length} checklist items</summary>${l.map(esc).join('<br>')}</details>`;
  return l.map(esc).join('<br>');
}
let maintSn = null, maintEdit = null;
function renderMaint(sn) {
  maintSn = sn;
  const a = inv.aircraft[sn] || {}, d = inspectionDue(sn), list = maintFor(sn);
  const box = $('#maintBox'); if (!box) return;
  box.innerHTML = `<div class="panel" style="margin-top:12px"><h2>Maintenance - ${esc(a.code || model(a.model))} <span class="hint">${esc(sn)} · ${num(acHours(sn), 1)} flight hours</span>
      <button class="btn sm ghost" id="mClose">Close</button></h2>
    <div style="padding:12px 14px;display:flex;gap:18px;flex-wrap:wrap;align-items:center">
      ${dueBadge(sn)}
      <span class="muted">${d.last ? `Last inspection ${dateOnly(d.last.date)} (${num(d.since, 1)} h ago)` : 'No inspection recorded yet'}</span>
      <label class="muted">Inspect every <input id="mEvery" type="number" min="1" style="width:60px" value="${d.every}"> flight hours</label>
    </div>
    <details id="mForm" ${list.length ? '' : 'open'} style="padding:0 14px 12px"><summary class="btn sm" id="mSummary">+ Record maintenance</summary>
      <div class="form2" style="margin-top:10px">
        <label>Date<input type="date" id="mDate" value="${new Date().toLocaleDateString('en-CA')}"></label>
        <label>Type<select id="mType">${MAINT_TYPES.map(t => `<option>${t}</option>`).join('')}</select></label>
        <label>Done by<input id="mBy" value="${esc(me.fullName || '')}"></label>
        <label>Firmware version (if checked or updated)<input id="mFw" placeholder="e.g. aircraft v10.01.0103"></label>
      </div>
      <div id="mChecks" class="checks">${CHECKS.map((c, i) => `<label><input type="checkbox" data-c="${i}"> ${esc(c)}</label>`).join('')}
        <div style="grid-column:1/-1"><button class="btn sm ghost" type="button" id="mAll">Tick all</button></div></div>
      <div class="form2"><label style="grid-column:span 2">Parts replaced (part, serial, reason)<textarea id="mParts" rows="2" placeholder="e.g. 2 x CCW propellers - chipped tips"></textarea></label>
        <label style="grid-column:span 2">Notes / findings<textarea id="mNotes" rows="2"></textarea></label></div>
      <button class="btn" id="mSave">Save to maintenance log</button> <button class="btn ghost" id="mCancel" hidden>Cancel editing</button>
    </details>
    <div class="scroll" style="max-height:none"><table>
      <tr><th>Date</th><th>Type</th><th class="n">Aircraft hours</th><th>Checked</th><th>Parts / firmware</th><th>Notes</th><th>By</th><th></th></tr>
      ${list.map(([id, m]) => `<tr><td>${dateOnly(m.date)}</td><td>${esc(m.type)}</td><td class="n">${num(Number(m.hoursAt), 1)}</td>
        <td style="font-size:12px">${checkSummary(m.checks)}</td>
        <td style="font-size:12px">${esc(m.parts || '')}${m.firmware ? `<br>Firmware: ${esc(m.firmware)}` : ''}</td>
        <td style="font-size:12px">${esc(m.notes || '')}</td><td>${esc(m.by || '')}</td>
        <td style="white-space:nowrap"><button class="btn sm ghost" data-edit="${id}">Edit</button> <button class="btn sm ghost" data-del="${id}" title="Delete this entry">×</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">Nothing recorded yet</td></tr>'}
    </table></div></div>`;
  const showChecks = () => { $('#mChecks').hidden = !/inspection/i.test($('#mType').value); };
  $('#mType').onchange = showChecks; showChecks();
  $('#mAll').onclick = () => box.querySelectorAll('[data-c]').forEach(c => c.checked = true);
  $('#mClose').onclick = () => { maintSn = null; maintEdit = null; box.innerHTML = ''; };
  const startEdit = (id) => {
    const m = ops.maint[id]; if (!m) return;
    maintEdit = id;
    $('#mDate').value = m.date || ''; $('#mType').value = m.type || MAINT_TYPES[0]; $('#mBy').value = m.by || '';
    $('#mFw').value = m.firmware || ''; $('#mParts').value = m.parts || ''; $('#mNotes').value = m.notes || '';
    const ticked = new Set(checkList(m.checks));
    box.querySelectorAll('[data-c]').forEach(c => c.checked = ticked.has(CHECKS[c.dataset.c]));
    showChecks();
    $('#mForm').open = true; $('#mSummary').textContent = 'Editing entry from ' + dateOnly(m.date);
    $('#mSave').textContent = 'Save changes'; $('#mCancel').hidden = false;
    $('#mForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => startEdit(b.dataset.edit));
  $('#mCancel').onclick = () => { maintEdit = null; renderMaint(sn); };
  $('#mEvery').onchange = async e => {
    const r = await fetch('api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aircraft: { [sn]: { inspectEveryH: e.target.value } } }) });
    if (r.ok) { inv = await r.json(); toast('Saved'); renderDrones(); }
  };
  $('#mSave').onclick = async () => {
    const date = $('#mDate').value, type = $('#mType').value;
    const checks = /inspection/i.test(type) ? [...box.querySelectorAll('[data-c]:checked')].map(c => CHECKS[c.dataset.c]).join('|') : '';
    const item = { sn, date, type, checks, parts: $('#mParts').value.trim(), firmware: $('#mFw').value.trim(), by: $('#mBy').value.trim(), notes: $('#mNotes').value.trim(), hoursAt: acHours(sn, date).toFixed(2) };
    if (!date) return toast('Pick a date');
    if (!checks && !item.parts && !item.firmware && !item.notes) return toast('Tick the checks done, or add parts, firmware or notes');
    const id = maintEdit || 'm-' + Date.now().toString(36);
    await saveOps({ maint: { [id]: item } }, maintEdit ? 'Changes saved' : 'Added to the maintenance log');
    maintEdit = null; renderDrones();
  };
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this maintenance entry?')) return;
    await saveOps({ maint: { [b.dataset.del]: null } }, 'Deleted'); renderDrones();
  });
}

// ---------- Reports: the three CASA logs ----------
let repKind = 'operational';
const inRange = (f, from, to) => { const d = f.startLocal.slice(0, 10); return (!from || d >= from) && (!to || d <= to); };
const where = f => { const sid = siteOfFlight[f.sha256]; return sid ? siteName(sid) : f.takeoffLat != null ? `${num(f.takeoffLat, 4)}, ${num(f.takeoffLon, 4)}` : '–'; };
const acDesc = sn => { const a = inv.aircraft[sn] || {}; return [a.code, model(a.model), a.registration ? 'rego ' + a.registration : ''].filter(Boolean).join(' · '); };
function reportData(from, to) {
  const fl = all.filter(f => f.isFlight && inRange(f, from, to)).sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  if (repKind === 'operational') return {
    title: 'RPAS operational log',
    cols: ['Date', 'Take-off', 'Landing', 'Location', 'Job', 'Aircraft', 'Pilot in command', 'Operation', 'Day/night', 'Minutes', 'Serviceable', 'Defect / notes'],
    rows: fl.map(f => [f.startLocal.slice(0, 10), timeOnly(f.startLocal), timeOnly(f.endLocal), where(f), ops.jobs[jobOf(f)]?.name || '', acLabel(f) + (inv.aircraft[f.aircraftSn]?.registration ? ` (${inv.aircraft[f.aircraftSn].registration})` : ''),
      picOf(f), opOf(f), dayNight(f), num(f.durationMin, 1), svcOf(f) === 'no' ? 'NO' : 'Yes', [f.defect, f.notes].filter(Boolean).join(' - ')]),
  };
  if (repKind === 'pilot') {
    const mine = fl.filter(f => !f.pic || f.pic === me.fullName);
    const sum = (list, fn = f => f.durationMin || 0) => list.reduce((s, f) => s + fn(f), 0) / 60;
    const types = [...new Set(mine.map(f => model(f.aircraftModel)))];
    return {
      title: 'Remote pilot log',
      head: `<p><b>${esc(me.fullName || '(set your name under Me)')}</b> · ARN ${esc(me.arn || '–')} · RePL ${esc(me.replNo || '–')}${me.replClass ? ' · ' + esc(me.replClass) : ''}</p>
        <table class="sum"><tr><th>Aircraft type</th><th class="n">Flights</th><th class="n">Total h</th><th class="n">Night h</th><th class="n">VLOS h</th><th class="n">EVLOS h</th><th class="n">BVLOS h</th></tr>
        ${[...types.map(t => [t, mine.filter(f => model(f.aircraftModel) === t)]), ['All types', mine]].map(([t, l]) => `<tr${t === 'All types' ? ' style="font-weight:600"' : ''}><td>${esc(t)}</td><td class="n">${l.length}</td><td class="n">${num(sum(l), 1)}</td><td class="n">${num(sum(l, nightMin), 1)}</td>
          ${OPS3.map(o => `<td class="n">${num(sum(l.filter(f => opOf(f) === o)), 1)}</td>`).join('')}</tr>`).join('')}</table>
        <p class="muted">Simulated flight time: none recorded. Flights where someone else was pilot in command are left out.</p>`,
      cols: ['Date', 'Location', 'Aircraft', 'Operation', 'Day/night', 'Minutes', 'Night min'],
      rows: mine.map(f => [f.startLocal.slice(0, 10) + ' ' + timeOnly(f.startLocal), where(f), acDesc(f.aircraftSn) || model(f.aircraftModel), opOf(f), dayNight(f), num(f.durationMin, 1), num(nightMin(f), 1)]),
    };
  }
  // technical log, per drone
  const acs = Object.keys(inv.aircraft).filter(sn => all.some(f => f.aircraftSn === sn));
  return {
    title: 'RPAS technical log',
    head: acs.map(sn => {
      const d = inspectionDue(sn), defects = fl.filter(f => f.aircraftSn === sn && (svcOf(f) === 'no' || f.defect));
      const m = maintFor(sn).filter(([, x]) => (!from || x.date >= from) && (!to || x.date <= to));
      return `<h3 style="margin:18px 0 4px">${esc(acDesc(sn) || sn)} <span class="muted" style="font-weight:400">serial ${esc(sn)}</span></h3>
        <p>Total ${num(acHours(sn), 1)} flight hours, ${all.filter(f => f.isFlight && f.aircraftSn === sn).length} flights. ${d.last ? `Last inspection ${dateOnly(d.last.date)}; ` : ''}next inspection due in ${num(d.left, 1)} h (every ${d.every} h). Status: ${esc(inv.aircraft[sn].status || 'In service')}.</p>
        <table class="sum"><tr><th>Date</th><th>Maintenance / defect</th><th class="n">Aircraft h</th><th>Details</th><th>By</th></tr>
        ${[...m.map(([, x]) => [x.date, x.type, Number(x.hoursAt), [x.checks ? 'Checked: ' + checkSummaryText(x.checks) : '', x.parts && 'Parts: ' + x.parts, x.firmware && 'Firmware: ' + x.firmware, x.notes].filter(Boolean).join('. '), x.by]),
           ...defects.map(f => [f.startLocal.slice(0, 10), 'Defect after flight ' + (f.flightNo || ''), acHours(sn, f.startLocal.slice(0, 10)), f.defect || '(no details)', picOf(f)])]
          .sort((a, b) => a[0].localeCompare(b[0])).map(r => `<tr><td>${dateOnly(r[0])}</td><td>${esc(r[1])}</td><td class="n">${num(r[2], 1)}</td><td style="font-size:12px">${esc(r[3])}</td><td>${esc(r[4] || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing in this period</td></tr>'}</table>`;
    }).join(''),
    cols: [], rows: [],
  };
}
function renderReports() {
  const v = $('#v-reports');
  const from = v.querySelector('#rFrom')?.value ?? '', to = v.querySelector('#rTo')?.value ?? '';
  const r = reportData(from, to);
  v.innerHTML = `<div class="panel"><h2>CASA records <span class="hint">Part 101 MOS chapter 10 · pick a log and a date range</span></h2>
    <div class="tools noprint" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:10px 14px">
      <nav class="subtabs" style="margin:0">${[['operational', 'Operational log'], ['pilot', 'Remote pilot log'], ['technical', 'Technical log']].map(([k, l]) => `<button data-r="${k}" class="${k === repKind ? 'on' : ''}">${l}</button>`).join('')}</nav>
      <label>From <input type="date" id="rFrom" value="${from}"></label><label>To <input type="date" id="rTo" value="${to}"></label>
      <button class="btn sm" id="rPrint">Print / save as PDF</button>${r.rows.length ? '<button class="btn sm ghost" id="rCsv">Download CSV</button>' : ''}
    </div>
    <div class="report" id="rBody" style="padding:4px 14px 14px">
      <h2 class="ptitle">${r.title}${from || to ? ` <span class="muted" style="font-weight:400">${from ? dateOnly(from) : 'start'} – ${to ? dateOnly(to) : 'today'}</span>` : ''}</h2>
      ${r.head || ''}
      ${r.rows.length ? `<table class="sum"><tr>${r.cols.map(c => `<th>${c}</th>`).join('')}</tr>${r.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>
        <p class="muted">${r.rows.length} flights.</p>` : (r.cols.length ? '<p class="muted">No flights in this period.</p>' : '')}
    </div></div>`;
  v.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { repKind = b.dataset.r; renderReports(); });
  $('#rFrom').onchange = $('#rTo').onchange = renderReports;
  $('#rPrint').onclick = () => window.print();
  $('#rCsv') && ($('#rCsv').onclick = () => {
    const q = c => /[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c;
    const csv = '﻿' + [r.cols, ...r.rows].map(row => row.map(c => q(String(c ?? ''))).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${r.title}${from ? ' from ' + from : ''}${to ? ' to ' + to : ''}.csv`; a.click();
  });
}
