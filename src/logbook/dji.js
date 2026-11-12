// Reads one DJI flight record (.txt), logs it, and decrypts its GPS track and battery data
// using the DJI developer key (DJI's Open API hands out the per-file decryption keys).
const crypto = require('crypto');
const db = require('../db');
const store = require('./store');

const TZ = 'Australia/Sydney';
const localFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const local = (d) => localFmt.format(d).replace(',', '');           // 2026-11-09 14:26:57
const round = (n, dp) => (n == null || Number.isNaN(n) ? null : Number(Number(n).toFixed(dp)));
const metres = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180, x = (lon2 - lon1) * r * Math.cos((lat1 + lat2) / 2 * r), y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
};
let parser = null;
const loadParser = async () => (parser ||= (await import('dji-log-parser-js')).DJILog);

// A file is "done" once it has a result that re-uploading can't improve.
const FINAL = new Set(['ok', 'no fix', 'not a flight', 'track unreadable']);
const isDone = (f) => f && FINAL.has(f.track)
  && !(f.track === 'ok' && f.batteryCycles == null && !f.batteryCyclesChecked);   // look again for a missing charge-cycle count

async function processFile(user, buf, file) {
  const uid = user.id;
  const DJILog = await loadParser();
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const existing = store.flightBySha(uid, sha256);
  // Network pilots without their own DJI developer key use Aspex's (the owner account's).
  const apiKey = (user.djiApiKey || db.all('lbUsers').find(u => u.role === 'owner')?.djiApiKey || '').trim();
  if (existing && FINAL.has(existing.track)) {
    // Already logged. The only thing a re-import can add is a missing charge-cycle count, and it
    // changes nothing else on the flight (the pilot's CASA details stay as they are).
    if (isDone(existing)) return { file, sha256, status: 'already had', flight: existing };
    let note;
    try {
      const log = new DJILog(new Uint8Array(buf));
      let keys = store.getKeys(sha256);
      if (!keys && apiKey && log.version >= 13) { keys = await log.fetchKeychains(apiKey); store.putKeys(sha256, keys); }
      if (!keys && log.version >= 13) return { file, sha256, status: 'already had', flight: existing, note: 'add the DJI key in Settings to read its battery cycles' };
      const cyc = batteryCycles(log, keys);
      note = cyc.note;
      const flight = db.update('lbFlights', existing.id, { batteryCycles: cyc.cycles ?? null, batteryCyclesChecked: true, batteryCyclesNote: note });
      return { file, sha256, status: 'cycles checked', flight };
    } catch (e) { return { file, sha256, status: 'already had', flight: existing, note: 'cycle check failed: ' + String(e?.message || e) }; }
  }

  let entry;
  try {
    const log = new DJILog(new Uint8Array(buf));
    const d = log.details;
    const start = new Date(d.startTime);
    const end = new Date(start.getTime() + d.totalTime * 1000);
    const isFlight = d.maxHeight >= 1 || d.totalDistance >= 0.01;   // motor starts with no take-off log too
    entry = {
      file, sha256, bytes: buf.length, logVersion: log.version,
      startUtc: start.toISOString(), startLocal: local(start), endLocal: local(end),
      durationMin: round(d.totalTime / 60, 1),
      takeoffLat: round(d.latitude, 6), takeoffLon: round(d.longitude, 6),
      distanceKm: round(d.totalDistance, 2), maxHeightM: round(d.maxHeight, 1),
      maxHSpeedMs: round(d.maxHorizontalSpeed, 1), photos: d.captureNum, videoSec: d.videoTime,
      aircraftModel: d.productType, aircraftName: d.aircraftName, aircraftSn: d.aircraftSn,
      rcSn: d.rcSn, cameraSn: d.cameraSn, batterySn: d.batterySn,
      app: `${d.appPlatform} ${d.appVersion}`,
      isFlight, track: 'not done', trackPoints: 0,
    };

    if (isFlight) {
      let keychains = null, keyError = '';
      if (log.version >= 13) {
        keychains = store.getKeys(sha256);
        if (!keychains && apiKey) {
          try { keychains = await log.fetchKeychains(apiKey); store.putKeys(sha256, keychains); }
          catch (e) { keyError = String(e?.message || e); }
        }
      }
      if (log.version < 13 || keychains) {
        let frames = null;
        try { frames = log.frames(keychains); }
        catch (e) { entry.track = 'track unreadable'; entry.trackError = String(e?.message || e); }
        if (frames) {
          Object.assign(entry, flightStats(frames, entry));
          const cyc = batteryCycles(log, keychains);
          if (cyc.cycles != null) entry.batteryCycles = cyc.cycles;
          entry.batteryCyclesChecked = true; entry.batteryCyclesNote = cyc.note;
          const pts = trackPoints(frames, entry);
          if (pts.length >= 2) {
            const geo = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
              properties: { file, start: entry.startLocal, durationMin: entry.durationMin, aircraftSn: entry.aircraftSn, batterySn: entry.batterySn },
              geometry: { type: 'LineString', coordinates: pts } }] });
            if (existing?.trackFile) db.deleteFile(existing.trackFile);
            entry.trackFile = await db.saveFile(Buffer.from(geo), file.replace(/\.txt$/i, '.geojson'), 'application/geo+json');
            entry.track = 'ok'; entry.trackPoints = pts.length;
          } else entry.track = 'no fix';
        }
      } else {
        entry.track = apiKey ? 'key error' : 'no key';
        if (keyError) entry.trackError = keyError;
      }
    } else entry.track = 'not a flight';
  } catch (e) {
    entry = { file, sha256, bytes: buf.length, track: 'error', error: String(e?.message || e), isFlight: false };
  }
  const flight = store.putFlight(uid, entry);
  store.renumber(uid);
  return { file, sha256, status: existing ? 'updated' : 'added', flight };
}

// The battery's charge-cycle count, as the battery itself reports it: { cycles, note }.
// The note says what the file held, so a missing count can be explained.
function batteryCycles(log, keychains) {
  const seen = {}; let staticRec = null, center = null;
  try {
    for (const r of log.records(keychains)) {
      seen[r.type] = (seen[r.type] || 0) + 1;
      if (r.type === 'SmartBatteryGroup') seen['SBG:' + r.content.type] = (seen['SBG:' + r.content.type] || 0) + 1;
      if (!staticRec && r.type === 'SmartBatteryGroup' && r.content.type === 'SmartBatteryStatic') staticRec = r.content;
      if (!center && r.type === 'CenterBattery') center = r.content;
    }
  } catch (e) { return { cycles: null, note: 'records unreadable: ' + String(e?.message || e).slice(0, 120) }; }
  if (staticRec && staticRec.loop_times) {
    const v = staticRec.loop_times;                      // newer aircraft store it shifted one byte
    const c = v >= 256 && v % 256 === 0 ? v / 256 : v;
    if (c < 3000) return { cycles: c, note: 'SmartBatteryStatic loop_times ' + v };
  }
  if (center && center.numberOfDischarges) return { cycles: center.numberOfDischarges, note: 'CenterBattery numberOfDischarges' };
  const kinds = Object.entries(seen).filter(([k]) => /Battery|SBG/.test(k)).map(([k, n]) => `${k}×${n}`).join(', ') || 'no battery records';
  const detail = staticRec ? ` static: loop_times=${staticRec.loop_times}, design=${staticRec.designed_capacity}, life=${staticRec.battery_life}` : '';
  return { cycles: null, note: `no cycle count (${kinds}${detail})` };
}

function trackPoints(frames, entry) {
  const pts = []; let dropped = 0;
  for (let i = 0; i < frames.length; i += 5) {                       // ~2 points per second
    const o = frames[i].osd; if (!o) continue;
    const lat = o.latitude, lon = o.longitude, h = o.height;
    if (Math.abs(lat) < 0.0001 || Math.abs(lon) < 0.0001) continue;   // no GPS fix yet
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180
        || !Number.isFinite(h) || Math.abs(h) > 2000) { dropped++; continue; }   // corrupt record
    const prev = pts[pts.length - 1];
    if (prev && metres(prev[1], prev[0], lat, lon) > 500) { dropped++; continue; } // impossible jump
    pts.push([round(lon, 7), round(lat, 7), round(h, 1)]);
  }
  entry.trackPointsDropped = dropped;
  return pts;
}

// Per-flight numbers from the full telemetry (battery, air time, range).
function flightStats(frames, e) {
  let first = null, last = null, minCell = Infinity, maxDev = 0, maxTemp = -Infinity, fullCap = 0;
  let maxFly = 0, maxRange = 0, home = null;
  for (const f of frames) {
    const b = f.battery, o = f.osd;
    if (b && b.chargeLevel > 0 && b.chargeLevel <= 100) { if (!first) first = b; last = b; }
    if (b) {
      for (const v of b.cellVoltages || []) if (v > 2.5 && v < 4.5 && v < minCell) minCell = v;
      if (b.cellVoltageDeviation > maxDev && b.cellVoltageDeviation < 1) maxDev = b.cellVoltageDeviation;
      if (b.temperature > maxTemp && b.temperature < 90) maxTemp = b.temperature;
      if (!fullCap && b.fullCapacity > 0) fullCap = b.fullCapacity;
    }
    if (o) {
      if (o.flyTime > maxFly && o.flyTime < 7200) maxFly = o.flyTime;
      const ok = Number.isFinite(o.latitude) && Math.abs(o.latitude) > 0.0001 && Math.abs(o.latitude) <= 90
        && Number.isFinite(o.longitude) && Math.abs(o.longitude) > 0.0001 && Math.abs(o.longitude) <= 180;
      if (ok) {
        if (!home) home = [o.latitude, o.longitude];
        const d = metres(home[0], home[1], o.latitude, o.longitude);
        if (d > maxRange && d < 20000) maxRange = d;
      }
    }
  }
  return {
    airMin: maxFly ? round(maxFly / 60, 1) : e.durationMin,
    batteryStartPct: first?.chargeLevel ?? null,
    batteryEndPct: last?.chargeLevel ?? null,
    batteryUsedMah: first && last ? Math.max(0, Math.round(first.currentCapacity - last.currentCapacity)) : null,
    batteryFullMah: fullCap || null,
    batteryCells: first?.cellNum || null,
    minCellV: Number.isFinite(minCell) ? round(minCell, 2) : null,
    maxCellDevV: round(maxDev, 3),
    maxBatteryTempC: Number.isFinite(maxTemp) ? round(maxTemp, 1) : null,
    maxRangeM: Math.round(maxRange),
  };
}

function kml(f, geojson) {
  const pts = geojson.features[0].geometry.coordinates;
  const x = (s) => String(s ?? '').replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const name = x(`${f.flightNo || ''} ${f.startLocal} (${f.durationMin} min)`.trim());
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name>
<Style id="t"><LineStyle><color>ff00a5ff</color><width>3</width></LineStyle></Style>
<Placemark><name>${name}</name><description>${x(f.aircraftModel)} ${x(f.aircraftSn)} - battery ${x(f.batterySn)} - ${f.distanceKm} km, max ${f.maxHeightM} m</description>
<styleUrl>#t</styleUrl><LineString><altitudeMode>relativeToGround</altitudeMode><coordinates>${pts.map(p => p.join(',')).join(' ')}</coordinates></LineString></Placemark>
<Placemark><name>Take-off</name><Point><coordinates>${pts[0][0]},${pts[0][1]},0</coordinates></Point></Placemark>
</Document></kml>`;
}

function csv(rows) {
  const cols = [
    ['Flight no', 'flightNo'], ['Date / take-off', 'startLocal'], ['Landing', 'endLocal'], ['Minutes', 'durationMin'],
    ['Flight?', r => (r.isFlight ? 'yes' : 'no take-off')], ['Pilot in command', r => r.pic || r.pilot || ''], ['Operation', r => r.opType || ''],
    ['Serviceable after', r => r.serviceable || ''], ['Defect', 'defect'],
    ['Take-off lat', 'takeoffLat'], ['Take-off lon', 'takeoffLon'], ['Distance km', 'distanceKm'],
    ['Max height m', 'maxHeightM'], ['Photos', 'photos'], ['Aircraft', 'aircraftModel'],
    ['Aircraft SN', 'aircraftSn'], ['Battery SN', 'batterySn'], ['Battery start %', 'batteryStartPct'], ['Battery end %', 'batteryEndPct'],
    ['mAh used', 'batteryUsedMah'], ['Battery full mAh', 'batteryFullMah'], ['Min cell V', 'minCellV'], ['Max batt temp C', 'maxBatteryTempC'],
    ['Max range m', 'maxRangeM'], ['Air minutes', 'airMin'], ['RC SN', 'rcSn'], ['GPS track', 'track'], ['Notes', 'notes'], ['File', 'file'],
  ];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map(c => c[0]).join(',')];
  for (const r of rows) lines.push(cols.map(([, k]) => esc(typeof k === 'function' ? k(r) : r[k])).join(','));
  return '﻿' + lines.join('\r\n');
}

module.exports = { processFile, isDone, kml, csv };
