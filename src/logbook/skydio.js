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
  const r = await fetch(API + path, { headers: { Authorization: token, accept: 'application/json' } });
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
    aircraftModel: v.type ? `Skydio ${v.type}` : 'Skydio', aircraftName: v.name || '', aircraftSn: f.vehicle_serial || '',
    batterySn: f.battery_serial || '', skydioPilot: f.user_email || '',
    isFlight: mins >= 0.1, track: f.has_telemetry ? 'in Skydio Cloud' : 'none', trackPoints: 0,
  };
}

async function sync(u) {
  const token = (u.skydioToken || '').trim();
  if (!token) throw new Error('No Skydio Cloud token saved yet');
  const [list, veh] = await Promise.all([allFlights(token), vehicleNames(token)]);
  const out = { found: list.length, added: 0, updated: 0, skipped: 0 };
  for (const f of list) {
    const e = toEntry(f, veh);
    if (!e) { out.skipped++; continue; }
    const had = store.flightBySha(u.id, e.sha256);
    store.putFlight(u.id, e);
    had ? out.updated++ : out.added++;
  }
  if (out.added || out.updated) store.renumber(u.id);
  db.update('lbUsers', u.id, { skydioSyncedAt: new Date().toISOString(), skydioLast: out });
  store.noteUpload(u.id, { file: `Skydio Cloud sync: ${out.found} flights`, status: `${out.added} new, ${out.updated} already here`, via: 'Skydio Cloud' });
  return out;
}

module.exports = { sync, toEntry };
