// Photo coverage check for a job (pilots and owner).
// The pilot points this at the folder of photos for the job - the job folder on their SSD, or an SD card.
// Each photo is read where it sits; only its first few KB (EXIF + DJI XMP: GPS, height above take-off,
// gimbal angle, camera) are read, never the whole image, and nothing is copied to the computer.
// A few numbers per photo go to the logbook. The map then shows the site boundary, what the photos
// cover, and the gaps (red), by day and by pilot.
// Shares globals with the main page ($, esc, num, dateOnly, toast).

// ---------- Reading a photo's position block ----------
const COV_DIAG35 = 43.267;                       // 35 mm film diagonal
const COV_DFOV = { T: 50, W: 84, Z: 15, V: 84, M: 70 };   // fallback diagonal field of view (deg) when the photo doesn't say
async function covReadHead(file, bytes) { return new Uint8Array(await file.slice(0, bytes).arrayBuffer()); }

// JPEG segments -> { exif: DataView over TIFF, xmp: string }. Asks for more bytes if a segment runs past the end.
function covSegments(b) {
  const out = { exif: null, xmp: '', need: 0 };
  if (b[0] !== 0xFF || b[1] !== 0xD8) return out;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01 || m === 0xFF) { i += (m === 0xFF ? 1 : 2); continue; }
    if (m === 0xDA || m === 0xD9) break;                       // image data starts: no more metadata
    const len = (b[i + 2] << 8) | b[i + 3], start = i + 4, end = i + 2 + len;
    if (out.exif && out.xmp) break;                            // have what we need
    if (end > b.length) { out.need = end + 1024; break; }
    if (m === 0xE1) {
      const head = String.fromCharCode(...b.subarray(start, start + 29));
      if (head.startsWith('Exif\0')) out.exif = new DataView(b.buffer, b.byteOffset + start + 6, len - 8);
      else if (head.startsWith('http://ns.adobe.com/xap/1.0/')) out.xmp = new TextDecoder().decode(b.subarray(start + 29, end));
    }
    i = end;
    if (out.exif && out.xmp) break;
  }
  return out;
}
// The EXIF tags we need.
function covExif(dv) {
  const r = {}; if (!dv || dv.byteLength < 8) return r;
  const le = dv.getUint16(0) === 0x4949, u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const ascii = (o, n) => { let s = ''; for (let k = 0; k < n && o + k < dv.byteLength; k++) { const c = dv.getUint8(o + k); if (!c) break; s += String.fromCharCode(c); } return s; };
  const val = (e) => {
    const type = u16(e + 2), count = u32(e + 4), size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
    const at = size * count > 4 ? u32(e + 8) : e + 8;
    if (at + size * count > dv.byteLength) return null;
    if (type === 2) return ascii(at, count);
    if (type === 3) return u16(at);
    if (type === 4) return u32(at);
    if (type === 5) { const a = []; for (let k = 0; k < count; k++) { const d = u32(at + 8 * k + 4); a.push(d ? u32(at + 8 * k) / d : 0); } return count === 1 ? a[0] : a; }
    return null;
  };
  const ifd = (off, fn) => { if (!off || off + 2 > dv.byteLength) return; const nE = u16(off);
    for (let k = 0; k < nE; k++) { const e = off + 2 + 12 * k; if (e + 12 > dv.byteLength) break; fn(u16(e), e); } };
  let exifOff = 0, gpsOff = 0;
  ifd(u32(4), (tag, e) => { if (tag === 0x0110) r.model = val(e); else if (tag === 0x8769) exifOff = val(e); else if (tag === 0x8825) gpsOff = val(e); });
  ifd(exifOff, (tag, e) => {
    if (tag === 0x9003) r.taken = val(e); else if (tag === 0xA405) r.f35 = val(e);
    else if (tag === 0xA002) r.w = val(e); else if (tag === 0xA003) r.h = val(e);
  });
  const g = {}; ifd(gpsOff, (tag, e) => { g[tag] = val(e); });
  const dms = a => Array.isArray(a) ? a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600 : null;
  if (g[2] && g[4]) { r.lat = dms(g[2]) * (g[1] === 'S' ? -1 : 1); r.lon = dms(g[4]) * (g[3] === 'W' ? -1 : 1); }
  return r;
}
function covXmp(x, name) {
  const m = x.match(new RegExp('drone-dji:' + name + '(?:="([^"]*)"|>([^<]*)<)'));
  const v = m ? parseFloat(m[1] ?? m[2]) : NaN;
  return Number.isFinite(v) ? v : null;
}
// One photo -> { f, d, t, lat, lon, w, h, yaw, alt, off } or { skip: reason }.
async function covParsePhoto(file) {
  let b = await covReadHead(file, 65536), seg = covSegments(b);
  for (let tries = 0; seg.need && tries < 3 && seg.need <= 4194304; tries++) { b = await covReadHead(file, seg.need); seg = covSegments(b); }
  const ex = covExif(seg.exif), x = seg.xmp;
  const lat = covXmp(x, 'GpsLatitude') ?? ex.lat, lon = covXmp(x, 'GpsLongitude') ?? covXmp(x, 'GpsLongtitude') ?? ex.lon;
  if (lat == null || lon == null || (!lat && !lon)) return { skip: 'nogps' };
  const alt = covXmp(x, 'RelativeAltitude'), pitch = covXmp(x, 'GimbalPitchDegree');
  const yaw = covXmp(x, 'GimbalYawDegree') ?? covXmp(x, 'FlightYawDegree') ?? 0;
  const suffix = (file.name.match(/_([TWZVS])\.jpe?g$/i) || [])[1]?.toUpperCase();
  const W = ex.w || (suffix === 'T' ? 640 : 4000), H = ex.h || (suffix === 'T' ? 512 : 3000);
  const t = suffix === 'S' ? 'V' : suffix || ((W === 640 || W === 1280) ? 'T' : 'V');
  const f35 = ex.f35 > 3 ? ex.f35 : COV_DIAG35 / (2 * Math.tan(COV_DFOV[t] * Math.PI / 360));
  const halfDiag = COV_DIAG35 / (2 * f35), a = W / H, s = Math.sqrt(a * a + 1);
  const ok = alt != null && alt > 2;
  const fw = ok ? 2 * alt * halfDiag * a / s : 0, fh = ok ? 2 * alt * halfDiag / s : 0;
  const d = (ex.taken || '').replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').slice(0, 19)
    || new Date(file.lastModified).toLocaleString('sv-SE').slice(0, 19);
  return { f: file.name, d, t, lat, lon, w: Math.max(0.5, fw), h: Math.max(0.5, fh), yaw, alt,
    off: !ok || pitch == null || pitch > -75 ? 1 : 0 };
}

// Files from a dropped folder (recursively) or a folder picker.
async function covFilesFromDrop(dt) {
  const out = [], entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  const walk = (e) => new Promise(res => {
    if (e.isFile) return e.file(f => { out.push(f); res(); }, () => res());
    const r = e.createReader(), all = [];
    const more = () => r.readEntries(async es => { if (!es.length) { for (const c of all) await walk(c); return res(); } all.push(...es); more(); }, () => res());
    more();
  });
  for (const e of entries) await walk(e);
  out.folder = entries.length === 1 ? entries[0].name : '';
  return out;
}

// A block's short name, the same as its folder on the SSD: "Block 08" from a KML named "..._block_8_...".
const covBlockName = (n) => { const m = /block[ _-]?0*(\d+)/i.exec(n || ''); return m ? 'Block ' + String(+m[1]).padStart(2, '0') : (n || 'Block'); };

// ---------- Drawing coverage ----------
// A grid over the site in degrees (cells ~1-3 m). Bit 1 = inside the boundary, bit 2 = covered by a photo.
function covGrid(rings, photos, blocks) {
  const pts = rings.flat(); if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const lat0 = (y0 + y1) / 2, mLat = 111320, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  const areaM = (x1 - x0) * mLon * (y1 - y0) * mLat;
  const cell = Math.max(0.75, Math.sqrt(areaM / 4e6));            // keep it to ~4 million cells
  const dx = cell / mLon, dy = cell / mLat, pad = 4;
  x0 -= pad * dx; y0 -= pad * dy; x1 += pad * dx; y1 += pad * dy;
  const cols = Math.ceil((x1 - x0) / dx), rows = Math.ceil((y1 - y0) / dy), g = new Uint8Array(cols * rows);
  // Fill polygons row by row (even-odd), setting `bit`.
  const fill = (polyRings, bit, label) => {
    let ya = Infinity, yb = -Infinity;
    for (const r of polyRings) for (const [, y] of r) { ya = Math.min(ya, y); yb = Math.max(yb, y); }
    const r0 = Math.max(0, Math.floor((y1 - yb) / dy)), r1 = Math.min(rows - 1, Math.ceil((y1 - ya) / dy));
    for (let row = r0; row <= r1; row++) {
      const yc = y1 - (row + 0.5) * dy, xs = [];
      for (const r of polyRings) for (let k = 0, j = r.length - 1; k < r.length; j = k++) {
        const [xa, yA] = r[k], [xb, yB] = r[j];
        if ((yA > yc) !== (yB > yc)) xs.push(xa + (yc - yA) * (xb - xa) / (yB - yA));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - x0) / dx - 0.5)), c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - x0) / dx - 0.5));
        if (label) for (let c = c0, o = row * cols + c0; c <= c1; c++, o++) lab[o] = label;
        else for (let c = c0, o = row * cols + c0; c <= c1; c++, o++) g[o] |= bit;
      }
    }
  };
  for (const poly of rings.__polys) fill(poly, 1);
  // Which block each cell is in (0 = none). Each block's polygons are filled on their own.
  const lab = blocks?.length ? new Uint16Array(cols * rows) : null;
  if (lab) blocks.forEach((b, i) => { for (const poly of b.polys) fill(poly, 0, i + 1); });
  for (const p of photos) {
    const yr = p.yaw * Math.PI / 180, fx = Math.sin(yr), fy = Math.cos(yr), rx = Math.cos(yr), ry = -Math.sin(yr);
    const hw = p.w / 2, hh = p.h / 2;
    const corner = (a, b) => [p.lon + (a * hw * rx + b * hh * fx) / mLon, p.lat + (a * hw * ry + b * hh * fy) / mLat];
    fill([[corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]], 2);
  }
  return { g, lab, cols, rows, x0, y1, dx, dy, cell, mLat, mLon };
}
// Gaps inside the boundary, as connected areas (largest first). Tiny slivers are ignored.
function covGaps(G, minM2) {
  const { g, cols, rows, cell } = G, seen = new Uint8Array(g.length), gaps = [], stack = [];
  for (let o = 0; o < g.length; o++) {
    if (g[o] !== 1 || seen[o]) continue;
    let n = 0, sx = 0, sy = 0; const cells = []; stack.push(o); seen[o] = 1;
    while (stack.length) {
      const q = stack.pop(), r = (q / cols) | 0, c = q - r * cols; n++; sx += c; sy += r; cells.push(q);
      for (const nb of [c > 0 ? q - 1 : -1, c < cols - 1 ? q + 1 : -1, r > 0 ? q - cols : -1, r < rows - 1 ? q + cols : -1])
        if (nb >= 0 && !seen[nb] && g[nb] === 1) { seen[nb] = 1; stack.push(nb); }
    }
    const m2 = n * cell * cell;
    if (m2 >= minM2) gaps.push({ m2, cells, cx: sx / n, cy: sy / n });
  }
  return gaps.sort((a, b) => b.m2 - a.m2);
}

// ---------- The coverage window ----------
let covMap = null, covState = null;
async function openCoverage({ key, title, canAdd = true }) {
  let el = $('#cov');
  if (!el) {
    el = document.createElement('div'); el.id = 'cov'; document.body.appendChild(el);
    const st = document.createElement('style');
    st.textContent = `#cov{position:fixed;inset:0;z-index:3000;background:#f4f6f7;display:flex;flex-direction:column}
      #cov .bar{background:#14202a;color:#fff;padding:10px 16px;display:flex;gap:10px;align-items:center}
      #cov .body{flex:1;display:flex;min-height:0} #cov .side{width:330px;overflow:auto;padding:12px 14px;background:#fff;border-right:1px solid #d5dde2;font-size:13.5px}
      #cov #covMap{flex:1} #cov .cov-px{image-rendering:pixelated} #cov .drop{border:2px dashed #9fb3aa;border-radius:8px;padding:14px;text-align:center;margin:8px 0;color:#405563}
      #cov .drop.over{background:#e6f4ef;border-color:#0f6e5a} #cov .big{font-size:26px;font-weight:700} #cov h3{margin:14px 0 6px;font-size:14px}
      #cov label{display:block;margin:3px 0} #cov .gap{cursor:pointer;padding:3px 0;border-bottom:1px solid #eef1f3} #cov .gap:hover{color:#b3261e}
      #cov table.blk{width:100%;border-collapse:collapse;font-size:13px} #cov table.blk td{padding:3px 4px;border-bottom:1px solid #eef1f3}
      #cov table.blk tr{cursor:pointer} #cov table.blk tr:hover{background:#f1f5f7} #cov table.blk tr.short td:nth-child(2){color:#b3261e;font-weight:600}
      #cov .key span{display:inline-block;width:12px;height:12px;border-radius:2px;margin:0 4px -1px 0}
      @media(max-width:760px){#cov .body{flex-direction:column} #cov .side{width:auto;max-height:45vh}}`;
    document.head.appendChild(st);
  }
  el.hidden = false;
  el.innerHTML = `<div class="bar"><b style="flex:1">Photo coverage · ${esc(title || '')}</b><button class="btn sm" id="covClose" style="background:transparent;color:#fff;border:1px solid #fff">Close</button></div>
    <div class="body"><div class="side" id="covSide"><p class="muted">Loading…</p></div><div id="covMap"></div></div>`;
  $('#covClose').onclick = () => { el.hidden = true; covMap?.remove(); covMap = null; el.innerHTML = ''; };
  covMap = L.map('covMap', { zoomControl: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 18, attribution: 'Imagery © Esri' }).addTo(covMap);
  covState = { key, title, canAdd, data: null, overlay: null, gapLayer: L.layerGroup().addTo(covMap), days: null, people: null, type: null };
  await covLoad();
}
async function covLoad() {
  const r = await fetch('api/coverage/' + encodeURIComponent(covState.key));
  if (!r.ok) { $('#covSide').innerHTML = `<p>${esc(await r.text())}</p>`; return; }
  const d = covState.data = await r.json();
  const all = d.people.flatMap(p => p.images);
  covState.days ??= new Set(); covState.people ??= new Set();
  const days = [...new Set(all.map(i => i.d.slice(0, 10)))].sort();
  days.forEach(x => covState.days.add(x)); d.people.forEach(p => covState.people.add(p.uid));
  if (!covState.typeChosen) covState.type = all.some(i => i.t === 'T') ? 'T' : 'all';   // thermal by default when there is any
  if (d.boundary) {
    covState.bLayer?.remove();
    covState.bLayer = L.polygon(d.boundary.map(poly => poly.map(r => r.map(([x, y]) => [y, x]))), { color: '#ffb000', weight: 2, fill: false }).addTo(covMap);
    covState.blkLayer?.remove();
    covState.blkLayer = L.layerGroup((d.blocks || []).map(b => L.polygon(b.polys.map(poly => poly.map(r => r.map(([x, y]) => [y, x]))), { color: '#ffb000', weight: 1, fill: false, interactive: false })
      .bindTooltip(esc(covBlockName(b.name)), { permanent: true, direction: 'center', className: 'blk-lbl' }))).addTo(covMap);
    if (!covState.fitted) { covMap.fitBounds(covState.bLayer.getBounds(), { padding: [20, 20] }); covState.fitted = 1; }
  } else if (all.length && !covState.fitted) { covMap.fitBounds(all.map(i => [i.lat, i.lon])); covState.fitted = 1; }
  else if (!covState.fitted) covMap.setView([-28, 134], 4);
  covRender();
}
function covRender() {
  const { data: d } = covState, side = $('#covSide');
  const days = [...new Set(d.people.flatMap(p => p.images.map(i => i.d.slice(0, 10))))].sort();
  const types = [...new Set(d.people.flatMap(p => p.images.map(i => i.t)))];
  const pick = d.people.filter(p => covState.people.has(p.uid)).flatMap(p => p.images)
    .filter(i => covState.days.has(i.d.slice(0, 10)) && (covState.type === 'all' || i.t === covState.type));
  const used = pick.filter(i => !i.off), notDown = pick.length - used.length;
  // Coverage grid and gaps
  covState.overlay?.remove(); covState.gapLayer.clearLayers();
  let stats = '';
  if (d.boundary && used.length) {
    const rings = d.boundary.flat(); rings.__polys = d.boundary;
    const blocks = (d.blocks || []).map(b => ({ ...b, name: covBlockName(b.name) }));
    const G = covGrid(rings, used, blocks), { g, lab, cols, rows } = G;
    const bIn = new Float64Array(blocks.length + 1), bCov = new Float64Array(blocks.length + 1);
    let inside = 0, covIn = 0;
    for (let o = 0; o < g.length; o++) if (g[o] & 1) { inside++; if (g[o] & 2) covIn++;
      if (lab) { const b = lab[o]; bIn[b]++; if (g[o] & 2) bCov[b]++; } }
    const gaps = covGaps(G, 30);
    if (lab) for (const gp of gaps) {                                  // the block a gap is (mostly) in
      const n = new Map(); for (const o of gp.cells) n.set(lab[o], (n.get(lab[o]) || 0) + 1);
      let best = 0, bn = -1; for (const [k, v] of n) if (k && v > bn) { best = k; bn = v; }
      gp.block = best ? blocks[best - 1].name : '';
    }
    const cv = document.createElement('canvas'); cv.width = cols; cv.height = rows;
    const cx = cv.getContext('2d'), img = cx.createImageData(cols, rows), px = img.data;
    for (let o = 0; o < g.length; o++) { const v = g[o], k = o * 4;
      if (v & 2) { px[k] = 46; px[k + 1] = 170; px[k + 2] = 90; px[k + 3] = v & 1 ? 95 : 45; } }
    for (const gp of gaps) for (const o of gp.cells) { const k = o * 4; px[k] = 225; px[k + 1] = 29; px[k + 2] = 29; px[k + 3] = 185; }
    cx.putImageData(img, 0, 0);
    const b = [[G.y1 - rows * G.dy, G.x0], [G.y1, G.x0 + cols * G.dx]];
    covState.overlay = L.imageOverlay(cv.toDataURL(), b, { opacity: 1, className: 'cov-px' }).addTo(covMap);
    const floorPct = (a, b) => b ? Math.floor(1000 * a / b) / 10 : 0;   // rounded down: never shows 100% while there's a gap
    const pct = floorPct(covIn, inside), gapM2 = gaps.reduce((t, x) => t + x.m2, 0);
    const at = gp => [G.y1 - (gp.cy + 0.5) * G.dy, G.x0 + (gp.cx + 0.5) * G.dx];
    gaps.slice(0, 200).forEach((gp, i) => L.circleMarker(at(gp), { radius: 4, color: '#b3261e', weight: 1, fillOpacity: 0.9 })
      .bindTooltip(`Gap ${i + 1}${gp.block ? ' · ' + esc(gp.block) : ''}: ${num(gp.m2)} m²`).addTo(covState.gapLayer));
    const blockRows = blocks.map((b, i) => { const k = i + 1, ng = gaps.filter(x => x.block === b.name).length;
      return { name: b.name, pct: floorPct(bCov[k], bIn[k]), ng, has: bIn[k] > 0 }; });
    stats = `<div class="big">${num(pct, 1)}%</div><div class="muted">of the site is covered by the selected photos</div>
      ${blockRows.length ? `<h3>Blocks</h3><table class="blk">${blockRows.map((b, i) => `<tr data-blk="${i}" class="${b.pct < 100 ? 'short' : ''}"><td>${esc(b.name)}</td>
          <td style="text-align:right">${num(b.pct, 1)}%</td><td class="muted">${b.ng ? `${b.ng} gap${b.ng > 1 ? 's' : ''}` : 'no gaps'}</td></tr>`).join('')}</table>
        <div class="muted" style="font-size:12px">Click a block to zoom to it.</div>` : ''}
      <h3>${gaps.length ? `${gaps.length} gap${gaps.length > 1 ? 's' : ''} · ${num(gapM2 / 10000, 2)} ha` : 'No gaps found'}</h3>
      ${gaps.length ? `<div class="muted" style="margin-bottom:4px">Largest first. Click one to zoom to it. Some gaps may be areas with no panels (roads, substation, drains) - check against the satellite image.</div>
        ${gaps.slice(0, 40).map((gp, i) => `<div class="gap" data-gap="${i}">Gap ${i + 1}${gp.block ? ` · <b>${esc(gp.block)}</b>` : ''} · ${num(gp.m2)} m²</div>`).join('')}` : ''}`;
    covState.gapAt = gaps.map(at);
  } else if (!d.boundary) stats = '<p class="pill warn">This job has no site boundary, so gaps can’t be worked out. Add the site boundary to the job.</p>';
  else stats = '<p class="muted">No photos yet. Add the job’s photos below.</p>';
  // Photo centres when zoomed in close.
  covState.dots?.remove();
  covState.dots = L.layerGroup(used.length <= 30000 ? used.map(i => L.circleMarker([i.lat, i.lon], { radius: 1.5, color: '#fff', weight: 0, fillOpacity: 0.8 })) : []);
  const dotsOn = () => covMap.getZoom() >= 17 ? covState.dots.addTo(covMap) : covState.dots.remove();
  covMap.off('zoomend', covState.dotsFn); covState.dotsFn = dotsOn; covMap.on('zoomend', dotsOn); dotsOn();

  const T = { T: 'Thermal', W: 'Wide', Z: 'Zoom', V: 'Visual', M: 'Multispectral' };
  side.innerHTML = `${stats}
    <div class="key muted" style="margin-top:8px"><span style="background:#2eaa5a"></span>Covered <span style="background:#e11d1d;margin-left:10px"></span>Gap <span style="background:#ffb000;margin-left:10px"></span>Boundary</div>
    <p class="muted">${(() => { const allSel = d.people.filter(p => covState.people.has(p.uid)).flatMap(p => p.images).filter(i => covState.days.has(i.d.slice(0, 10)));
      const camOff = allSel.length - pick.length;
      return `On the map: <b>${num(used.length)}</b> of ${num(allSel.length)} photos for the ticked days and pilots.`
        + (camOff ? ` ${num(camOff)} hidden by the camera choice below.` : '')
        + (notDown ? ` ${num(notDown)} not counted: not pointing straight down, or taken on the ground.` : ''); })()}</p>
    ${d.boundary && !(d.blocks || []).length ? '<p class="pill warn">This site has no block outlines yet, so coverage can’t be shown block by block. Drop the block KML files on the site page.</p>' : ''}
    <h3>Camera</h3><select id="covType">${types.length > 1 ? '<option value="all">All photos</option>' : ''}${types.map(t => `<option value="${t}">${T[t] || t}</option>`).join('')}${!types.length ? '<option value="all">All photos</option>' : ''}</select>
    ${days.length ? `<h3>Days</h3>${days.map(x => `<label><input type="checkbox" data-day="${x}"${covState.days.has(x) ? ' checked' : ''}> ${dateOnly(x)}</label>`).join('')}` : ''}
    ${d.people.length ? `<h3>Pilots</h3>${d.people.map(p => `<label><input type="checkbox" data-person="${p.uid}"${covState.people.has(p.uid) ? ' checked' : ''}> ${esc(p.name)} <span class="muted">(${num(p.count)} photos)</span></label>`).join('')}` : ''}
    ${covState.canAdd ? `<h3>Add photos</h3>
      <div><b>Use the SSD, not the SD card.</b> Aspex Uploader sorts each card into block folders on your SSD. To check a block, choose that block’s folder (for example <b>Block 14</b> inside the job folder); to check everything, choose the job folder.</div>
      <div class="muted" style="margin-top:4px">Only the position details in each photo are read; the photos stay where they are. Photos already added are skipped, so checking a folder again only reads the new ones.</div>
      <div class="drop" id="covDrop">Drag the Block folder here<br>or <button class="btn sm" id="covPick">Choose the Block folder…</button>
        <input type="file" id="covDir" webkitdirectory multiple hidden></div>
      <div id="covProg" class="muted"></div>
      ${d.people.some(p => p.uid === d.me) ? '<p><a href="#" id="covClear" class="muted">Remove my photos from this job</a></p>' : ''}` : ''}`;
  $('#covType').value = covState.type;
  $('#covType').onchange = e => { covState.type = e.target.value; covState.typeChosen = 1; covRender(); };
  side.querySelectorAll('[data-day]').forEach(c => c.onchange = () => { c.checked ? covState.days.add(c.dataset.day) : covState.days.delete(c.dataset.day); covRender(); });
  side.querySelectorAll('[data-person]').forEach(c => c.onchange = () => { c.checked ? covState.people.add(c.dataset.person) : covState.people.delete(c.dataset.person); covRender(); });
  side.querySelectorAll('[data-gap]').forEach(x => x.onclick = () => covMap.setView(covState.gapAt[x.dataset.gap], 19));
  side.querySelectorAll('[data-blk]').forEach(x => x.onclick = () => {
    const b = d.blocks[x.dataset.blk]; covMap.fitBounds(L.polygon(b.polys.map(p => p.map(r => r.map(([lo, la]) => [la, lo])))).getBounds(), { padding: [20, 20] }); });
  if (!covState.canAdd) return;
  const drop = $('#covDrop');
  $('#covPick').onclick = () => $('#covDir').click();
  $('#covDir').onchange = e => { const fs = [...e.target.files]; fs.folder = (fs[0]?.webkitRelativePath || '').split('/')[0]; covAdd(fs); };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async e => { e.preventDefault(); drop.classList.remove('over'); covAdd(await covFilesFromDrop(e.dataTransfer)); };
  $('#covClear')?.addEventListener('click', async e => { e.preventDefault();
    if (!confirmBox('Remove all your photos from this job’s coverage? The photos themselves aren’t touched.')) return;
    await fetch('api/coverage/' + encodeURIComponent(covState.key) + '/clear', { method: 'POST' }); covLoad(); });
}
const confirmBox = (msg) => window.confirm(msg);
// After checking a "Block 14" folder, zoom the map to Block 14.
function covZoomTo(folder) {
  const name = /block/i.test(folder) ? covBlockName(folder) : '';
  const i = name ? (covState.data.blocks || []).findIndex(b => covBlockName(b.name) === name) : -1;
  if (i < 0) return;
  const b = covState.data.blocks[i];
  covMap.fitBounds(L.polygon(b.polys.map(p => p.map(r => r.map(([lo, la]) => [la, lo])))).getBounds(), { padding: [20, 20] });
  document.querySelector(`#cov [data-blk="${i}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function covAdd(files) {
  const folder = files.folder || '';
  const all = files.filter(f => /\.jpe?g$/i.test(f.name)), prog = $('#covProg');
  if (!all.length) { prog.textContent = 'No photos (.JPG) found in that folder.'; return; }
  // Photos already sent are skipped without being opened, so checking the whole card or job folder again
  // each day only reads the new ones. DJI names carry the date and time taken, so a name is unique.
  const mine = covState.data.people.find(p => p.uid === covState.data.me);
  const have = new Set((mine?.images || []).map(i => i.f).filter(f => /^DJI_\d{14}_/i.test(f)));
  const jpgs = all.filter(f => !have.has(f.name)), already = all.length - jpgs.length;
  if (!jpgs.length) { covZoomTo(folder); prog.textContent = `All ${num(all.length)} photos in that folder are already in the coverage map.`; return; }
  const out = [], skip = { nogps: 0, bad: 0 }; let done = 0, i = 0, held = null; const t0 = Date.now();
  const show = () => { prog.textContent = `Reading new photos: ${num(done)} of ${num(jpgs.length)}…` + (already ? ` (${num(already)} already in, skipped)` : ''); };
  show(); const tick = setInterval(show, 300);
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < jpgs.length) { const f = jpgs[i++];
      try { const r = await covParsePhoto(f); if (r.skip) skip[r.skip]++; else out.push(r); } catch { skip.bad++; }
      done++; }
  }));
  clearInterval(tick);
  for (let k = 0; k < out.length; k += 2000) {
    prog.textContent = `Sending: ${num(Math.min(k + 2000, out.length))} of ${num(out.length)}…`;
    const r = await fetch('api/coverage/' + encodeURIComponent(covState.key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: out.slice(k, k + 2000) }) });
    if (!r.ok) { prog.textContent = 'Couldn’t send: ' + (await r.text()) + '. Try again - photos already sent aren’t doubled up.'; return; }
    held = (await r.json().catch(() => ({}))).total ?? held;
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  await covLoad();
  covZoomTo(folder);
  const meNow = covState.data.people.find(p => p.uid === covState.data.me);
  $('#covProg').innerHTML = esc(`Done: ${num(out.length)} new photos read and sent in ${secs} s.` + (already ? ` ${num(already)} were already in.` : '') + (skip.nogps ? ` ${num(skip.nogps)} had no GPS position.` : '') + (skip.bad ? ` ${num(skip.bad)} couldn’t be read.` : ''))
    + (held != null ? `<br><b>The logbook now holds ${num(held)} of your photos for this job.</b>` : '')
    + (held != null && meNow && meNow.images.length !== held ? `<br><span style="color:#b3261e;font-weight:600">But only ${num(meNow.images.length)} came back for the map. Close this window and open it again; if the numbers still differ, tell Aspex.</span>` : '');
}

// ---------- Aspex Uploader ----------
// The app's "Check photo coverage" button opens …/logbook/#coverage=<job key>&t=<job name>.
function covFromHash() {
  const m = /^#coverage=([^&]+)(?:&t=(.*))?$/.exec(location.hash || '');
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  setTimeout(() => openCoverage({ key: decodeURIComponent(m[1]), title: decodeURIComponent(m[2] || '') }), 800);
}
window.addEventListener('load', covFromHash);

// Backup and upload progress reported by the app, shown on the job (owner: everyone; pilot: their own).
const upGiB = b => b == null ? '' : b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GiB' : Math.round(b / 1048576) + ' MiB';
const upSpan = s => s == null ? '' : s < 3600 ? Math.round(s / 60) + 'm' : Math.floor(s / 3600) + 'h ' + String(Math.round(s % 3600 / 60)).padStart(2, '0') + 'm';
function upAgo(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : dateOnly(iso);
}
function upCell(t, what) {
  if (!t) return '<span class="muted">—</span>';
  const stale = (t.status === 'running' || t.status === 'waiting') && Date.now() - Date.parse(t.at) > 10 * 60000;
  let s;
  if (t.status === 'done') s = `<span class="pill ok">Complete</span> ${t.checkOk ? '0 differences' : ''}${t.files != null ? ` · ${num(t.files, 0)} files, ${upGiB(t.bytes)}` : ''}`;
  else if (t.status === 'stopped') s = '<span class="pill">Stopped</span>';
  else if (t.status === 'waiting') s = '<span class="pill warn">Waiting to reconnect</span>';
  else if (t.phase === 'check') s = `<span class="pill">Checking</span>`;
  else s = `<span class="pill">${what} ${t.pct != null ? t.pct + '%' : ''}</span> ${t.doneBytes != null ? upGiB(t.doneBytes) + ' of ' + upGiB(t.totalBytes) : ''}${t.etaSec != null ? ' · about ' + upSpan(t.etaSec) + ' left' : ''}`;
  const extra = [t.elapsedSec ? 'running ' + upSpan(t.elapsedSec) : '', t.reconnects ? `reconnected ${t.reconnects}×` : '', 'updated ' + upAgo(t.at)].filter(Boolean).join(' · ');
  return `${s}<div class="muted" style="font-size:12px">${extra}${stale ? ' · <b style="color:#b3261e">no contact for a while (laptop off or offline?)</b>' : ''}</div>`;
}
async function loadUploads(key, el) {
  if (!el) return;
  const r = await fetch('api/uploads/' + encodeURIComponent(key));
  if (!r.ok) { el.innerHTML = ''; return; }
  const d = await r.json();
  el.innerHTML = `<h4>Card backups and uploads <span class="muted" style="font-weight:400">from Aspex Uploader</span></h4>
    ${d.rows.length ? `<table><tr><th>Pilot</th><th>Card backup</th><th>Upload to Aspex</th></tr>${d.rows.map(x => `<tr><td>${esc(x.name || '')}</td><td>${upCell(x.backup, 'Backing up')}</td><td>${upCell(x.upload, 'Uploading')}</td></tr>`).join('')}</table>`
      : '<p class="muted">Nothing yet. Progress appears here once Aspex Uploader is used for this job.</p>'}
    ${d.setUp ? '' : typeof myRole !== 'undefined' && myRole === 'owner'
      ? '<p class="pill warn" style="display:block">Aspex Uploader can’t be installed yet: the upload connection setting (UPLOADER_RCLONE_CONF_B64) isn’t on the server.</p>'
      : '<p class="pill warn" style="display:block">Aspex Uploader isn’t ready to install yet - Aspex is setting it up. Ask Kimberly.</p>'}`;
}
