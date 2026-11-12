// Skydio flights from Skydio Cloud (api.skydio.com), using the user's own read-only API token.
// Each Skydio flight becomes a logbook flight keyed by its Skydio flight ID, so syncing again only adds new ones.
// Skydio Cloud gives take-off/landing times, take-off position (when telemetry was uploaded), vehicle and battery serials.
const db = require('../db');
const store = require('./store');

const API = 'https://api.skydio.com/api/v0';
const localFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const local = (d) => localFmt.format(d).replace(',', '');
const round = (n, dp) => (n == null || Number.isNaN(Number(n)) ? null : Number(Number(n).toFixed(dp)));

async function get(token, path) {
  const r = await fetch((path.startsWith('/api/') ? 'https://api.skydio.com' : API) + path, { headers: { Authorization: token, accept: 'application/json' } });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { }
  if (!r.ok || (j && j.status_code && j.status_code >= 400)) {
    const msg = (j && (j.error_message || j.message || j.detail)) || text.slice(0, 200) || r.statusText;
    const e = new Error(r.status === 401 || r.status === 403 ? 'Skydio Cloud refused the token (check it was copied in full and has read access to Flights)' : `Skydio Cloud said: ${msg}`);
    e.status = r.status; throw e;
  }
  return (j && j.data) || {};
}
const listOf = (data, key) => Array.isArray(data) ? data : Array.isArray(data[key]) ? data[key] : (Object.values(data).find(Array.isArray) || []);

async function allFlights(token) {
  const out = [], per = 200;
  for (let page = 1; page <= 50; page++) {
    const data = await get(token, `/flights?per_page=${per}&page_number=${page}`);
    const list = listOf(data, 'flights');
    out.push(...list);
    const pg = data.pagination || {};
    if (!list.length || list.length < per || (pg.total_pages && page >= pg.total_pages)) break;
  }
  return out;
}
async function vehicleNames(token) {
  try {
    const data = await get(token, '/vehicles?per_page=200');
    const m = {};
    for (const v of listOf(data, 'vehicles')) if (v.vehicle_serial) m[v.vehicle_serial] = { type: v.vehicle_type || v.model || '', name: v.name || '' };
    return m;
  } catch { return {}; }          // the token may not have Vehicles access; flights still import
}

// Skydio's API gives internal type codes (e.g. "R3" for a Skydio 2+); the serial prefix says it plainly.
function skydioModel(type, serial = '') {
  const sn = String(serial);
  if (/^Skydio2P/i.test(sn)) return 'Skydio 2+';
  if (/^Skydio2/i.test(sn)) return 'Skydio 2';
  if (/^X10/i.test(sn) || /^X10/i.test(type || '')) return 'Skydio X10';
  if (/^X2/i.test(sn) || /^X2/i.test(type || '')) return 'Skydio X2';
  return type ? `Skydio ${type}` : 'Skydio';
}
function toEntry(f, veh) {
  const start = new Date(f.takeoff), end = f.landing ? new Date(f.landing) : null;
  if (!f.flight_id || isNaN(start)) return null;
  const mins = end && !isNaN(end) ? Math.max(0, (end - start) / 60000) : 0;
  const v = veh[f.vehicle_serial] || {};
  return {
    file: `Skydio flight ${f.flight_id}`, sha256: 'skydio-' + f.flight_id, source: 'skydio', skydioFlightId: f.flight_id,
    startUtc: start.toISOString(), startLocal: local(start), endLocal: end && !isNaN(end) ? local(end) : local(start),
    durationMin: round(mins, 1),
    takeoffLat: f.takeoff_latitude != null ? round(f.takeoff_latitude, 6) : null,
    takeoffLon: f.takeoff_longitude != null ? round(f.takeoff_longitude, 6) : null,
    aircraftModel: skydioModel(v.type, f.vehicle_serial), aircraftName: v.name || '', aircraftSn: f.vehicle_serial || '',
    batterySn: f.battery_serial || '', skydioPilot: f.user_email || '',
    isFlight: mins >= 0.1, track: f.has_telemetry ? 'not fetched yet' : 'no telemetry in Skydio Cloud', trackPoints: 0,
  };
}

// ---------- per-flight telemetry: GPS track, battery %, distance, height, speed; and photo count ----------
const metres = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180, x = (lon2 - lon1) * r * Math.cos((lat1 + lat2) / 2 * r), y = (lat2 - lat1) * r;
  return Math.hypot(x, y) * 6371000;
};
const TELEMETRY_FIELDS = ['trackFile', 'track', 'trackPoints', 'trackPointsDropped', 'distanceKm', 'maxHeightM', 'maxHSpeedMs', 'maxRangeM',
  'batteryStartPct', 'batteryEndPct', 'photos', 'videos', 'telemetryAt', 'telemetryError'];

async function telemetryFor(token, e) {
  const data = await get(token, `/api/v1/flight/${e.skydioFlightId}/telemetry`);
  const tel = (data.flight_telemetry && data.flight_telemetry.aligned_telemetry) || [];
  const out = {};
  const pts = []; let last = null, dropped = 0, dist = 0, maxH = null, maxV = null, maxR = null, home = null;
  const pcts = tel.map(t => t.battery_percentage).filter(v => Number.isFinite(v) && v > 0);
  if (pcts.length) { const k = v => Math.round(v <= 1 ? v * 100 : v); out.batteryStartPct = k(pcts[0]); out.batteryEndPct = k(pcts[pcts.length - 1]); }
  for (let i = 0; i < tel.length; i++) {
    const t = tel[i], lat = t.gps_latitude, lon = t.gps_longitude, h = t.height_above_takeoff;
    if (Number.isFinite(h)) maxH = Math.max(maxH ?? h, h);
    if (Array.isArray(t.gps_velocity) && t.gps_velocity.length >= 2) maxV = Math.max(maxV ?? 0, Math.hypot(t.gps_velocity[0], t.gps_velocity[1]));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) < 0.0001 || Math.abs(lon) < 0.0001 || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (last) {
      const d = metres(last[0], last[1], lat, lon);
      if (d > 500) { dropped++; continue; }                               // impossible jump
      dist += d;
    }
    last = [lat, lon];
    home ||= [lat, lon];
    maxR = Math.max(maxR ?? 0, metres(home[0], home[1], lat, lon));
    if (!pts.length || i % 2 === 0) pts.push([round(lon, 7), round(lat, 7), round(Number.isFinite(h) ? h : 0, 1)]);
  }
  out.distanceKm = round(dist / 1000, 2); out.maxHeightM = round(maxH, 1); out.maxHSpeedMs = round(maxV, 1); out.maxRangeM = round(maxR, 0);
  out.trackPointsDropped = dropped;
  if (pts.length >= 2) {
    const geo = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
      properties: { file: e.file, start: e.startLocal, durationMin: e.durationMin, aircraftSn: e.aircraftSn, batterySn: e.batterySn },
      geometry: { type: 'LineString', coordinates: pts } }] });
    out.trackFile = await db.saveFile(Buffer.from(geo), `skydio-${e.skydioFlightId}.geojson`, 'application/geo+json');
    out.track = 'ok'; out.trackPoints = pts.length;
    if (!e.takeoffLat) { out.takeoffLat = round(pts[0][1], 6); out.takeoffLon = round(pts[0][0], 6); }
  } else { out.track = 'no GPS in Skydio telemetry'; out.trackPoints = 0; }
  return out;
}
async function mediaCount(token, id) {
  let photos = 0, videos = 0;
  for (let page = 1; page <= 20; page++) {
    const data = await get(token, `/media_files?flight_id=${encodeURIComponent(id)}&per_page=500&page_number=${page}`);
    const list = listOf(data, 'files');
    for (const m of list) { const k = String(m.kind || ''); if (/image/i.test(k)) photos++; else if (/video/i.test(k)) videos++; }
    const pg = data.pagination || {};
    if (!list.length || list.length < 500 || (pg.total_pages && page >= pg.total_pages)) break;
  }
  return { photos, videos };
}

async function sync(u) {
  const token = (u.skydioToken || '').trim();
  if (!token) throw new Error('No Skydio Cloud token saved yet');
  const [list, veh] = await Promise.all([allFlights(token), vehicleNames(token)]);
  const out = { found: list.length, added: 0, updated: 0, skipped: 0, tracks: 0, telemetryError: '', mediaError: '' };
  for (const f of list) {
    const e = toEntry(f, veh);
    if (!e) { out.skipped++; continue; }
    const had = store.flightBySha(u.id, e.sha256);
    // keep what earlier syncs fetched (track, battery %, photos…) so it isn't fetched again
    if (had) for (const k of TELEMETRY_FIELDS) if (had[k] !== undefined && (e[k] === undefined || (k === 'track' || k === 'trackPoints') && had.track === 'ok')) e[k] = had[k];
    if (had && had.takeoffLat != null && e.takeoffLat == null) { e.takeoffLat = had.takeoffLat; e.takeoffLon = had.takeoffLon; }
    if (f.has_telemetry && e.track !== 'ok' && !out.telemetryError) {
      try { const t = await telemetryFor(token, e); if (t.trackFile && had?.trackFile) db.deleteFile(had.trackFile); Object.assign(e, t); e.telemetryAt = new Date().toISOString(); delete e.telemetryError; if (e.track === 'ok') out.tracks++; }
      catch (err) { e.telemetryError = err.message; if (err.status === 401 || err.status === 403) out.telemetryError = 'The Skydio token has no access to Flight Telemetry, so no tracks or battery figures came through. Make a token with Flight Telemetry (read) ticked.'; }
    } else if (!f.has_telemetry && e.track !== 'ok') e.track = 'no telemetry in Skydio Cloud';
    if (e.photos === undefined && !out.mediaError) {
      try { Object.assign(e, await mediaCount(token, f.flight_id)); }
      catch (err) { if (err.status === 401 || err.status === 403) out.mediaError = 'No access to Media in Skydio Cloud, so photo counts are missing (needs Media (read) on the token, and Media Sync).'; }
    }
    store.putFlight(u.id, e);
    had ? out.updated++ : out.added++;
  }
  if (out.added || out.updated) store.renumber(u.id);
  db.update('lbUsers', u.id, { skydioSyncedAt: new Date().toISOString(), skydioLast: out });
  store.noteUpload(u.id, { file: `Skydio Cloud sync: ${out.found} flights`, status: `${out.added} new, ${out.updated} already here, ${out.tracks} tracks`, via: 'Skydio Cloud' });
  return out;
}

module.exports = { sync, toEntry };
