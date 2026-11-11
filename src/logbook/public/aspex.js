// Aspex jobs shared with network pilots.
// Pilots: an "Aspex jobs" tab with each job they're assigned to (acknowledge, documents, own checks, flights).
// Aspex (owner): a "Network pilots" section on each job, with their acknowledgments, checks and flights.
// Shares globals with the main page script ($, esc, num, hrs, toast, dateOnly, timeOnly, model, L...).

let aspexJobs = [], myRole = '';

async function loadAspexJobs() {
  try { aspexJobs = (await (await fetch('api/aspex-jobs')).json()).jobs || []; } catch { aspexJobs = []; }
  const btn = document.querySelector('nav.tabs button[data-v=aspex]');
  if (btn) btn.hidden = !aspexJobs.length;
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const fmtRange = (a, b) => a ? `${dateOnly(a)}${b && b !== a ? ' – ' + dateOnly(b) : ''}` : 'dates to be confirmed';
const daysOf = j => {
  const set = new Set(j.flights.map(f => f.startLocal.slice(0, 10)));
  if (j.start) for (let d = j.start; d <= (j.end || j.start) && set.size < 60; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) set.add(d);
  return [...set].sort();
};

// ---------- pilot: Aspex jobs tab ----------
function renderAspex() {
  const v = $('#v-aspex');
  v.innerHTML = aspexJobs.map((j, i) => {
    const p = j.progress || {}, acked = !!p.ackAt;
    const flights = j.flights || [], mins = flights.reduce((s, f) => s + (f.durationMin || 0), 0);
    return `<div class="panel aj" data-i="${i}" style="margin-bottom:14px">
      <h2>${esc(j.name || 'Aspex job')} <span class="hint">${fmtRange(j.start, j.end)}${j.site ? ' · ' + esc(j.site.name || '') + (j.site.areaHa ? ` (${num(j.site.areaHa, 0)} ha)` : '') : ''}</span>
        ${p.completeAt ? '<span class="pill ok">Flying complete</span>' : acked ? '<span class="pill">Accepted</span>' : '<span class="pill warn">Please read and accept</span>'}</h2>
      <div style="padding:12px 14px">
        <div class="basis"><b>Operating basis: ${esc(j.basis.label)}.</b> ${esc(j.basis.text)}</div>
        ${acked ? `<p class="muted" style="margin:8px 0 0">You accepted this on ${dateOnly(p.ackAt)}.</p>` : `
          <div class="acks">${j.basis.acks.map((a, k) => `<label><input type="checkbox" data-ack="${k}"> ${esc(a)}</label>`).join('')}</div>
          ${j.swmsUrl ? `<p><a class="btn sm ghost" href="${esc(j.swmsUrl)}" target="_blank" rel="noopener">Open the site SWMS</a></p>` : '<p class="pill warn">The SWMS hasn’t been attached yet - Aspex will add it.</p>'}
          <button class="btn" data-accept>Accept this job</button>`}
      </div>
      ${acked ? `<div class="form2" style="padding:0 14px 12px">
          <div><b>Documents and data</b><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
            ${j.swmsUrl ? `<a class="btn sm" href="${esc(j.swmsUrl)}" target="_blank" rel="noopener">Site SWMS (applies on site)</a>` : ''}
            ${j.dropboxUrl ? `<a class="btn sm ghost" href="${esc(j.dropboxUrl)}" target="_blank" rel="noopener">Dropbox job folder</a>` : ''}
            ${j.site?.boundary ? `<a class="btn sm ghost" href="aspex-jobs/${encodeURIComponent(j.key)}/site.kml">Site boundary (KML)</a>` : ''}</div></div>
          <div><b>Aspex capture settings</b><div class="muted" style="white-space:pre-wrap;margin-top:6px">${esc(j.capture || 'None given - see the job folder.')}</div></div>
        </div>
        <div style="padding:0 14px 12px"><b>Your own pre-flight checks</b> <span class="muted">- your aircraft and operational checklists are your own; tick each day you completed them</span>
          <div class="days">${daysOf(j).map(d => `<label><input type="checkbox" data-day="${d}"${p.days?.[d] ? ' checked' : ''}> ${dateOnly(d)}</label>`).join('')}</div></div>
        <div style="padding:0 14px 12px"><b>Your flights on this job - ${flights.length} flights, ${hrs(mins)} h</b>
          <span class="muted">(shared with Aspex: take-off on this site during the job)</span>
          <table class="sum">${flights.map(f => `<tr><td>${dateOnly(f.startLocal)} ${timeOnly(f.startLocal)}</td><td>${esc(f.flightNo || '')}</td><td>${esc(model(f.aircraftModel))}</td>
            <td class="n">${num(f.durationMin, 1)} min</td><td>${f.serviceable === 'no' ? '<span class="pill bad">Defect</span> ' + esc(f.defect || '') : ''}</td></tr>`).join('') || '<tr><td class="muted">None yet - they appear here after you import them.</td></tr>'}</table>
          ${p.completeAt ? `<p class="muted">Marked complete ${dateOnly(p.completeAt)}. <a href="#" data-undo>Undo</a></p>` : flights.length ? '<button class="btn" data-complete>Flying complete - let Aspex know</button>' : ''}
        </div>` : ''}
    </div>`;
  }).join('') || '<div class="panel"><div class="empty">No Aspex jobs assigned to you.</div></div>';

  v.querySelectorAll('.aj').forEach(card => {
    const j = aspexJobs[card.dataset.i], url = 'api/aspex-jobs/' + encodeURIComponent(j.key);
    card.querySelector('[data-accept]')?.addEventListener('click', async () => {
      const ticks = [...card.querySelectorAll('[data-ack]')].map(c => c.checked);
      const r = await post(url + '/ack', { ticks });
      if (!r.ok) return toast(await r.text(), 2500);
      toast('Job accepted'); await loadAspexJobs(); renderAspex();
    });
    card.querySelectorAll('[data-day]').forEach(c => c.onchange = async () => {
      const r = await post(url + '/day', { date: c.dataset.day, done: c.checked });
      if (r.ok) { j.progress = await r.json(); toast('Saved'); }
    });
    card.querySelector('[data-complete]')?.addEventListener('click', async () => { await post(url + '/complete'); toast('Aspex can see this job is complete'); await loadAspexJobs(); renderAspex(); });
    card.querySelector('[data-undo]')?.addEventListener('click', async e => { e.preventDefault(); await post(url + '/complete', { undo: true }); await loadAspexJobs(); renderAspex(); });
  });
}

// ---------- owner: network pilots on a job ----------
let netJobs = null, netMap = null;
async function renderJobNetwork(key) {
  const el = $('#jobNet'); if (!el || myRole !== 'owner') return;
  const j = ops.jobs[key]; if (!j) return;
  if (!netJobs) { try { netJobs = (await (await fetch('api/network-jobs')).json()).jobs; } catch { netJobs = []; } }
  const net = j.networkJobId ? await (await fetch(`api/jobs/${encodeURIComponent(key)}/network`)).json() : { pilots: [] };
  if (curJob !== key) return;
  el.innerHTML = `<h4>Network pilots</h4>
    <div class="form" style="padding:0 0 10px">
      <label class="full">Pilot network job (pilots assigned there see this job in their logbook)
        <select id="nJob">${sel(netJobs.map(n => [n.id, `${n.title}${n.startDate ? ' · ' + dateOnly(n.startDate) : ''}`]), j.networkJobId, '— not shared —')}</select></label>
      <label class="full">Site SWMS (link to the document - applies to everyone on site)<span><div class="linkrow"><input data-n="swmsUrl" value="${esc(j.swmsUrl || '')}" placeholder="paste the SWMS link (e.g. Dropbox)"></div></span></label>
      <label class="full">Aspex capture settings for pilots<textarea data-n="capture" rows="3" placeholder="e.g. 70% forward / 30% side overlap, GSD 3.3 cm, terrain follow, max 6.7 m/s, irradiance over 600 W/m²">${esc(j.capture || '')}</textarea></label>
      <div class="muted" style="grid-column:1/-1">Operating basis: <b>Independent operator</b> - pilots fly under their own accreditation and their own checklists; the work isn't carried out under an Aspex ReOC. They must accept this, and the SWMS, before the job opens for them.<br>
        <b>What pilots see:</b> job name, dates, site name and boundary, the Dropbox folder, the SWMS and these capture settings. <b>Never shown:</b> the client, reference/PO, SiteMark link, site owner/O&amp;M, notes and your own flights.</div>
    </div>
    ${j.networkJobId ? `<table class="sum"><tr><th>Pilot</th><th>Logbook</th><th>Accepted</th><th>Own checks done</th><th class="n">Flights</th><th class="n">Hours</th><th>Defects</th><th>Complete</th></tr>
      ${net.pilots.map(p => {
        const d = p.flights.filter(f => f.serviceable === 'no');
        return `<tr><td>${esc(p.name)}</td><td>${p.hasLogbook ? (p.active ? 'Yes' : 'Invited') : '<span class="muted">No account - give logbook access from their pilot page</span>'}</td>
          <td>${p.progress.ackAt ? dateOnly(p.progress.ackAt) : '<span class="pill warn">Not yet</span>'}</td>
          <td>${Object.keys(p.progress.days || {}).sort().map(dateOnly).join(', ') || '–'}</td>
          <td class="n">${p.flights.length}</td><td class="n">${hrs(p.flights.reduce((s, f) => s + (f.durationMin || 0), 0))}</td>
          <td>${d.map(f => esc(f.defect || 'defect')).join('; ') || '–'}</td><td>${p.progress.completeAt ? dateOnly(p.progress.completeAt) : '–'}</td></tr>`;
      }).join('') || '<tr><td colspan="8" class="muted">No pilots assigned on the pilot network job yet.</td></tr>'}</table>
      ${net.pilots.some(p => p.flights.length) ? '<div id="netMap" style="height:340px;border-radius:8px;margin-top:8px"></div><div class="muted" style="font-size:12px;margin-top:4px">Pilot flight routes on this job. Click a route for details.</div>' : ''}` : ''}`;
  $('#nJob').onchange = async e => { await saveOps({ jobs: { [key]: { networkJobId: e.target.value } } }, e.target.value ? 'Shared with the pilot network job' : 'No longer shared'); renderJobNetwork(key); };
  el.querySelectorAll('[data-n]').forEach(x => x.onchange = () => saveOps({ jobs: { [key]: { [x.dataset.n]: x.value.trim() } } }));

  if ($('#netMap')) {
    if (netMap) { netMap.remove(); netMap = null; }
    netMap = L.map('netMap');
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri' }).addTo(netMap);
    const group = L.featureGroup().addTo(netMap), site = ops.sites[j.siteId];
    if (site?.boundary) for (const poly of site.boundary) L.polygon(poly.map(r => r.map(p => [p[1], p[0]])), { color: '#fff', weight: 2, fillOpacity: 0.05 }).addTo(group);
    const colours = ['#ffb000', '#00c2ff', '#ff5d8f', '#7cff6b', '#c38bff'];
    net.pilots.forEach((p, i) => p.flights.filter(f => f.track === 'ok').forEach(async f => {
      const r = await fetch(`api/jobs/${encodeURIComponent(key)}/network-track/${p.uid}/${encodeURIComponent(f.file.replace(/\.txt$/i, '') + '.txt')}`);
      if (!r.ok) return;
      const c = (await r.json()).features[0].geometry.coordinates.map(q => [q[1], q[0]]);
      L.polyline(c, { color: colours[i % colours.length], weight: 2.5 }).bindPopup(`${esc(p.name)}<br>${dateOnly(f.startLocal)} ${timeOnly(f.startLocal)}–${timeOnly(f.endLocal)}<br>${num(f.durationMin, 1)} min · max ${num(f.maxHeightM, 0)} m${f.defect ? '<br>Defect: ' + esc(f.defect) : ''}`).addTo(group);
      netMap.fitBounds(group.getBounds(), { padding: [20, 20] });
    }));
    setTimeout(() => { netMap.invalidateSize(); if (group.getLayers().length) netMap.fitBounds(group.getBounds(), { padding: [20, 20] }); }, 100);
  }
}
