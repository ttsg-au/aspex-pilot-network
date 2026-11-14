// Checks each flight against the approvals register: did it need an approval (above 400 ft, in
// controlled airspace or within 3 NM of a controlled aerodrome, in a restricted area), and was one
// in force that day? Uses the flight's take-off point and maximum height, and OpenAIP data - so it's
// a preliminary check, like the site airspace check, not a ruling.
const Geo = require('./public/geo.cjs');
const Controlled = require('./public/controlled.cjs');
const store = require('./store');
const db = require('../db');
const sites = require('./sites');

const NM3 = 5556, LIMIT_M = 120, TOL_M = 2;           // standard operating conditions: 400 ft (~120 m) AGL

// Index of the airspace that matters, built once per OpenAIP download.
let idx = null;
async function index() {
  const [asp, apt] = await Promise.all([sites.oaipExport('asp'), sites.oaipExport('apt')]);
  if (idx && idx.at === asp.at) return idx;
  const zones = asp.gj.features.filter(f => f.geometry).map(f => { const P = f.properties || {};
    const z = { name: String(P.name || ''), type: Number(P.type), icaoClass: Number(P.icaoClass ?? 8), lower: sites.lim(P.lowerLimit ?? P.lower_limit), byNotam: !!(P.byNotam ?? P.by_notam), polys: Geo.fromGeoJSON(f.geometry) };
    z.box = Geo.bbox(z.polys); return z;
  }).filter(z => z.polys.length && (Controlled.isControlledSfc(z) || Controlled.isRestrictedSfc(z)));
  const ctrl = zones.filter(Controlled.isControlledSfc);
  const airports = apt.gj.features.filter(f => f.geometry?.type === 'Point').map(f => ({ icao: String(f.properties?.icaoCode || ''), name: String(f.properties?.name || ''), pt: f.geometry.coordinates }));
  const towers = airports.filter(a => Controlled.LIST[a.icao.toUpperCase()] || ctrl.some(z => inBox(a.pt, z.box) && Geo.inPolys(a.pt, z.polys)));
  return (idx = { at: asp.at, zones, towers });
}
const inBox = ([x, y], b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

// Where a flight went, relative to the airspace that matters: checked along its whole GPS route when
// there is one (thinned to ~1 point per 5 s), otherwise from the take-off point. Saved per account
// and redone only when the OpenAIP data changes, since reading every route is slow.
function where(pts, ix) {
  const r = { ctrl: null, ctrlAtStart: false, tower: null, restr: null, restrAtStart: false, notam: false, route: pts.length > 1 };
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const near = ix.zones.filter(z => !(z.box[2] < x0 || z.box[0] > x1 || z.box[3] < y0 || z.box[1] > y1));
  const pad = 0.08, towers = ix.towers.filter(a => a.pt[0] > x0 - pad && a.pt[0] < x1 + pad && a.pt[1] > y0 - pad && a.pt[1] < y1 + pad);
  pts.forEach((pt, i) => {
    for (const z of near) {
      if (!inBox(pt, z.box) || !Geo.inPolys(pt, z.polys)) continue;
      if (Controlled.isControlledSfc(z) && !r.ctrl) { r.ctrl = z.name; r.ctrlAtStart = i === 0; }
      if (Controlled.isRestrictedSfc(z) && !r.restr) { r.restr = z.name; r.restrAtStart = i === 0; r.notam = z.byNotam; }
    }
    for (const a of towers) { const d = Geo.metres(pt, a.pt); if (d <= NM3 && (!r.tower || d < r.tower.d)) r.tower = { name: a.name, icao: a.icao, d: Math.round(d) }; }
  });
  return r;
}
async function routePoints(f) {
  const start = f.takeoffLat != null && f.takeoffLon != null ? [[f.takeoffLon, f.takeoffLat]] : [];
  if (f.track !== 'ok' || !f.trackFile) return start;
  try {
    const file = await db.readFile(f.trackFile);
    const c = JSON.parse(file.content.toString()).features?.[0]?.geometry?.coordinates || [];
    const step = Math.max(1, Math.round(c.length / 2000));                 // at most ~2000 points per flight
    return [...start, ...c.filter((p, i) => i % step === 0).map(p => [p[0], p[1]])];
  } catch { return start; }
}
async function placesFor(uid, flights, ix) {
  const st = store.state('trackcheck', uid, {});
  const saved = st.at === ix.at ? st.bySha || {} : {};
  let changed = st.at !== ix.at;
  for (const f of flights) {
    if (!f.isFlight || f.takeoffLat == null) continue;
    const want = f.track === 'ok' && f.trackFile ? 'route' : 'start';
    if (saved[f.sha256]?.from === want) continue;
    saved[f.sha256] = { ...where(await routePoints(f), ix), from: want }; changed = true;
  }
  if (changed) store.setState('trackcheck', uid, { at: ix.at, bySha: saved });
  return saved;
}

// What the flight needed. -> [{ need: 'height'|'controlled'|'restricted', text, notam? }]
function needs(f, w) {
  const out = [];
  if (f.maxHeightM != null && f.maxHeightM > LIMIT_M + TOL_M) out.push({ need: 'height', text: `Flew to ${Math.round(f.maxHeightM)} m (${Math.round(f.maxHeightM / 0.3048)} ft), above 120 m / 400 ft` });
  if (w) {
    if (w.ctrl) out.push({ need: 'controlled', text: `${w.ctrlAtStart ? 'Took off inside' : 'Flew into'} controlled airspace (${w.ctrl})` });
    else if (w.tower) out.push({ need: 'controlled', text: `${w.route ? 'Came within' : 'Took off'} ${(w.tower.d / 1000).toFixed(1)} km ${w.route ? 'of' : 'from'} ${w.tower.name}${w.tower.icao ? ' (' + w.tower.icao + ')' : ''}, a controlled aerodrome - within 3 NM` });
    if (w.restr) out.push({ need: 'restricted', notam: w.notam, text: `${w.restrAtStart ? 'Took off inside' : 'Flew into'} ${w.restr}${w.notam ? ' (active only when NOTAM\'d - check whether it was active)' : ''}` });
  }
  return out;
}

// Does this approval cover this need on this flight?
// The approval's type has to fit the need (an above-400-ft instrument doesn't authorise flying in a
// control zone), its dates have to include the flight's day, and if it belongs to a place (its site,
// or the sites of the jobs it's linked to) the flight must have taken off at or near that place.
const TYPE_FOR = {
  controlled: /controlled airport|airport \/ helipad|^other$/i,
  restricted: /restricted area|^other$/i,
  height: /casa instrument|bvlos|evlos|controlled airport|airport \/ helipad|restricted area|^other$/i,
};
function places(a, ops) {
  const ids = [a.siteId, ...store.keysOf(a.jobs).map(k => ops.jobs?.[k]?.siteId)].filter(Boolean);
  return ids.map(id => ops.sites?.[id]).filter(s => s?.boundary);
}
function covers(a, n, f, ops) {
  const day = String(f.startLocal || '').slice(0, 10);
  if (!day || (a.validFrom && a.validFrom > day) || (a.validTo && a.validTo < day)) return false;
  if (!TYPE_FOR[n.need].test(String(a.type || '').trim())) return false;
  const at = places(a, ops);
  if (at.length && f.takeoffLat != null && !at.some(s => Geo.distToPolys([f.takeoffLon, f.takeoffLat], s.boundary) <= 2000)) return false;
  if (n.need === 'height') { const ft = parseFloat(a.heightFt); return ft > 0 && ft * 0.3048 + TOL_M >= f.maxHeightM; }
  return true;
}

// -> { [sha256]: { status: 'ok'|'covered'|'flag'|'check', issues: [{text, ok, by}], approvals: [names] } }
async function checkFlights(uid, flights, extraApprovals = []) {
  let ix = null, airspace = true;
  try { ix = await index(); } catch { airspace = false; }
  const ops = store.ops(uid);
  const mine = Object.entries(ops.approvals || {}).map(([key, a]) => ({ key, a, ops }));
  const list = [...mine, ...extraApprovals];
  const out = {}, at = ix ? await placesFor(uid, flights, ix) : {};
  for (const f of flights) {
    if (!f.isFlight) continue;
    const ns = needs(f, at[f.sha256]);
    if (!ns.length) { out[f.sha256] = { status: 'ok', issues: [] }; continue; }
    const issues = ns.map(n => {
      const hit = list.find(x => covers(x.a, n, f, x.ops));
      return { text: n.text, ok: !!hit, notam: !!n.notam, by: hit ? (hit.a.title || hit.a.type) + (hit.a.ref ? ` (${hit.a.ref})` : '') : '' };
    });
    // Even with an approval, flying above its own height limit is a breach of it.
    for (const i of issues) {
      const hit = i.ok && list.find(x => (x.a.title || x.a.type) + (x.a.ref ? ` (${x.a.ref})` : '') === i.by);
      const ft = hit && parseFloat(hit.a.heightFt);
      if (ft > 0 && f.maxHeightM != null && f.maxHeightM > ft * 0.3048 + TOL_M) { i.ok = false; i.text += `, and above the approval's ${ft} ft limit`; }
    }
    const bad = issues.filter(i => !i.ok);
    out[f.sha256] = { status: !bad.length ? 'covered' : bad.every(i => i.notam) ? 'check' : 'flag', issues };
  }
  return { airspace, checkedAt: new Date().toISOString(), flights: out };
}

module.exports = { checkFlights, needs, covers, where };
