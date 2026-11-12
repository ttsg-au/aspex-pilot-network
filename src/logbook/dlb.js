// Moving flight history across from Drone Logbook (dronelogbook.com) CSV exports.
// The Flights export only has ID codes, so the Drones and Battery exports (and Locations, if given)
// turn those into aircraft, serial numbers and battery codes. Flights already in this logbook are
// matched (same aircraft, same duration, start time within the measured clock difference) and skipped,
// so nothing is doubled up. Everything is previewed before anything is saved.
const crypto = require('crypto');
const store = require('./store');

// ---------- CSV ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return rows.filter(r => r.some(x => x.trim() !== '')).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const col = (rec, ...names) => {                      // find a column by (part of) its heading
  for (const n of names) { const k = Object.keys(rec).find(k => k.toLowerCase().startsWith(n.toLowerCase())); if (k && rec[k] !== '') return rec[k]; }
  return '';
};
// Which export is this? (judged by its headings)
function kindOf(rows) {
  const h = rows[0] ? Object.keys(rows[0]).join('|').toLowerCase() : '';
  if (h.includes('droneguid') && h.includes('duration')) return 'flights';
  if (h.includes('drone name')) return 'drones';
  if (h.includes('battery name')) return 'batteries';
  if (h.includes('location') || h.includes('latitude')) return 'locations';
  if (h.includes('customer')) return 'customers';
  if (h.includes('project')) return 'projects';
  return '';
}

// ---------- time ----------
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const local = (ms) => fmt.format(new Date(ms)).replace(',', '');
const plain = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);   // wall-clock text, no time-zone change
const asUtcMs = (s) => Date.parse(s.replace(' ', 'T') + 'Z');            // treat a "YYYY-MM-DD HH:MM:SS" as if UTC
function sydneyToUtc(s) {                                                  // Sydney wall-clock text -> real UTC ms
  let t = asUtcMs(s) - 10 * 3600e3;
  for (let k = 0; k < 2; k++) t += asUtcMs(s) - asUtcMs(local(t));
  return t;
}
const MODEL = { 'mavic 3 thermal': 'Mavic3Enterprise', 'mavic mini': 'Mavic Mini', 'phantom 4 pro v2': 'Phantom4ProV2', 'phantom 4 pro': 'Phantom4Pro', 'ebee plus': 'eBee Plus', '2+ enterprise': 'Skydio 2+' };

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const sameAircraft = (sn, f) => {
  const a = String(sn || '').toUpperCase(), b = String(f.aircraftSn || '').toUpperCase();
  return a && b && (a.startsWith(b) || b.startsWith(a));
};
const durOk = (sec, f) => f.durationMin != null && Math.abs(sec - f.durationMin * 60) <= Math.max(12, sec * 0.03);

// Work out what an import would do. Returns { offsetMin, counts, byAircraft, rows, entries }.
function plan(user, files) {
  const got = {};
  for (const text of files || []) { const rows = parseCsv(text); const k = kindOf(rows); if (k) got[k] = rows; }
  if (!got.flights) throw new Error('Choose the Flights export (the file with all your flights) – it wasn’t among these files.');
  const byId = (rows) => Object.fromEntries((rows || []).map(r => [col(r, 'Internal ID') || r.GUID || '', r]).filter(([k]) => k));
  const drones = byId(got.drones), bats = byId(got.batteries), locs = byId(got.locations);
  const existing = store.flights(user.id);
  const bySha = new Set(existing.map(f => f.sha256));

  const prep = got.flights.map(r => {
    const d = drones[col(r, 'DroneGUID')] || {};
    const sn = col(d, 'Serial #'), name = col(d, 'Drone Name'), model = col(d, 'Model');
    const batId = col(r, 'EquipmentGUID').split(/\s+/).filter(Boolean)[0] || '';
    const b = bats[batId] || {};
    const loc = locs[col(r, 'LocationGUID')] || {};
    return { r, guid: col(r, 'FlightGUID'), when: col(r, 'Date'), sec: Number(col(r, 'Duration')) || 0,
      sn, name, model, droneId: col(r, 'DroneGUID'), batterySn: col(b, 'Serial #') || col(b, 'Battery Name'), batteryName: col(b, 'Battery Name'), loc };
  });

  // Measure the clock difference between Drone Logbook and this logbook from flights that are in both.
  const diffs = [];
  for (const p of prep) {
    if (!p.when || p.when < '2000') continue;
    const t = asUtcMs(p.when);
    for (const f of existing) {
      if (!f.startLocal || !durOk(p.sec, f) || !(sameAircraft(p.sn, f) || (/skydio/i.test(p.model + p.name) && /skydio/i.test(f.aircraftModel || '')))) continue;
      const dm = (t - asUtcMs(f.startLocal)) / 60000;
      if (Math.abs(dm) <= 14 * 60) { diffs.push(dm); break; }
    }
  }
  const offsetMin = diffs.length >= 3 ? Math.round(median(diffs) / 30) * 30 : 0;

  const rows = [], entries = [], used = new Set();
  for (const p of prep) {
    const row = { when: p.when, aircraft: p.name || p.model || p.droneId.slice(0, 8), minutes: Math.round(p.sec / 6) / 10, battery: p.batteryName || '' };
    const sha = 'dlb-' + (p.guid || crypto.createHash('sha1').update(JSON.stringify(p.r)).digest('hex'));
    if (bySha.has(sha)) { rows.push({ ...row, status: 'skip', why: 'imported before' }); continue; }
    if (!p.when || p.when < '2000') { rows.push({ ...row, status: 'check', why: 'no proper date (drone had no GPS time) – not imported' }); continue; }
    if (p.sec <= 0) { rows.push({ ...row, status: 'check', why: 'zero duration – not imported' }); continue; }
    const startLocal = plain(asUtcMs(p.when) - offsetMin * 60000);       // corrected to this logbook's clock (wall-clock text)
    const startMs = sydneyToUtc(startLocal);
    const sameAc = (f) => sameAircraft(p.sn, f) || (/skydio/i.test(p.model + p.name) && /skydio/i.test(f.aircraftModel || ''));
    const gap = (f) => Math.abs(asUtcMs(f.startLocal) - asUtcMs(startLocal));
    // Same flight if: same aircraft and duration, and either within 10 min once the clock is corrected,
    // or (in case another source keeps a different clock) within 14 h with the duration within 4 seconds.
    const twin = existing.find(f => f.startLocal && !used.has(f.sha256) && sameAc(f) && durOk(p.sec, f) && gap(f) <= 10 * 60000)
      || existing.find(f => f.startLocal && !used.has(f.sha256) && sameAc(f) && f.durationMin != null && Math.abs(p.sec - f.durationMin * 60) <= 4 && gap(f) <= 14 * 3600e3);
    if (twin) used.add(twin.sha256);
    if (twin) { rows.push({ ...row, status: 'skip', why: `already in the logbook (${twin.flightNo || twin.startLocal})` }); continue; }
    const r = p.r, lat = Number(col(p.loc, 'Latitude', 'Lat')), lon = Number(col(p.loc, 'Longitude', 'Lon', 'Lng'));
    const extra = [col(r, 'Flight Notes'), col(r, 'Night Flight') === 'Y' ? 'Night flight (per Drone Logbook).' : '',
      [col(r, 'Cloud Cover'), col(r, 'Temperature'), col(r, 'Wind'), col(r, 'Humidity')].some(Boolean)
        ? `Weather: cloud ${col(r, 'Cloud Cover') || '–'}, ${col(r, 'Temperature') || '–'}, wind ${col(r, 'Wind') || '–'}, humidity ${col(r, 'Humidity') || '–'}.` : ''].filter(Boolean).join(' ');
    const pic = col(r, 'Pilot in Command Email');
    entries.push({
      file: `Drone Logbook ${startLocal.slice(0, 16)} ${row.aircraft}`, sha256: sha, source: 'dronelogbook', dlbFlightId: p.guid,
      startUtc: new Date(startMs).toISOString(), startLocal, endLocal: plain(asUtcMs(startLocal) + p.sec * 1000),
      durationMin: Math.round(p.sec / 6) / 10, distanceKm: Number(col(r, 'Travelled Distance')) / 1000 || null, maxHeightM: Number(col(r, 'Max Altitude')) || null,
      takeoffLat: Number.isFinite(lat) && lat ? lat : null, takeoffLon: Number.isFinite(lon) && lon ? lon : null,
      aircraftModel: MODEL[(p.model || '').toLowerCase()] || p.model || 'Unknown aircraft', aircraftName: p.name, aircraftSn: p.sn || (p.name ? 'DLB ' + p.name : ''),
      batterySn: p.batterySn || '', dlbLocation: col(p.loc, 'Location Name', 'Name'),
      opType: col(r, 'Operation Type'), landings: Number(col(r, 'Landings')) || 1,
      pic: pic && pic.toLowerCase() !== String(user.email || '').toLowerCase() ? pic : '',
      notes: ('From Drone Logbook. ' + extra).trim(),
      isFlight: true, track: 'no track (Drone Logbook)', trackPoints: 0, photos: null,
    });
    rows.push({ ...row, status: 'new', why: '' });
  }
  const counts = { new: 0, skip: 0, check: 0 }, byAircraft = {};
  for (const x of rows) { counts[x.status]++; const a = (byAircraft[x.aircraft] ||= { new: 0, skip: 0, check: 0 }); a[x.status]++; }
  return { offsetMin, matchedForClock: diffs.length, have: Object.keys(got), counts, byAircraft, rows, entries };
}

function commit(user, files) {
  const p = plan(user, files);
  for (const e of p.entries) store.putFlight(user.id, e);
  if (p.entries.length) store.renumber(user.id);
  return { ...p, imported: p.entries.length, entries: undefined, rows: undefined };
}

module.exports = { plan, commit, parseCsv };
