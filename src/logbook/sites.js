// Site boundaries (Google Earth KML/KMZ) and the preliminary airspace check (OpenAIP data).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const Geo = require('./public/geo.cjs');
const store = require('./store');

// ---------- KML / KMZ boundary ----------
function unzipFirstKml(buf) {
  let e = buf.length - 22;                                          // end-of-central-directory record
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a valid KMZ');
  let p = buf.readUInt32LE(e + 16); const n = buf.readUInt16LE(e + 10);
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString();
    if (/\.kml$/i.test(name)) {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.slice(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error('no KML inside the KMZ');
}
function parseKml(text) {
  const coords = (s) => s.trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(c => c.length >= 2 && c.every(Number.isFinite)).map(c => [c[0], c[1]]);
  const polys = [];
  for (const m of text.matchAll(/<(?:\w+:)?Polygon[\s\S]*?<\/(?:\w+:)?Polygon>/g)) {
    const blk = m[0];
    const outer = blk.match(/<(?:\w+:)?outerBoundaryIs>[\s\S]*?<(?:\w+:)?coordinates>([\s\S]*?)<\//);
    if (!outer) continue;
    const holes = [...blk.matchAll(/<(?:\w+:)?innerBoundaryIs>[\s\S]*?<(?:\w+:)?coordinates>([\s\S]*?)<\//g)].map(h => coords(h[1]));
    const ring = coords(outer[1]);
    if (ring.length >= 3) polys.push([ring, ...holes.filter(h => h.length >= 3)]);
  }
  if (!polys.length) {                                              // a closed path drawn as a line
    for (const m of text.matchAll(/<(?:\w+:)?LineString>[\s\S]*?<(?:\w+:)?coordinates>([\s\S]*?)<\//g)) {
      const r = coords(m[1]);
      if (r.length >= 4 && Geo.metres(r[0], r[r.length - 1]) < 50) polys.push([r]);
    }
  }
  if (!polys.length) throw new Error('no polygon found in the KML - draw the farm boundary as a polygon in Google Earth');
  const name = (text.match(/<name>([^<]{1,120})<\/name>/) || [])[1] || '';
  return { polys, name: name.trim() };
}
function setBoundary(uid, key, buf, filename) {
  const text = buf[0] === 0x50 && buf[1] === 0x4b ? unzipFirstKml(buf) : buf.toString('utf8');
  const { polys, name } = parseKml(text);
  return store.updateSite(uid, key, (s) => {
    s.boundary = polys; s.areaHa = Math.round(Geo.areaHa(polys) * 10) / 10;
    s.centroid = Geo.centroid(polys).map(v => Math.round(v * 1e6) / 1e6);
    s.boundaryFile = store.clean(filename, 200); s.boundaryLoaded = new Date().toISOString();
    if (!s.name && name) s.name = name;
    delete s.airspace;                                              // boundary changed: re-check airspace
  });
}

// ---------- airspace (OpenAIP Australia-wide export files, keyless) ----------
const OAIP_BUCKET = 'https://s3.openaip.net/openaip-system-exports';
const cache = {};                                                   // kind -> { at, gj }
async function oaipExport(kind, force = false) {
  const hit = cache[kind];
  if (!force && hit && Date.now() - hit.at < 30 * 864e5) return hit;
  const file = path.join(config.dataDir, 'openaip', `au_${kind}.geojson`);  // disk copy survives until the next restart
  if (!force && !hit && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 30 * 864e5) {
    cache[kind] = { at: fs.statSync(file).mtimeMs, gj: JSON.parse(fs.readFileSync(file, 'utf8')) };
    return cache[kind];
  }
  try {
    const r = await fetch(`${OAIP_BUCKET}/au_${kind}.geojson`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const txt = await r.text(); const gj = JSON.parse(txt);
    if (!Array.isArray(gj.features)) throw new Error('not a GeoJSON feature collection');
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, txt); } catch {}
    return (cache[kind] = { at: Date.now(), gj });
  } catch (e) {
    if (hit) return hit;                                            // stale copy beats nothing
    throw new Error(`Could not download OpenAIP's Australian ${kind === 'asp' ? 'airspace' : 'aerodrome'} file (${e.message}). Try again shortly.`);
  }
}
const lim = (v) => (v && typeof v === 'object')
  ? { value: Number(v.value) || 0, unit: Number(v.unit ?? 1), referenceDatum: Number(v.referenceDatum ?? 1) } : null;
function fbox(geom) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = (c) => { if (typeof c[0] === 'number') { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; } else c.forEach(walk); };
  if (geom?.coordinates) walk(geom.coordinates);
  return [x0, y0, x1, y1];
}
async function checkAirspace(uid, key, refresh = false) {
  const s = store.ops(uid).sites[key];
  if (!s) throw new Error('no such site');
  if (!s.boundary) throw new Error('Load the site boundary KML first');
  const [x0, y0, x1, y1] = Geo.bbox(s.boundary), pad = 0.15;        // ~15 km around the farm
  const near = (b) => !(b[2] < x0 - pad || b[0] > x1 + pad || b[3] < y0 - pad || b[1] > y1 + pad);
  const [asp, apt] = await Promise.all([oaipExport('asp', refresh), oaipExport('apt', refresh)]);
  const airspace = {
    fetched: new Date().toISOString(), dataDate: new Date(asp.at).toISOString(),
    airspaces: asp.gj.features.filter(f => f.geometry && near(fbox(f.geometry))).map(f => {
      const P = f.properties || {};
      return { name: P.name || '', type: Number(P.type), icaoClass: Number(P.icaoClass ?? P.icao_class ?? 8),
        lower: lim(P.lowerLimit ?? P.lower_limit), upper: lim(P.upperLimit ?? P.upper_limit), byNotam: !!(P.byNotam ?? P.by_notam), geometry: f.geometry };
    }),
    airports: apt.gj.features.filter(f => f.geometry?.type === 'Point' && near(fbox(f.geometry))).map(f => {
      const P = f.properties || {};
      return { name: P.name || '', icao: P.icaoCode || P.icao_code || '', type: Number(P.type), coords: f.geometry.coordinates };
    }),
  };
  return store.updateSite(uid, key, (site) => { site.airspace = airspace; });
}

// ---------- sites made from flight take-off points (for past flights with no farm boundary) ----------
// The boundary is a circle around the take-offs (furthest take-off + 300 m, at least 500 m across),
// so the flights fall inside it. It isn't the farm's real outline: load the farm KML later to replace it.
function circleAround(points) {
  const lat0 = points.reduce((s, p) => s + p[1], 0) / points.length, lon0 = points.reduce((s, p) => s + p[0], 0) / points.length;
  const r = Math.max(500, Math.max(...points.map(p => Geo.metres([lon0, lat0], p))) + 300);
  const ring = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i % 32) / 32 * 2 * Math.PI;
    ring.push([Math.round((lon0 + r * Math.cos(a) / (111320 * Math.cos(lat0 * Math.PI / 180))) * 1e6) / 1e6, Math.round((lat0 + r * Math.sin(a) / 110574) * 1e6) / 1e6]);
  }
  return [[ring]];
}
function sitesFromPoints(uid, list) {
  for (const x of list || []) {
    const key = store.safeKey(String(x.id || ''));
    const pts = (x.points || []).map(p => [Number(p[0]), Number(p[1])]).filter(p => p.every(Number.isFinite) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180).slice(0, 5000);
    if (!key || !pts.length) continue;
    const boundary = circleAround(pts);
    store.putOps(uid, 'sites', key, { created: new Date().toISOString(), name: store.clean(x.name || 'Site', 120),
      notes: 'Created from flight take-off points. The boundary is an approximate circle - load the farm KML to replace it.',
      boundary, areaHa: null, centroid: Geo.centroid(boundary).map(v => Math.round(v * 1e6) / 1e6),
      boundaryFile: 'From flight take-off points (approximate)', boundaryLoaded: new Date().toISOString() });
  }
  return store.ops(uid);
}

// Nearest town for a point (OpenStreetMap Nominatim reverse lookup, one request per second, remembered).
const nearCache = new Map();
let lastNear = 0;
async function nearestPlace(lat, lon) {
  const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (nearCache.has(k)) return nearCache.get(k);
  let name = '';
  if (process.env.GEO_STUB) name = 'Town ' + k;
  else {
    const wait = lastNear + 1100 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNear = Date.now();
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`, { headers: { 'User-Agent': 'AspexPilotNetwork/1.0 (admin@aspex.com.au)', 'Accept-Language': 'en-AU' } });
      if (r.ok) { const a = (await r.json()).address || {}; name = a.town || a.village || a.city || a.suburb || a.hamlet || a.locality || a.municipality || a.county || ''; }
    } catch (e) { console.warn('nearest place lookup failed:', e.message); }
  }
  nearCache.set(k, name);
  return name;
}

module.exports = { setBoundary, checkAirspace, sitesFromPoints, nearestPlace };
