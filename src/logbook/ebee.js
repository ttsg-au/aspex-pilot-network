// Logs one senseFly eBee flight. The browser joins the flight's .bb3 parts, reads the GNSS
// fixes with BB3 (public/bb3.cjs) and sends ~1 per second; this works out the flight from them.
const db = require('../db');
const store = require('./store');
const BB3 = require('./public/bb3.cjs');

const localFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const local = (ms) => localFmt.format(new Date(ms)).replace(',', '');
const round = (n, dp) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(dp)));
const MODELS = { IX: 'eBee X' };                    // by serial prefix; anything else shows as "eBee"

async function processFlight(user, { name, sha256, bytes, parts, fixes }) {
  const info = BB3.nameInfo(String(name || '') + '_part001.bb3');
  if (!info) throw new Error('That isn’t an eBee flight log name (e.g. IX-12-61425_0072).');
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error('Missing file fingerprint.');
  const fx = (Array.isArray(fixes) ? fixes : []).filter(f => Array.isArray(f) && f.length >= 5 && f.every(Number.isFinite));
  const uid = user.id, file = info.base + '.bb3';
  const existing = store.flightBySha(uid, sha256);
  if (existing && existing.track === 'ok') return { file, sha256, status: 'already had', flight: existing };

  const s = BB3.summarise(fx);
  const entry = {
    file, sha256, bytes: Number(bytes) || 0, logVersion: 'eBee bb3', bb3Parts: Number(parts) || 0,
    aircraftModel: MODELS[info.serial.slice(0, 2).toUpperCase()] || 'eBee', aircraftName: '', aircraftSn: info.serial,
    ebeeFlightNo: info.flight, app: 'senseFly eMotion', photos: null,
    isFlight: !!s.isFlight, track: 'not done', trackPoints: 0,
  };
  if (s.startMs) Object.assign(entry, { startUtc: new Date(s.startMs).toISOString(), startLocal: local(s.startMs), endLocal: local(s.endMs) });
  if (!fx.length) entry.track = 'no fix';
  else if (!s.isFlight) entry.track = 'not a flight';
  else {
    Object.assign(entry, {
      durationMin: round(s.durationMin, 1), airMin: round(s.durationMin, 1),
      takeoffLat: round(s.takeoffLat, 6), takeoffLon: round(s.takeoffLon, 6),
      distanceKm: round(s.distanceKm, 2), maxHeightM: round(s.maxHeightM, 1),
      maxHSpeedMs: round(s.maxHSpeedMs, 1), maxRangeM: Math.round(s.maxRangeM),
    });
    const pts = fx.filter(f => f[0] >= s.startMs && f[0] <= s.endMs)
      .map(f => [round(f[2], 7), round(f[1], 7), round(f[3] - s.groundHeight, 1)]);
    const geo = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
      properties: { file, start: entry.startLocal, durationMin: entry.durationMin, aircraftSn: entry.aircraftSn },
      geometry: { type: 'LineString', coordinates: pts } }] });
    if (existing?.trackFile) db.deleteFile(existing.trackFile);
    entry.trackFile = await db.saveFile(Buffer.from(geo), info.base + '.geojson', 'application/geo+json');
    entry.track = 'ok'; entry.trackPoints = pts.length;
  }
  const flight = store.putFlight(uid, entry);
  store.renumber(uid);
  return { file, sha256, status: existing ? 'updated' : 'added', flight };
}

module.exports = { processFlight };
