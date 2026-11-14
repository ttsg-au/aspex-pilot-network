// Job pack: one printable page per job (Print / Save as PDF) with what's needed on site - the site map
// and location, the airspace check, approvals and their conditions, safety requirements, site contact
// and capture settings. Approval documents stay separate files; the pack lists them with links.
// Shares globals with the main page (esc, dateOnly, num, ops, airspaceVerdict, verdictBox, SAFETY...).

// Your own job -> pack data. Clients are included (it's your pack); private job notes are not.
function packFromJob(key) {
  const j = ops.jobs[key] || {}, s = ops.sites[j.siteId];
  return {
    title: j.name || 'Untitled job', start: j.start, end: j.end, status: j.status,
    client: ops.clients[j.clientId]?.name || '',
    site: s, safety: j.safety, safetyNotes: j.safetyNotes, contactName: j.siteContactName, contactPhone: j.siteContactPhone,
    swmsUrl: j.swmsUrl, capture: j.capture, approvalRequired: j.approvalRequired === '1', approvalNote: j.approvalNote,
    approvals: apFor(key).map(([id, a]) => ({ ...a, docUrl: a.docFile ? `api/approvals/${encodeURIComponent(id)}/doc` : '', covers: apCovers(a, j), mismatch: j.siteId ? apMismatch(a, j.siteId) : '' })),
  };
}
// An Aspex job (pilot view) -> pack data. No client, as on the job itself.
function packFromAspex(j) {
  return {
    title: j.name, start: j.start, end: j.end, status: j.status, aspex: true, site: j.site,
    safety: j.safety, safetyNotes: j.safetyNotes, contactName: j.siteContactName, contactPhone: j.siteContactPhone,
    swmsUrl: j.swmsUrl, capture: j.capture, approvalRequired: j.approvalRequired, approvalNote: j.approvalNote,
    approvals: (j.approvals || []).map(a => ({ ...a, docFile: !!a.docName,
      docUrl: a.docName ? (a.from === 'Aspex' ? `api/aspex-jobs/${encodeURIComponent(j.key)}/approval/${encodeURIComponent(a.key)}/doc` : `api/approvals/${encodeURIComponent(a.key)}/doc`) : '' })),
  };
}

let packMap = null;
function openJobPack(p) {
  let el = $('#pack');
  if (!el) {
    el = document.createElement('div'); el.id = 'pack'; document.body.appendChild(el);
    const st = document.createElement('style');
    st.textContent = `#pack{position:fixed;inset:0;z-index:3000;background:#fff;overflow:auto;color:#14202a}
      #pack .pk{max-width:820px;margin:0 auto;padding:20px 24px 40px;font-size:13.5px;line-height:1.45}
      #pack .bar{position:sticky;top:0;background:#14202a;color:#fff;padding:10px 16px;display:flex;gap:10px;align-items:center;z-index:2}
      #pack h1{font-size:22px;margin:4px 0 2px} #pack h2{font-size:15px;margin:18px 0 6px;padding-bottom:3px;border-bottom:2px solid #0f6e5a;color:#0f6e5a}
      #pack table{width:100%;border-collapse:collapse} #pack td,#pack th{border:1px solid #d5dde2;padding:5px 7px;vertical-align:top;text-align:left}
      #pack th{background:#f2f5f6;width:30%} #pack .muted{color:#5d6b75} #pack #packMap{height:330px;border:1px solid #d5dde2;margin-top:6px}
      #pack .sic{display:inline-block;margin:2px 10px 2px 0} #pack a{color:#0f6e5a}
      @media print{body>*:not(#pack){display:none!important} #pack{position:static;overflow:visible} #pack .bar{display:none}
        #pack .pk{padding:0;max-width:none} #pack h2{break-after:avoid} #pack table,#pack .keep{break-inside:avoid} @page{margin:14mm}}`;
    document.head.appendChild(st);
  }
  const s = p.site, v = s?.boundary && s.airspace ? airspaceVerdict(s) : null;
  const dates = p.start ? dateOnly(p.start) + (p.end && p.end !== p.start ? ' – ' + dateOnly(p.end) : '') : 'dates not set';
  const ll = s?.centroid ? `${num(s.centroid[0], 5)}, ${num(s.centroid[1], 5)}` : '';
  const safety = (p.safety || '').split('|').map(k => SAFETY.find(x => x[0] === k)).filter(Boolean);
  const abs = (u) => new URL(u, location.href).href;
  el.innerHTML = `<div class="bar"><b style="flex:1">Job pack</b>
      <button class="btn sm" id="packPrint">Print / Save as PDF</button><button class="btn sm ghost" id="packClose" style="color:#fff;border-color:#fff">Close</button></div>
    <div class="pk">
      <div class="muted">${p.aspex ? 'Aspex Drone Services · ' : ''}Job pack · prepared ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
      <h1>${esc(p.title)}</h1>
      <div>${esc(dates)}${p.client ? ' · ' + esc(p.client) : ''}${p.status ? ' · ' + esc(p.status) : ''}</div>

      <h2>Site</h2>
      ${s ? `<table><tr><th>Site</th><td>${esc(s.name || 'Untitled site')}${s.areaHa ? ` (${num(s.areaHa, 1)} ha)` : ''}</td></tr>
        ${ll ? `<tr><th>Centre of site</th><td>${ll} · <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ll.replace(/\s/g, ''))}">open in Google Maps</a></td></tr>` : ''}
        ${p.contactName || p.contactPhone ? `<tr><th>Site contact</th><td>${esc(p.contactName || '')} ${esc(p.contactPhone || '')}</td></tr>` : ''}</table>
        ${s.boundary ? '<div id="packMap"></div>' : '<p class="muted">No site boundary loaded.</p>'}` : '<p class="muted">No site set for this job.</p>'}

      <h2>Airspace</h2>
      <div class="keep">${v ? verdictBox(v) : `<p class="muted">The site's airspace hasn't been checked. Check it in a CASA-verified drone safety app (for example Airservices' OpenSky) and check NOTAMs before flying.</p>`}</div>

      <h2>Approvals and permissions</h2>
      ${p.approvalRequired ? `<p><b>This job needs an approval or permission${p.approvalNote ? ': ' + esc(p.approvalNote) : ''}.</b></p>` : ''}
      ${p.approvals.length ? p.approvals.map(a => `<table class="keep" style="margin-bottom:8px">
          <tr><th>Approval</th><td><b>${esc(a.title || a.type || 'Approval')}</b>${a.type && a.title ? `<div class="muted">${esc(a.type)}</div>` : ''}</td></tr>
          ${a.authority || a.ref ? `<tr><th>Issued by / reference</th><td>${esc(a.authority || '–')}${a.ref ? ' · ' + esc(a.ref) : ''}</td></tr>` : ''}
          ${a.mismatch ? `<tr><th>Check</th><td style="color:#7a3e00">⚠ ${esc(a.mismatch)}</td></tr>` : ''}
          <tr><th>Valid</th><td>${esc(apDates(a))}${a.covers === false ? ' <b style="color:#b3261e">- doesn’t cover the job dates</b>' : ''}</td></tr>
          ${a.heightFt || a.area ? `<tr><th>Height and area</th><td>${a.heightFt ? 'Max ' + esc(a.heightFt) + ' ft AGL' : ''}${a.heightFt && a.area ? ' · ' : ''}${esc(a.area || '')}</td></tr>` : ''}
          ${a.conditions ? `<tr><th>Conditions</th><td style="white-space:pre-wrap">${esc(a.conditions)}</td></tr>` : ''}
          <tr><th>Document</th><td>${a.docUrl ? `<a href="${esc(abs(a.docUrl))}">${esc(a.docName || 'Open the approval')}</a> <span class="muted">(carry a copy on site)</span>` : '<span class="muted">none attached</span>'}</td></tr></table>`).join('')
        : `<p class="muted">${p.approvalRequired ? 'None linked yet.' : 'None needed or linked.'}</p>`}

      <h2>Safety on site</h2>
      ${p.swmsUrl ? `<p>Site SWMS: <a href="${esc(p.swmsUrl)}">${esc(p.swmsUrl)}</a></p>` : ''}
      ${safety.length ? `<div>${safety.map(x => `<span class="sic">${x[1]} ${esc(x[2])}</span>`).join('')}</div>` : '<p class="muted">No site requirements listed.</p>'}
      ${p.safetyNotes ? `<p style="white-space:pre-wrap">${esc(p.safetyNotes)}</p>` : ''}

      ${p.capture ? `<h2>Capture settings</h2><p style="white-space:pre-wrap">${esc(p.capture)}</p>` : ''}

      <h2>Before flying</h2>
      <ul style="margin:0;padding-left:18px">
        <li>Confirm the airspace against official Airservices data (for example in OpenSky) and check NOTAMs for the day.</li>
        <li>Carry this pack and any approval documents, and follow every approval condition.</li>
        <li>Complete your own aircraft and pre-flight checklists.</li>
      </ul>
    </div>`;
  el.hidden = false;
  $('#packClose').onclick = () => { el.hidden = true; el.innerHTML = ''; packMap?.remove(); packMap = null; };
  $('#packPrint').onclick = () => window.print();
  if (s?.boundary && window.L) {
    packMap?.remove();
    packMap = L.map('packMap', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 18, attribution: 'Imagery © Esri' }).addTo(packMap);
    const shape = L.polygon(s.boundary.map(poly => poly.map(r => r.map(([x, y]) => [y, x]))), { color: '#ffb000', weight: 3, fillOpacity: 0.08 }).addTo(packMap);
    packMap.fitBounds(shape.getBounds(), { padding: [20, 20] });
  }
}
