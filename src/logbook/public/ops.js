// Jobs, sites, clients, airspace and one-click import for the Aspex logbook.
// Loaded after the main page script and shares its globals ($, esc, num, all, render...).

let ops = { clients: {}, sites: {}, jobs: {}, flightJob: {} };
let siteOfFlight = {};                 // sha256 -> siteId (worked out from take-off point vs site boundaries)
let curJob = null, curSite = null, siteMap = null, siteLayer = null, cfgStatus = {};
const JOB_STATUS = ['Planned', 'Booked', 'Flown', 'Delivered', 'Invoiced', 'Cancelled'];
const OP_TYPES = ['VLOS', 'EVLOS', 'BVLOS'];

const newId = name => (String(name || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'item') + '-' + Math.random().toString(36).slice(2, 6);
const siteName = id => ops.sites[id]?.name || '';
const jobName = id => ops.jobs[id]?.name || '';
const clientName = id => ops.clients[id]?.name || '';
const jobOf = f => ops.flightJob[f.sha256] || '';
const dayOf = f => (f.startLocal || '').slice(0, 10);

function setOps(o) {
  ops = o; for (const k of ['clients', 'sites', 'jobs', 'maint', 'flightJob']) ops[k] ||= {};
  computeMatches();
}
// each flight belongs to the nearest site whose boundary (plus margin) contains its take-off point
function computeMatches() {
  siteOfFlight = {};
  const sites = Object.entries(ops.sites).filter(([, s]) => s.boundary?.length);
  for (const f of all) {
    if (f.takeoffLat == null) continue;
    let best = null, bd = Infinity;
    for (const [id, s] of sites) {
      const d = Geo.distToPolys([f.takeoffLon, f.takeoffLat], s.boundary);
      if (d <= (Number(s.marginM) || 500) && d < bd) { bd = d; best = id; }
    }
    if (best) siteOfFlight[f.sha256] = best;
  }
}
// a "session" = one day's flights at one site (or at one rough spot if no site matches)
function sessionKey(f) {
  const s = siteOfFlight[f.sha256];
  return dayOf(f) + '|' + (s ? 's:' + s : `p:${(f.takeoffLat ?? 0).toFixed(2)},${(f.takeoffLon ?? 0).toFixed(2)}`);
}
function sessions(list) {
  const m = new Map();
  for (const f of list) { const k = sessionKey(f); if (!m.has(k)) m.set(k, []); m.get(k).push(f); }
  return [...m.entries()].map(([k, fl]) => ({ key: k, day: k.slice(0, 10), siteId: siteOfFlight[fl[0].sha256] || '', flights: fl,
    mins: fl.reduce((s, f) => s + (f.durationMin || 0), 0), lat: fl[0].takeoffLat, lon: fl[0].takeoffLon })).sort((a, b) => b.day.localeCompare(a.day));
}
const sessLabel = s => s.siteId ? esc(siteName(s.siteId)) : `<span class="muted">near ${num(s.lat, 3)}, ${num(s.lon, 3)}</span>`;

function siteJobText(f) { return [siteName(siteOfFlight[f.sha256]), jobName(jobOf(f))].filter(Boolean).join(' · '); }
function siteJobCell(f) {
  const s = siteName(siteOfFlight[f.sha256]), j = jobName(jobOf(f));
  if (!s && !j) return '<span class="muted">–</span>';
  return `${esc(s) || '<span class="muted">no site</span>'}${j ? `<span class="sn-sub" style="font-family:inherit">${esc(j)}</span>` : ''}`;
}

async function saveOps(patch, msg = 'Saved') {
  try {
    const r = await fetch('api/ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(await r.text());
    setOps(await r.json()); toast(msg); return true;
  } catch (e) { toast('Could not save - is the logbook window still open?'); return false; }
}
function bindFields(root, kind, id) {
  root.querySelectorAll('[data-f]').forEach(el => el.onchange = async () => {
    await saveOps({ [kind]: { [id]: { [el.dataset.f]: el.value.trim() } } });
    if (kind === 'jobs') { renderJobList(); renderFlights(); }
    if (kind === 'sites') { renderSiteList(); if (el.dataset.f === 'marginM') { renderSiteEdit(); render(); } }
    if (kind === 'clients') renderJobs();
  });
}
const sel = (list, v, empty) => (empty ? `<option value="">${empty}</option>` : '') + list.map(([val, label]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(label)}</option>`).join('');

// ======================= JOBS =======================
function renderJobs() { renderJobList(); renderClientList(); renderJobEdit(); }
function jobStats(id) {
  const fl = all.filter(f => f.isFlight && jobOf(f) === id);
  return { fl, mins: fl.reduce((s, f) => s + (f.durationMin || 0), 0) };
}
function renderJobList() {
  const jobs = Object.entries(ops.jobs).sort((a, b) => (b[1].start || b[1].created || '').localeCompare(a[1].start || a[1].created || ''));
  $('#jobList').innerHTML = jobs.map(([id, j]) => {
    const s = jobStats(id);
    return `<div class="it ${id === curJob ? 'on' : ''}" data-id="${id}"><b>${esc(j.name || 'Untitled job')}</b> <span class="tag">${esc(j.status || 'Planned')}</span>
      <div class="s">${esc(clientName(j.clientId) || 'no client')} · ${esc(siteName(j.siteId) || 'no site')} · ${s.fl.length} flights, ${hrs(s.mins)} h</div></div>`;
  }).join('') || '<div class="empty">No jobs yet</div>';
  $('#jobList').querySelectorAll('.it').forEach(el => el.onclick = () => { curJob = el.dataset.id; renderJobs(); });
}
function renderClientList() {
  const cl = Object.entries(ops.clients).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
  $('#clientList').innerHTML = cl.map(([id, c]) => {
    const n = Object.values(ops.jobs).filter(j => j.clientId === id).length;
    return `<div class="it" data-id="${id}"><input style="border:0;background:transparent;font:inherit;font-weight:600;width:70%" data-f="name" value="${esc(c.name)}">
      <span class="s">${n} job${n === 1 ? '' : 's'}</span><input class="s" style="border:0;background:transparent;font:inherit;width:100%" data-f="contact" placeholder="contact / notes" value="${esc(c.contact)}"></div>`;
  }).join('') || '<div class="empty">No clients yet</div>';
  $('#clientList').querySelectorAll('.it').forEach(el => bindFields(el, 'clients', el.dataset.id));
}
function renderJobEdit() {
  const j = ops.jobs[curJob];
  if (!j) { $('#jobEdit').innerHTML = '<div class="empty">Pick a job on the left, or create one.</div>'; return; }
  const clients = Object.entries(ops.clients).map(([id, c]) => [id, c.name]).sort((a, b) => a[1].localeCompare(b[1]));
  const sites = Object.entries(ops.sites).map(([id, s]) => [id, s.name || 'Untitled site']).sort((a, b) => a[1].localeCompare(b[1]));
  const st = jobStats(curJob);
  const link = (f, ph) => `<div class="linkrow"><input data-f="${f}" value="${esc(j[f])}" placeholder="${ph}">${j[f] ? `<a class="btn sm ghost" style="margin:0" href="${esc(j[f])}" target="_blank" rel="noopener">Open</a>` : ''}</div>`;
  $('#jobEdit').innerHTML = `
    <h2>${esc(j.name || 'Untitled job')} <button class="btn sm danger" id="delJob">Delete job</button></h2>
    <div class="form">
      <label class="full">Job name<input data-f="name" value="${esc(j.name)}" placeholder="e.g. Walla Walla thermography Nov 2026"></label>
      <label>Client (who engages you)<select data-f="clientId">${sel(clients, j.clientId, '— none —')}</select></label>
      <label>Site<select data-f="siteId">${sel(sites, j.siteId, '— none —')}</select></label>
      <label>Status<select data-f="status">${sel(JOB_STATUS.map(x => [x, x]), j.status || 'Planned')}</select></label>
      <label>Reference / PO<input data-f="ref" value="${esc(j.ref)}"></label>
      <label>Start<input type="date" data-f="start" value="${esc(j.start)}"></label>
      <label>End<input type="date" data-f="end" value="${esc(j.end)}"></label>
      <label class="full">Nature and purpose of operation<input data-f="purpose" value="${esc(j.purpose)}" placeholder="e.g. Aerial thermography of solar arrays"></label>
      <label>Flown under (ReOC / operator)<input data-f="operator" value="${esc(j.operator)}"></label>
      <label>Usual operation type<select data-f="opType">${sel(OP_TYPES.map(x => [x, x]), j.opType || 'VLOS')}</select></label>
      <label class="full">Dropbox folder<span>${link('dropboxUrl', 'paste the Dropbox folder link')}</span></label>
      <label class="full">SiteMark project<span>${link('sitemarkUrl', 'paste the SiteMark link')}</span></label>
      <label class="full">Notes<textarea data-f="notes">${esc(j.notes)}</textarea></label>
    </div>
    <div class="sub2">
      <h4>Flights in this job — ${st.fl.length} flights, ${hrs(st.mins)} h</h4>
      <table>${sessions(st.fl).map(s => `<tr><td>${dateOnly(s.day)}</td><td>${sessLabel(s)}</td><td class="n">${s.flights.length} flights</td><td class="n">${hrs(s.mins)} h</td>
        <td class="n"><button class="btn sm ghost" data-rm="${esc(s.key)}">Remove</button></td></tr>`).join('') || '<tr><td class="muted">None yet — add flying days below.</td></tr>'}</table>
      <h4>${j.siteId ? `Unassigned flying days at ${esc(siteName(j.siteId))}` : 'Unassigned flying days (choose a site above to narrow this down)'}</h4>
      <table>${(() => {
        const un = all.filter(f => f.isFlight && !jobOf(f) && (!j.siteId || siteOfFlight[f.sha256] === j.siteId));
        const ss = sessions(un).slice(0, 40);
        return ss.map(s => `<tr><td>${dateOnly(s.day)}</td><td>${sessLabel(s)}</td><td class="n">${s.flights.length} flights</td><td class="n">${hrs(s.mins)} h</td>
          <td class="n"><button class="btn sm" data-add="${esc(s.key)}">Add to job</button></td></tr>`).join('') || '<tr><td class="muted">Nothing unassigned.</td></tr>';
      })()}</table>
    </div>`;
  bindFields($('#jobEdit'), 'jobs', curJob);
  $('#jobEdit').querySelectorAll('[data-f=siteId],[data-f=clientId],[data-f=name]').forEach(el => el.addEventListener('change', () => setTimeout(renderJobEdit, 150)));
  $('#delJob').onclick = async () => {
    if (!confirm(`Delete the job "${j.name || 'Untitled'}"? Its flights stay in the logbook, just unassigned.`)) return;
    await saveOps({ jobs: { [curJob]: null } }, 'Job deleted'); curJob = null; renderJobs(); renderFlights();
  };
  const bySess = key => all.filter(f => f.isFlight && sessionKey(f) === key);
  $('#jobEdit').querySelectorAll('[data-add]').forEach(b => b.onclick = async () => {
    const patch = {}; for (const f of bySess(b.dataset.add)) if (!jobOf(f)) patch[f.sha256] = curJob;
    await saveOps({ flightJob: patch }, `Added ${Object.keys(patch).length} flights`); renderJobs(); renderFlights();
  });
  $('#jobEdit').querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    const patch = {}; for (const f of bySess(b.dataset.rm)) if (jobOf(f) === curJob) patch[f.sha256] = null;
    await saveOps({ flightJob: patch }, 'Removed'); renderJobs(); renderFlights();
  });
}
$('#newJob').onclick = async () => {
  const id = newId('job');
  await saveOps({ jobs: { [id]: { name: '', status: 'Planned', opType: 'VLOS', start: new Date().toISOString().slice(0, 10) } } }, 'Job created');
  curJob = id; renderJobs(); $('#jobEdit [data-f=name]')?.focus();
};
$('#newClient').onclick = async () => {
  const name = prompt('Client name (e.g. SiteMark)'); if (!name?.trim()) return;
  await saveOps({ clients: { [newId(name)]: { name: name.trim() } } }, 'Client added'); renderJobs();
};

// flight drawer: site + job for one flight, or its whole day
function renderAssign(f) {
  const el = $('#dAssign'); if (!el) return;
  if (!f.isFlight) { el.innerHTML = '<div class="muted">Not a flight.</div>'; return; }
  const sid = siteOfFlight[f.sha256];
  const jobs = Object.entries(ops.jobs).sort((a, b) => ((b[1].siteId === sid) - (a[1].siteId === sid)) || (a[1].name || '').localeCompare(b[1].name || ''))
    .map(([id, j]) => [id, (j.name || 'Untitled job') + (sid && j.siteId === sid ? '  ★ this site' : '')]);
  const day = all.filter(x => x.isFlight && sessionKey(x) === sessionKey(f));
  el.innerHTML = `<div class="grid" style="grid-template-columns:1fr 2fr">
    <div><span class="k">Site</span><span class="v">${sid ? esc(siteName(sid)) : '<span class="muted">no site matches this take-off</span>'}</span></div>
    <div><span class="k">Job</span><span class="v" style="display:flex;gap:6px;align-items:center">
      <select id="aJob" style="flex:1;font:inherit;padding:4px">${sel(jobs, jobOf(f), '— no job —')}</select>
      ${day.length > 1 ? `<label style="font-size:12px;white-space:nowrap"><input type="checkbox" id="aDay" checked> all ${day.length} flights that day</label>` : ''}</span></div></div>`;
  $('#aJob').onchange = async () => {
    const patch = {}; for (const x of ($('#aDay')?.checked ? day : [f])) patch[x.sha256] = $('#aJob').value || null;
    await saveOps({ flightJob: patch }, `Updated ${Object.keys(patch).length} flight${Object.keys(patch).length === 1 ? '' : 's'}`);
    renderFlights(); renderAssign(f);
  };
}

// ======================= SITES =======================
function renderSites() { renderSiteList(); renderSiteEdit(); }
function renderSiteList() {
  const counts = {}; for (const f of all) if (f.isFlight && siteOfFlight[f.sha256]) counts[siteOfFlight[f.sha256]] = (counts[siteOfFlight[f.sha256]] || 0) + 1;
  const sites = Object.entries(ops.sites).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
  $('#siteList').innerHTML = sites.map(([id, s]) => `<div class="it ${id === curSite ? 'on' : ''}" data-id="${id}"><b>${esc(s.name || 'Untitled site')}</b>
    <div class="s">${s.areaHa ? num(s.areaHa, 1) + ' ha' : 'no boundary yet'} · ${counts[id] || 0} flights${s.airspace ? ' · airspace checked' : ''}</div></div>`).join('')
    || '<div class="empty">No sites yet</div>';
  $('#siteList').querySelectorAll('.it').forEach(el => el.onclick = () => { curSite = el.dataset.id; renderSites(); });
}
const ASP_TYPE = { 0: 'Other', 1: 'Restricted', 2: 'Danger', 3: 'Prohibited', 4: 'CTR', 5: 'TMZ', 6: 'RMZ', 7: 'TMA', 8: 'TRA', 9: 'TSA', 13: 'ATZ / CTAF area', 14: 'MATZ',
  17: 'Alert', 18: 'Warning', 19: 'Protected', 21: 'Gliding', 25: 'MTA', 26: 'CTA', 28: 'Sport/rec activity', 29: 'Low overflight restriction', 31: 'TFR', 36: 'MCTR' };
const SKIP_TYPES = new Set([10, 11, 15, 16, 32, 33, 34, 35]);   // FIR/UIR/airways/sectors - not relevant at drone heights
const ICAO = { 0: 'A', 1: 'B', 2: 'C', 3: 'D', 4: 'E', 5: 'F', 6: 'G' };
function fmtLimit(l) {
  if (!l) return '?';
  if (l.unit === 6) return `FL${l.value}`;
  if (l.value === 0 && l.referenceDatum === 0) return 'SFC';
  return `${num(l.value)} ft ${l.referenceDatum === 0 ? 'AGL' : l.referenceDatum === 1 ? 'AMSL' : 'STD'}`;
}
// how much a piece of airspace matters for flights up to 400 ft AGL - judged by its TYPE as well as its base
// (e.g. FIA / frequency boundaries are listed by OpenAIP as type "Other" and are not restrictions)
const T_RESTRICT = new Set([1, 3, 4, 8, 9, 31, 36]);        // restricted, prohibited, CTR, TRA, TSA, TFR, military CTR
const T_CONTROLLED = new Set([7, 26]);                      // TMA, CTA - matters only if class A-D
const T_CAUTION = new Set([2, 13, 17, 18, 19, 21, 28, 29]); // danger, uncontrolled aerodrome (CTAF) areas, alert, warning, activity areas
function severity(a) {
  const l = a.lower || {}, t = a.type, c = a.icaoClass;
  const low = l.unit !== 6 && l.referenceDatum === 0 && l.value <= 400;              // starts at/near the ground
  const lowAmsl = l.unit !== 6 && l.referenceDatum === 1 && l.value <= 5000;         // base above sea level - depends on terrain
  if (T_RESTRICT.has(t) || (T_CONTROLLED.has(t) && c >= 0 && c <= 3))
    return low ? ['hi', 'Conflict'] : lowAmsl ? ['md', 'Check base'] : ['lo', 'Above'];
  if (T_CAUTION.has(t)) return low || lowAmsl ? ['md', 'Caution'] : ['lo', 'Above'];
  return low || lowAmsl ? ['lo', 'Info'] : ['lo', 'Above'];
}
function airspaceReport(s) {
  const A = s.airspace; if (!A) return null;
  const items = A.airspaces.filter(a => !SKIP_TYPES.has(a.type)).map(a => {
    const polys = Geo.fromGeoJSON(a.geometry); if (!polys.length) return null;
    const over = Geo.overlaps(s.boundary, polys);
    const dist = over ? 0 : Math.min(...s.boundary[0][0].map(v => Geo.distToPolys(v, polys)));
    return { ...a, polys, over, dist };
  }).filter(Boolean);
  const c = s.centroid ? [s.centroid[1], s.centroid[0]] : null;
  const apts = A.airports.filter(a => a.coords && c).map(a => ({ ...a, dist: Geo.distToPolys(a.coords, s.boundary) })).sort((x, y) => x.dist - y.dist);
  return { over: items.filter(i => i.over), near: items.filter(i => !i.over && i.dist <= 5000), apts: apts.filter(a => a.dist <= 15000), fetched: A.fetched, dataDate: A.dataDate, all: items };
}
function renderSiteEdit() {
  const s = ops.sites[curSite];
  if (!s) { $('#siteEdit').innerHTML = '<div class="empty">Pick a site on the left, or create one. Load the farm boundary from a Google Earth KML.</div>'; return; }
  const matched = all.filter(f => f.isFlight && siteOfFlight[f.sha256] === curSite);
  const rep = s.boundary ? airspaceReport(s) : null;
  const gmaps = s.centroid ? `https://www.google.com/maps/search/?api=1&query=${s.centroid[0]},${s.centroid[1]}` : '';
  const row = a => { const [k, t] = severity(a); return `<div class="asp"><span class="sev ${a.over ? k : 'lo'}">${a.over ? t : num(a.dist / 1000, 1) + ' km'}</span>
    <b>${esc(a.name)}</b> <span class="tag">${esc(ASP_TYPE[a.type] || 'Type ' + a.type)}${ICAO[a.icaoClass] ? ' · class ' + ICAO[a.icaoClass] : ''}</span>
    <span class="muted"> ${fmtLimit(a.lower)} – ${fmtLimit(a.upper)}${a.byNotam ? ' · activated by NOTAM' : ''}</span></div>`; };
  $('#siteEdit').innerHTML = `
    <h2>${esc(s.name || 'Untitled site')} <button class="btn sm danger" id="delSite">Delete site</button></h2>
    <div class="form">
      <label class="full">Site name<input data-f="name" value="${esc(s.name)}" placeholder="e.g. Walla Walla Solar Farm"></label>
      <label>Owner<input data-f="owner" value="${esc(s.owner)}"></label>
      <label>O&M company<input data-f="om" value="${esc(s.om)}"></label>
      <label>Match flights within (m of boundary)<input type="number" min="0" max="5000" step="50" data-f="marginM" value="${esc(s.marginM || 500)}"></label>
      <label>&nbsp;<span class="muted" style="font-size:12.5px;padding-top:6px">${matched.length} flights matched to this site</span></label>
      <label class="full">Notes (access, gate codes, contacts…)<textarea data-f="notes">${esc(s.notes)}</textarea></label>
    </div>
    ${s.boundary ? `<div class="facts"><div><b>${num(s.areaHa, 1)} ha</b>area inside boundary</div>
        <div><b>${num(s.centroid[0], 5)}, ${num(s.centroid[1], 5)}</b>centre</div>
        <div><a class="btn ghost" href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps</a></div>
        <div class="muted" style="align-self:end">from ${esc(s.boundaryFile || 'KML')}</div></div>` : ''}
    <div class="drop" id="kmlDrop">${s.boundary ? 'Replace the boundary: drop' : 'Drop'} a Google Earth <b>KML or KMZ</b> of the farm boundary here, or click to choose one
      <input type="file" id="kmlFile" accept=".kml,.kmz" hidden></div>
    <div id="siteMap"></div>
    <div class="sub2">
      <h4>Airspace <button class="btn sm" id="aspBtn" ${!s.boundary ? 'disabled' : ''}>${s.airspace ? 'Re-check airspace' : 'Check airspace'}</button></h4>
      <div class="warnbox" style="margin:6px 0 10px"><b>Preliminary check only.</b> This uses community-maintained OpenAIP data and is for planning and quoting.
        Before every flight, do the final airspace check in a CASA-verified drone safety app (for example OpenSky or ok2fly), and check NOTAMs.</div>
      ${!s.boundary ? '<div class="muted">Load the site boundary first.</div>' : ''}
      ${rep ? `<div class="muted" style="font-size:12px;margin-bottom:6px">Checked ${new Date(rep.fetched).toLocaleString('en-AU')}${rep.dataDate ? ` · OpenAIP Australia data downloaded ${new Date(rep.dataDate).toLocaleDateString('en-AU')} (refreshed every 30 days)` : ''}</div>
        <div class="muted" style="font-size:12px;margin-bottom:8px"><span class="sev hi">Conflict</span> restricted / prohibited / control zone, or class A–D from the surface · <span class="sev md">Caution</span> CTAF areas, danger areas, low-based controlled airspace · <span class="sev lo">Info</span> frequency/FIA boundaries and other non-restrictive areas</div><b style="font-size:13px">Overlapping the site</b>${rep.over.map(row).join('') || '<div class="asp muted">No airspace from OpenAIP overlaps the boundary.</div>'}
        <b style="font-size:13px;display:block;margin-top:10px">Within 5 km</b>${rep.near.map(row).join('') || '<div class="asp muted">None.</div>'}
        <b style="font-size:13px;display:block;margin-top:10px">Aerodromes and landing areas within 15 km</b>${rep.apts.map(a => `<div class="asp">
          <span class="sev ${a.dist <= 5600 ? 'hi' : 'lo'}">${num(a.dist / 1000, 1)} km</span><b>${esc(a.name)}</b> ${a.icao ? `<span class="tag">${esc(a.icao)}</span>` : ''}</div>`).join('')
          || '<div class="asp muted">None listed.</div>'}` : ''}
    </div>`;
  bindFields($('#siteEdit'), 'sites', curSite);
  $('#siteEdit [data-f=name]').addEventListener('change', () => setTimeout(() => { renderSiteEdit(); renderFlights(); }, 150));
  $('#delSite').onclick = async () => {
    const used = Object.values(ops.jobs).filter(j => j.siteId === curSite).length;
    if (!confirm(`Delete the site "${s.name || 'Untitled'}"?${used ? ` ${used} job(s) use it and will lose their site.` : ''}`)) return;
    const patch = { sites: { [curSite]: null }, jobs: {} };
    for (const [id, j] of Object.entries(ops.jobs)) if (j.siteId === curSite) patch.jobs[id] = { siteId: '' };
    await saveOps(patch, 'Site deleted'); curSite = null; renderSites(); render();
  };
  // boundary upload
  const drop = $('#kmlDrop'), file = $('#kmlFile');
  const upload = async f => {
    if (!f) return;
    const r = await fetch(`api/sites/${curSite}/kml?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    if (!r.ok) { toast(await r.text(), 8000); return; }
    setOps(await r.json()); toast('Boundary loaded'); renderSites(); render();
  };
  drop.onclick = () => file.click(); file.onchange = () => upload(file.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files[0]); };
  $('#aspBtn').onclick = async () => {
    $('#aspBtn').disabled = true; $('#aspBtn').textContent = 'Checking…';
    const r = await fetch(`api/sites/${curSite}/airspace`, { method: 'POST' });
    if (!r.ok) { toast(await r.text(), 12000); $('#aspBtn').disabled = false; $('#aspBtn').textContent = 'Check airspace'; return; }
    setOps(await r.json()); toast('Airspace checked'); renderSites();
  };
  drawSiteMap(s, matched, rep);
}
function drawSiteMap(s, matched, rep) {
  if (siteMap) { siteMap.remove(); siteMap = null; }
  siteMap = L.map('siteMap');
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri · Airspace © openAIP' }).addTo(siteMap);
  const toLL = ring => ring.map(([x, y]) => [y, x]);
  const layers = [];
  if (rep) for (const a of rep.all.filter(a => a.over || a.dist <= 5000)) {
    const [k] = severity(a); const col = a.over && k === 'hi' ? '#e0392b' : a.over && k === 'md' ? '#f08a00' : '#7f8c8d';
    for (const p of a.polys) layers.push(L.polygon(p.map(toLL), { color: col, weight: 1.5, fillOpacity: .08, dashArray: a.over ? null : '4 4' }).bindTooltip(`${a.name} (${fmtLimit(a.lower)}–${fmtLimit(a.upper)})`));
  }
  if (rep) for (const a of rep.apts) layers.push(L.circleMarker([a.coords[1], a.coords[0]], { radius: 6, color: '#fff', weight: 2, fillColor: '#2c6fbb', fillOpacity: 1 }).bindTooltip(a.name));
  let bounds = null;
  if (s.boundary) { const b = L.polygon(s.boundary.map(p => p.map(toLL)), { color: '#ffd400', weight: 3, fillOpacity: .05 }); layers.push(b); bounds = b.getBounds(); }
  for (const f of matched) layers.push(L.circleMarker([f.takeoffLat, f.takeoffLon], { radius: 4, color: '#0f6e5a', weight: 1, fillColor: '#3fd1a8', fillOpacity: .9 }).bindTooltip(`${f.flightNo} · ${f.startLocal}`));
  const g = L.featureGroup(layers).addTo(siteMap);
  if (bounds) siteMap.fitBounds(bounds.pad(0.15)); else if (layers.length) siteMap.fitBounds(g.getBounds().pad(0.2)); else siteMap.setView([-33, 147], 5);
}
$('#newSite').onclick = async () => {
  const id = newId('site');
  await saveOps({ sites: { [id]: { name: '', marginM: '500' } } }, 'Site created'); curSite = id; renderSites(); $('#siteEdit [data-f=name]')?.focus();
};

// ======================= IMPORT =======================
const impWrite = t => { const pre = $('#impLog'); pre.textContent += t + '\n'; pre.scrollTop = pre.scrollHeight; };
const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(iso).toLocaleDateString('en-AU'); };
async function impRefresh() {
  const j = await (await fetch('api/import/status')).json();
  cfgStatus.dji = j.dji;
  $('#impDji').innerHTML = j.dji ? '' : '<p class="pill warn" style="display:block;padding:8px 10px">No DJI developer key yet, so flights are logged without GPS tracks or battery data. Add it under Settings below.</p>';
  $('#impLog').textContent = j.uploads.length ? 'Recent imports:\n' + j.uploads.slice(0, 25).map(u => `  ${ago(u.at).padEnd(11)} ${u.file}  ${u.status}${u.track ? ' · ' + u.track : ''}  (${u.via})`).join('\n') + '\n' : '';
  const s = await (await fetch('api/settings')).json();
  $('#impKeyHint').textContent = s.dji ? `key saved (ends ${s.djiHint})` : 'not set';
}
$('#importBtn').onclick = () => { $('#impModal').hidden = false; impRefresh(); };
$('#impClose').onclick = () => { $('#impModal').hidden = true; };
async function impUpload(files) {
  files = [...files].filter(f => /\.txt$/i.test(f.name));
  if (!files.length) return toast('Choose DJIFlightRecord_….txt files');
  $('#impLog').textContent = '';
  let i = 0;
  for (const f of files) {
    i++;
    try {
      const r = await fetch('api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
      const t = r.ok ? (await r.json()).summary : await r.text();
      impWrite(`[${i}/${files.length}] ${f.name}  ${t}`);
    } catch (e) { impWrite(`[${i}/${files.length}] ${f.name}  FAILED: ${e.message}`); }
  }
  impWrite('Done.'); await load();
}
$('#impDrop').onclick = () => $('#impFiles').click();
$('#impFiles').onchange = e => impUpload(e.target.files);
$('#impDrop').ondragover = e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--accent)'; };
$('#impDrop').ondragleave = e => { e.currentTarget.style.borderColor = ''; };
$('#impDrop').ondrop = e => { e.preventDefault(); e.currentTarget.style.borderColor = ''; impUpload(e.dataTransfer.files); };
$('#impKeySave').onclick = async () => {
  const v = $('#impKey').value.trim(); if (!v) return;
  await fetch('api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ djiApiKey: v }) });
  $('#impKey').value = ''; toast('DJI key saved'); impRefresh();
};
$('#impNewKey').onclick = async () => {
  if (!confirm('Make a new upload key? Copies of Import Flights you already downloaded will stop working.')) return;
  await fetch('api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newUploadKey: true }) });
  toast('New key made - download Import Flights again');
};
$('#impMigrate').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  $('#impLog').textContent = 'Moving the old logbook across… (this can take a minute)\n';
  const r = await fetch('api/migrate', { method: 'POST', body: f });
  if (!r.ok) return impWrite('Failed: ' + await r.text());
  const o = await r.json();
  if (o.extras) impWrite(`Added battery cycle counts to ${o.extras} flights.`);
  if (o.flights || !o.extras) impWrite(`Moved ${o.flights} flights, ${o.tracks} GPS tracks and ${o.keys} DJI keys${o.skipped ? ` (${o.skipped} were already here)` : ''}.`);
  await load();
};

// start
(async () => {
  try {
    const me = await (await fetch('api/settings')).json();
    cfgStatus = { dji: me.dji };
    $('#who').innerHTML = `${esc(me.name || me.email)} · <a href="logout" style="color:#9fb3aa">Log out</a>`;
    $('#backLink').hidden = me.role !== 'owner';
  } catch {}
  load();
})();
