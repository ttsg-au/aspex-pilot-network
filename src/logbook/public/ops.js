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
  ops = o; for (const k of ['clients', 'sites', 'jobs', 'maint', 'approvals', 'flightJob']) ops[k] ||= {};
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
  // two lists: upcoming and current (ends today or later, or no dates yet) soonest first, then past jobs most recent first
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const when = j => j.start || j.created || '';
  const isPast = j => { const last = j.end || j.start; return !!last && last < today; };
  const all = Object.entries(ops.jobs);
  const upcoming = all.filter(([, j]) => !isPast(j)).sort((a, b) => (when(a[1]) || '9999').localeCompare(when(b[1]) || '9999'));
  const past = all.filter(([, j]) => isPast(j)).sort((a, b) => when(b[1]).localeCompare(when(a[1])));
  const item = ([id, j]) => {
    const s = jobStats(id);
    return `<div class="it ${id === curJob ? 'on' : ''}" data-id="${id}"><b>${esc(j.name || 'Untitled job')}</b> <span class="tag">${esc(j.status || 'Planned')}</span>
      <div class="s">${j.start ? esc(dateOnly(j.start)) + ' · ' : ''}${esc(clientName(j.clientId) || 'no client')} · ${esc(siteName(j.siteId) || 'no site')} · ${s.fl.length} flights, ${hrs(s.mins)} h</div></div>`;
  };
  const head = t => `<div style="padding:8px 12px 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b7a86;background:#f6f8f9">${t}</div>`;
  $('#jobList').innerHTML = all.length
    ? head(`Upcoming and current (${upcoming.length})`) + (upcoming.map(item).join('') || '<div class="empty">None planned</div>')
      + head(`Past (${past.length})`) + (past.map(item).join('') || '<div class="empty">None yet</div>')
    : '<div class="empty">No jobs yet</div>';
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
      <label>Client (who engages you)${myRole === 'owner' ? ' <span class="pill">never shown to pilots</span>' : ''}<select data-f="clientId">${sel(clients, j.clientId, '— none —')}</select></label>
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
    <div class="sub2">${jobApprovalsSection(j, curJob)}</div>
    <div class="sub2">${safetyEditor(j, curJob)}</div>
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
    </div>
    <div class="sub2"><h4>Map</h4><div id="jobMap" style="height:380px;border-radius:8px;overflow:hidden"></div><p class="muted" id="jobMapNote" style="margin-top:6px"></p></div>
    <div class="sub2" id="jobNet"></div>`;
  bindFields($('#jobEdit'), 'jobs', curJob);
  drawJobMap(j, st.fl);
  bindSafety($('#jobEdit'), curJob);
  bindJobApprovals($('#jobEdit'), j, curJob);
  renderJobNetwork(curJob);
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
// Satellite map for a job: the site boundary (KML) if there is one, the job's take-off points,
// otherwise centred on the site, or on the place in the job's name.
let jobMap = null;
async function drawJobMap(j, fl) {
  if (jobMap) { jobMap.remove(); jobMap = null; }
  if (!$('#jobMap')) return;
  const jobKey = curJob;
  jobMap = L.map('jobMap', { scrollWheelZoom: false });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18, attribution: 'Imagery © Esri' }).addTo(jobMap);
  const s = ops.sites[j.siteId], note = t => { if ($('#jobMapNote')) $('#jobMapNote').textContent = t; };
  const layers = []; let bounds = null;
  const approx = s && s.boundary && !s.areaHa;
  if (s && s.boundary) {
    const b = L.polygon(s.boundary.map(p => p.map(r => r.map(([x, y]) => [y, x]))), { color: '#ffd400', weight: 3, fillOpacity: .05, dashArray: approx ? '6 6' : null }).bindTooltip(esc(s.name || 'Site'));
    layers.push(b); bounds = b.getBounds();
  }
  const pts = fl.filter(f => f.takeoffLat != null && (f.takeoffLat || f.takeoffLon));
  for (const f of pts) layers.push(L.circleMarker([f.takeoffLat, f.takeoffLon], { radius: 4, color: '#0f6e5a', weight: 1, fillColor: '#3fd1a8', fillOpacity: .9 }).bindTooltip(`${f.flightNo || ''} · ${f.startLocal}`));
  const g = L.featureGroup(layers).addTo(jobMap);
  if (bounds) { jobMap.fitBounds(bounds.pad(0.15)); note(approx ? 'Dashed outline: approximate site area from take-off points. Load the farm KML in the Sites tab for the real boundary.' : `Site boundary from ${s.boundaryFile || 'KML'}${pts.length ? ', with take-off points' : ''}.`); return; }
  if (pts.length) { jobMap.fitBounds(g.getBounds().pad(0.3), { maxZoom: 16 }); note('No site boundary yet: showing take-off points. Load the KML in the Sites tab to add the boundary.'); return; }
  if (s && s.centroid) { jobMap.setView([s.centroid[0], s.centroid[1]], 14); note('No site boundary yet. Load the KML in the Sites tab to add it.'); return; }
  jobMap.setView([-28, 145], 4);
  // nothing to go on: look up the site or job name on the map
  const q = (s && s.name) || j.name || '';
  if (!q.trim()) { note('Choose a site, or load a KML in the Sites tab, to show where this job is.'); return; }
  note('Finding the location from the name…');
  try {
    const name = q.replace(/\s+[–-]\s+.*$/, '');
    const r = await (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=au&q=${encodeURIComponent(name)}`)).json();
    if (curJob !== jobKey || !jobMap) return;
    if (r[0]) { jobMap.setView([Number(r[0].lat), Number(r[0].lon)], 13); note(`Located from the name "${name}" (approximate). Load the KML in the Sites tab for the boundary.`); }
    else note(`Couldn't find "${name}" on the map. Choose a site or load a KML in the Sites tab.`);
  } catch { note('Choose a site, or load a KML in the Sites tab, to show where this job is.'); }
}
$('#newJob').onclick = async () => {
  const id = newId('job');
  await saveOps({ jobs: { [id]: { name: '', status: 'Planned', opType: 'VLOS', start: new Date().toISOString().slice(0, 10) } } }, 'Job created');
  curJob = id; renderJobs(); $('#jobEdit [data-f=name]')?.focus();
};
// Create jobs for past flights: one job per visit (flying days at the same place less than a week apart).
// Flights on a known site use that site. Flights with no site are grouped by take-off point (within about 5 km)
// into new places, each named after the nearest town and given an approximate site. Checked before anything is created.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = d => { const [y, m] = d.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };
function proposeJobs() {
  const free = all.filter(f => f.isFlight && !jobOf(f) && dayOf(f)).sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  const groups = {}, places = [];
  for (const f of free) {
    const sid = siteOfFlight[f.sha256];
    if (sid) { (groups['s:' + sid] ||= { siteId: sid, flights: [] }).flights.push(f); continue; }
    if (f.takeoffLat == null || (!f.takeoffLat && !f.takeoffLon)) continue;           // no GPS position: left alone
    const pt = [f.takeoffLon, f.takeoffLat];
    let pl = places.find(p => Geo.metres([p.lon, p.lat], pt) <= 5000);
    if (!pl) { pl = { idx: places.length, lat: f.takeoffLat, lon: f.takeoffLon, n: 0, points: [], name: '' }; places.push(pl); }
    pl.points.push(pt); pl.n++;
    pl.lat += (f.takeoffLat - pl.lat) / pl.n; pl.lon += (f.takeoffLon - pl.lon) / pl.n;     // running centre
    (groups['p:' + pl.idx] ||= { place: pl, flights: [] }).flights.push(f);
  }
  const out = [];
  for (const g of Object.values(groups)) {
    let cur = null;
    for (const f of g.flights) {
      const d = dayOf(f);
      if (cur && (Date.parse(d) - Date.parse(cur.end)) / 864e5 < 7) { cur.end = d; cur.flights.push(f); continue; }
      cur = { siteId: g.siteId || '', place: g.place || null, start: d, end: d, flights: [f] }; out.push(cur);
    }
  }
  for (const p of out) {
    p.mins = p.flights.reduce((s, f) => s + (f.durationMin || 0), 0);
    p.days = new Set(p.flights.map(dayOf)).size;
  }
  return { props: out.sort((a, b) => b.start.localeCompare(a.start)), places };
}
$('#jobsFromSites').onclick = async () => {
  curJob = null; renderJobList();
  const { props, places } = proposeJobs();
  const noPos = all.filter(f => f.isFlight && !jobOf(f) && !siteOfFlight[f.sha256] && (f.takeoffLat == null || (!f.takeoffLat && !f.takeoffLon))).length;
  const placeLabel = pl => pl.name ? `Near ${pl.name}` : `Near ${num(pl.lat, 2)}, ${num(pl.lon, 2)}`;
  const label = p => p.place ? placeLabel(p.place) : siteName(p.siteId);
  // "Near X – Mar 2026", or the start date when there's more than one visit to the same place that month
  const defName = p => label(p) + ' – ' + (props.filter(q => label(q) === label(p) && monthYear(q.start) === monthYear(p.start)).length > 1 ? dateOnly(p.start) : monthYear(p.start));
  const edited = new Set();
  const el = $('#jobEdit');
  el.innerHTML = `<h2>Create jobs for past flights</h2>
    <p class="muted">Flights that aren't in a job yet, grouped into one job per visit (flying days at the same place less than a week apart count as one visit). Flights on one of your sites use that site. Flights with no site are grouped by where they took off, named after the nearest town, and given a new site (an approximate circle - you can load the farm KML later). Untick any you don't want, change names if you like, then create.</p>
    ${props.length ? `<p id="jfsLook" class="muted"></p><table><tr><th></th><th>Job name</th><th>Site</th><th>Dates</th><th class="n">Days</th><th class="n">Flights</th><th class="n">Hours</th></tr>
    ${props.map((p, i) => `<tr><td><input type="checkbox" data-p="${i}" checked></td><td><input data-name="${i}" value="${esc(defName(p))}" style="width:100%;font:inherit;padding:3px"></td>
      <td data-site="${i}">${p.place ? '<span class="pill">new</span> ' + esc(label(p)) : esc(label(p))}</td>
      <td>${dateOnly(p.start)}${p.end !== p.start ? ' – ' + dateOnly(p.end) : ''}</td><td class="n">${p.days}</td><td class="n">${p.flights.length}</td><td class="n">${hrs(p.mins)}</td></tr>`).join('')}</table>
    <p><button class="btn" id="jfsGo">Create ticked jobs</button> <button class="btn ghost" id="jfsCancel">Cancel</button></p>`
    : '<p>Nothing to do: every flight is already in a job.</p>'}
    ${noPos ? `<p class="muted">${noPos} flight${noPos === 1 ? ' has' : 's have'} no GPS position, so ${noPos === 1 ? 'it is' : 'they are'} left as ${noPos === 1 ? 'it is' : 'they are'}. Add ${noPos === 1 ? 'it' : 'them'} to a job by hand if needed.</p>` : ''}`;
  if (!props.length) return;
  el.querySelectorAll('[data-name]').forEach(x => x.addEventListener('input', () => edited.add(x.dataset.name)));
  $('#jfsCancel').onclick = () => renderJobEdit();
  // look up the nearest town for each new place (one a second), filling names in as they arrive
  let looking = true;
  (async () => {
    for (const [n, pl] of places.entries()) {
      if (!looking) return;
      if ($('#jfsLook')) $('#jfsLook').textContent = `Looking up place names… ${n + 1} of ${places.length}`;
      try { pl.name = (await (await fetch(`api/near?lat=${pl.lat}&lon=${pl.lon}`)).json()).name || ''; } catch { }
      props.forEach((p, i) => {
        if (p.place !== pl) return;
        const inp = el.querySelector(`[data-name="${i}"]`), cell = el.querySelector(`[data-site="${i}"]`);
        if (inp && !edited.has(String(i))) inp.value = defName(p);
        if (cell) cell.innerHTML = '<span class="pill">new</span> ' + esc(label(p));
      });
    }
    if ($('#jfsLook')) $('#jfsLook').textContent = '';
  })();
  $('#jfsGo').onclick = async () => {
    looking = false;
    const ticked = [...el.querySelectorAll('[data-p]')].filter(cb => cb.checked).map(cb => ({ p: props[cb.dataset.p], name: el.querySelector(`[data-name="${cb.dataset.p}"]`).value.trim() }));
    if (!ticked.length) return toast('Nothing ticked');
    $('#jfsGo').disabled = true; $('#jfsGo').textContent = 'Creating… please wait';
    // 1. new sites for the new places that are used
    const newSites = [];
    for (const pl of new Set(ticked.map(t => t.p.place).filter(Boolean))) {
      pl.siteId = newId(placeLabel(pl));
      newSites.push({ id: pl.siteId, name: placeLabel(pl), points: pl.points });
    }
    if (newSites.length) {
      try {
        const r = await fetch('api/sites-from-points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sites: newSites }) });
        if (!r.ok) throw new Error(await r.text());
        setOps(await r.json());
      } catch (e) { toast('Could not create the sites - is the logbook window still open?'); $('#jfsGo').disabled = false; $('#jfsGo').textContent = 'Create ticked jobs'; return; }
    }
    // 2. the jobs, with their flights
    const jobs = {}, flightJob = {};
    for (const { p, name } of ticked) {
      const siteId = p.place ? p.place.siteId : p.siteId, nm = name || defName(p);
      const id = newId(nm);
      jobs[id] = { name: nm, siteId, start: p.start, end: p.end, status: 'Flown', opType: 'VLOS' };
      for (const f of p.flights) flightJob[f.sha256] = id;
    }
    const n = Object.keys(jobs).length;
    if (await saveOps({ jobs, flightJob }, `Created ${n} job${n === 1 ? '' : 's'}${newSites.length ? ` and ${newSites.length} site${newSites.length === 1 ? '' : 's'}` : ''}, ${Object.keys(flightJob).length} flights added`)) {
      renderJobs(); renderFlights(); if (typeof renderSites === 'function') renderSites();
    } else { $('#jfsGo').disabled = false; $('#jfsGo').textContent = 'Create ticked jobs'; }
  };
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
    <div class="s">${s.areaHa ? num(s.areaHa, 1) + ' ha' : s.boundary ? 'approximate boundary' : 'no boundary yet'} · ${counts[id] || 0} flights${s.airspace ? ' · airspace checked' : ''}</div></div>`).join('')
    || '<div class="empty">No sites yet</div>';
  $('#siteList').querySelectorAll('.it').forEach(el => el.onclick = () => { curSite = el.dataset.id; renderSites(); });
  if (myRole === 'owner') towerStatus();
}
// Owner only: when the monthly controlled-aerodrome comparison last ran and what it found.
let towerShown = false;
async function towerStatus() {
  let el = $('#towerStatus');
  if (!el) { el = document.createElement('div'); el.id = 'towerStatus'; el.style.cssText = 'padding:8px 14px;font-size:12.5px;color:var(--muted);border-top:1px solid var(--line)'; $('#siteList').after(el); }
  if (towerShown) return; towerShown = true;
  const t = await fetch('api/towercheck').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  el.innerHTML = !t.at ? 'Controlled aerodrome check: not run yet (it runs a few minutes after the app starts, then monthly).'
    : `Controlled aerodrome check: last run ${new Date(t.at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}, `
      + (t.diffs?.length ? `<b style="color:#7a1810">${t.diffs.length} difference${t.diffs.length === 1 ? '' : 's'} to check</b> (emailed to you):<ul style="margin:4px 0 0 16px;padding:0">${t.diffs.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : '<b style="color:#0b4d3f">no differences found</b>.');
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
// A plain verdict for a site: does flying here look like it needs an approval? (OpenAIP data - preliminary)
const NM3 = 5556;                                             // 3 nautical miles in metres

const OFFICIAL = 'This is a preliminary check from community-maintained OpenAIP data, not official data. Confirm it against official Airservices Australia data (for example in Airservices’ OpenSky app or another CASA-verified drone safety app) and check NOTAMs before flying.';
function airspaceVerdict(s) {
  if (!s?.boundary || !s.airspace) return null;
  const rep = airspaceReport(s), hi = [], md = [], care = [];      // care = no approval needed, but take care
  for (const a of rep.over) {
    const [k, t] = severity(a), what = `${a.name} (${ASP_TYPE[a.type] || 'airspace'}${ICAO[a.icaoClass] ? ', class ' + ICAO[a.icaoClass] : ''}, ${fmtLimit(a.lower)} – ${fmtLimit(a.upper)}${a.byNotam ? ', activated by NOTAM' : ''})`;
    if (k === 'hi') hi.push(`The site is inside ${what}. An approval or permission is needed to fly here.`);
    else if (t === 'Check base') md.push(`The site is under ${what}. Check the base against the ground height here: if it's within 400 ft of the ground, an approval is needed.`);
    else if (t === 'Caution' && a.type === 13) care.push(`The site is inside ${what}. This is a CTAF area around a non-controlled aerodrome, not controlled airspace, so no approval is needed for it; keep clear of crewed aircraft.`);
    else if (t === 'Caution') md.push(`The site is inside ${what}. Check what applies here.`);
  }
  for (const a of rep.apts.filter(x => x.dist <= NM3)) {
    const name = `${a.name}${a.icao ? ' (' + a.icao + ')' : ''}`, km = num(a.dist / 1000, 1), ctl = Controlled.check(a, s.airspace.airspaces, Geo)?.by;
    if (ctl) hi.push(`${name} is ${km} km away, within 3 NM, and is a controlled aerodrome (${ctl}). An approval or authorisation is needed to fly within 3 NM of it.`);
    else care.push(`${name} is ${km} km away, within 3 NM. It isn't a controlled aerodrome, so no approval is needed for that, but stay out of its approach and departure paths and movement area, and keep clear of crewed aircraft.`);
  }
  return { level: hi.length ? 'hi' : md.length ? 'md' : care.length ? 'care' : 'ok', lines: [...hi, ...md, ...care], fetched: rep.fetched };
}
function verdictBox(v, short) {
  if (!v) return '';
  const head = v.level === 'hi' ? '⚠ Approval likely needed' : v.level === 'md' ? '⚠ Check before flying - an approval may be needed' : v.level === 'care' ? 'No approval needed, but take care near the aerodrome' : '✓ No airspace or aerodrome issues found';
  const bg = v.level === 'hi' ? '#fbe1df;color:#7a1810' : v.level === 'md' || v.level === 'care' ? 'var(--warn-soft);color:#7a3e00' : 'var(--accent-soft);color:#0b4d3f';
  return `<div style="margin:6px 0 10px;padding:10px 12px;border-radius:6px;background:${bg};font-size:13px"><b>${head}</b>
    ${v.lines.length ? `<ul style="margin:4px 0 0 18px;padding:0">${v.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    <div style="margin-top:6px;font-size:12.5px"><b>Needs confirming:</b> ${esc(OFFICIAL)}${short ? '' : ` Checked ${new Date(v.fetched).toLocaleDateString('en-AU')}.`}</div></div>`;
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
    ${s.boundary ? `<div class="facts"><div><b>${s.areaHa ? num(s.areaHa, 1) + ' ha' : 'approx.'}</b>${s.areaHa ? 'area inside boundary' : 'circle round take-offs - load the farm KML'}</div>
        <div><b>${num(s.centroid[0], 5)}, ${num(s.centroid[1], 5)}</b>centre</div>
        <div><a class="btn ghost" href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps</a></div>
        <div class="muted" style="align-self:end">from ${esc(s.boundaryFile || 'KML')}</div></div>` : ''}
    <div class="drop" id="kmlDrop">${s.boundary ? 'Replace the boundary: drop' : 'Drop'} a Google Earth <b>KML or KMZ</b> of the farm boundary here, or click to choose one
      <input type="file" id="kmlFile" accept=".kml,.kmz" hidden></div>
    <div id="siteMap"></div>
    <div class="sub2">
      <h4>Airspace <button class="btn sm" id="aspBtn" ${!s.boundary ? 'disabled' : ''}>${s.airspace ? 'Re-check airspace' : 'Check airspace'}</button></h4>
      ${s.airspace && s.boundary ? verdictBox(airspaceVerdict(s)) : `<div class="warnbox" style="margin:6px 0 10px"><b>Preliminary check only.</b> ${esc(OFFICIAL)}</div>`}
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
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18, attribution: 'Imagery © Esri · Airspace © openAIP' }).addTo(siteMap);
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
  $('#impDji').innerHTML = j.dji ? '' : '<p class="pill warn" style="display:block;padding:8px 10px">No DJI developer key yet, so flights are logged without GPS tracks or battery data. ' + (j.owner ? 'Add it under Settings below.' : 'Please let Aspex know.') + '</p>';
  $('#impLog').textContent = j.uploads.length ? 'Recent imports:\n' + j.uploads.slice(0, 25).map(u => `  ${ago(u.at).padEnd(11)} ${u.file}  ${u.status}${u.track ? ' · ' + u.track : ''}  (${u.via})`).join('\n') + '\n' : '';
  const s = await (await fetch('api/settings')).json();
  $('#impKeyRow').hidden = s.role !== 'owner';   // only the owner (Aspex) sees and sets the DJI key
  $('#impKeyHint').textContent = s.dji ? `key saved (ends ${s.djiHint})` : 'not set';
  $('#skyKeyHint').textContent = s.skydio ? `token saved (ends ${s.skydioHint})` : 'not set';
  $('#skySync').disabled = !s.skydio;
  $('#skyHint').textContent = !s.skydio ? 'Add your Skydio Cloud token under Settings below first.'
    : s.skydioSyncedAt ? `Last synced ${ago(s.skydioSyncedAt)}${s.skydioLast ? `: ${s.skydioLast.found} flights in Skydio Cloud, ${s.skydioLast.added} new` : ''}.` : 'Not synced yet.';
}
$('#skyKeySave').onclick = async () => {
  const v = $('#skyKey').value.trim(); if (!v) return;
  await fetch('api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skydioToken: v }) });
  $('#skyKey').value = ''; toast('Skydio token saved'); impRefresh();
};
$('#skySync').onclick = async () => {
  $('#skySync').disabled = true; $('#skySync').textContent = 'Syncing…';
  impWrite('Fetching flights from Skydio Cloud…');
  try {
    const r = await fetch('api/skydio/sync', { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    const o = await r.json();
    impWrite(`Skydio Cloud: ${o.found} flights found, ${o.added} new, ${o.updated} already in the logbook${o.skipped ? `, ${o.skipped} skipped (no take-off time)` : ''}. ${o.tracks} GPS tracks fetched.`);
    if (o.telemetryError) impWrite(o.telemetryError);
    if (o.mediaError) impWrite(o.mediaError);
    await load();
  } catch (e) { impWrite('Skydio sync failed: ' + e.message); }
  $('#skySync').textContent = 'Sync Skydio flights'; impRefresh();
};
$('#importBtn').onclick = () => { $('#impModal').hidden = false; impRefresh(); };
$('#impClose').onclick = () => { $('#impModal').hidden = true; };
async function impUpload(files) {
  const bb3 = [...files].filter(f => /\.bb3$/i.test(f.name));
  files = [...files].filter(f => /\.txt$/i.test(f.name));
  if (!files.length && !bb3.length) return toast('Choose DJIFlightRecord_….txt files, or an eBee flight’s .bb3 files');
  $('#impLog').textContent = '';
  if (bb3.length) await ebeeUpload(bb3);
  if (!files.length) { impWrite('Done.'); return load(); }
  try {                                  // don't upload flights the logbook already has in full
    const skip = new Set((await (await fetch('api/import/skip')).json()).skip || []);
    const before = files.length;
    files = files.filter(f => !skip.has(f.name));
    if (before > files.length) impWrite(`${before - files.length} file${before - files.length > 1 ? 's' : ''} already in the logbook - skipped.`);
    if (!files.length) { impWrite('Done.'); return load(); }
  } catch {}
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
// eBee: join each flight's .bb3 parts in order, read the GPS fixes here, send ~1 per second.
async function ebeeUpload(list) {
  const groups = {};
  for (const f of list) {
    const n = BB3.nameInfo(f.name);
    if (!n) { impWrite(`${f.name}  not an eBee log part (expected …_0072_part001.bb3)`); continue; }
    (groups[n.base] ||= []).push([n.part, f]);
  }
  for (const [base, parts] of Object.entries(groups)) {
    parts.sort((a, b) => a[0] - b[0]);
    const nums = parts.map(p => p[0]), missing = [];
    for (let k = 1; k <= Math.max(...nums); k++) if (!nums.includes(k)) missing.push(k);
    if (missing.length) { impWrite(`eBee ${base}: missing part ${missing.join(', ')}. Add all the parts of the flight and try again.`); continue; }
    try {
      impWrite(`eBee ${base}: reading ${parts.length} part${parts.length > 1 ? 's' : ''}…`);
      const bufs = await Promise.all(parts.map(p => p[1].arrayBuffer()));
      const all = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0));
      let o = 0; for (const b of bufs) { all.set(new Uint8Array(b), o); o += b.byteLength; }
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map(x => x.toString(16).padStart(2, '0')).join('');
      const fixes = BB3.thin(BB3.fixes(all)).map(f => [f[0], +f[1].toFixed(7), +f[2].toFixed(7), +f[3].toFixed(2), +f[4].toFixed(2)]);
      if (!fixes.length) { impWrite(`eBee ${base}: no GPS positions found in these files.`); continue; }
      const r = await fetch('api/upload-ebee', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: base, sha256: sha, bytes: all.length, parts: parts.length, fixes }) });
      impWrite(`eBee ${base}  ${r.ok ? (await r.json()).summary : await r.text()}`);
    } catch (e) { impWrite(`eBee ${base}  FAILED: ${e.message}`); }
  }
}
// Drone Logbook CSV exports: preview, then import on request.
let dlbTexts = null;
$('#dlbFiles').onchange = async (e) => {
  const out = $('#dlbOut'); out.innerHTML = '<p class="muted">Reading…</p>';
  try {
    dlbTexts = await Promise.all([...e.target.files].map(f => f.text()));
    const r = await fetch('api/dlb/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: dlbTexts }) });
    if (!r.ok) { out.innerHTML = `<p style="color:#a12a1e">${esc(await r.text())}</p>`; return; }
    const p = await r.json();
    const miss = ['drones', 'batteries'].filter(k => !p.have.includes(k));
    out.innerHTML = `
      <p style="margin:8px 0 4px"><b>${p.counts.new}</b> new flights to import · <b>${p.counts.skip}</b> already in this logbook (skipped) · <b>${p.counts.check}</b> need checking (not imported)</p>
      <p class="muted" style="margin:0 0 6px">${p.offsetMin ? `Drone Logbook's clock is ${Math.abs(p.offsetMin)} min ${p.offsetMin > 0 ? 'ahead of' : 'behind'} your flight files (measured from ${p.matchedForClock} flights in both); imported times are corrected.` : p.matchedForClock ? 'Drone Logbook times match your flight files.' : 'No flights in both to compare clocks, so times are used as they are.'}
      ${miss.length ? ` <b>Missing ${miss.join(' and ')} export</b> – aircraft/battery names will be codes.` : ''}${p.have.includes('locations') ? '' : ' No Locations export, so old flights will have no site.'}</p>
      <table><tr><th>Aircraft</th><th class="n">New</th><th class="n">Already here</th><th class="n">Check</th></tr>
      ${Object.entries(p.byAircraft).map(([a, c]) => `<tr><td>${esc(a)}</td><td class="n">${c.new}</td><td class="n">${c.skip}</td><td class="n">${c.check}</td></tr>`).join('')}</table>
      ${p.rows.some(x => x.status === 'check') ? `<p class="muted">Not imported: ${p.rows.filter(x => x.status === 'check').map(x => `${esc(x.aircraft)} ${esc(x.when)} (${esc(x.why)})`).join('; ')}</p>` : ''}
      <details><summary>List every flight</summary><table>${p.rows.map(x => `<tr><td>${esc(x.when)}</td><td>${esc(x.aircraft)}</td><td class="n">${x.minutes} min</td><td>${esc(x.battery)}</td><td>${x.status === 'new' ? '<b>new</b>' : esc(x.why)}</td></tr>`).join('')}</table></details>
      ${p.counts.new ? `<p><button class="btn" id="dlbGo">Import ${p.counts.new} new flight${p.counts.new > 1 ? 's' : ''}</button></p>` : '<p>Nothing new to import.</p>'}`;
    const go = $('#dlbGo');
    if (go) go.onclick = async () => {
      go.disabled = true; go.textContent = 'Importing…';
      const r2 = await fetch('api/dlb/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: dlbTexts }) });
      const d = r2.ok ? await r2.json() : null;
      out.innerHTML = d ? `<p><b>Imported ${d.imported} flight${d.imported === 1 ? '' : 's'}</b> from Drone Logbook.</p>` : `<p style="color:#a12a1e">${esc(await r2.text())}</p>`;
      e.target.value = ''; load();
    };
  } catch (err) { out.innerHTML = `<p style="color:#a12a1e">${esc(err.message)}</p>`; }
};
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
    myRole = me.role;
    await loadAspexJobs();
    if (me.role !== 'owner') for (const id of ['jobs', 'sites']) { const b = document.querySelector(`nav.tabs button[data-v=${id}]`); if (b) b.textContent = id === 'jobs' ? 'My jobs' : 'My sites'; }
  } catch {}
  load();
})();
