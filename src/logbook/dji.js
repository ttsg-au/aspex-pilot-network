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
// The reader names aircraft it knows ("Mavic3Enterprise"); newer ones it doesn't know come back as
// { Unknown: <type number> }. Show those as "DJI aircraft (type N)" rather than "[object Object]".
function modelName(pt) {
  if (typeof pt === 'string' && pt) return pt;
  const n = pt && typeof pt === 'object' ? Object.values(pt)[0] : null;
  return n != null && n !== '' ? `DJI aircraft (type ${n})` : 'DJI aircraft';
}
const isDone = (f) => f && FINAL.has(f.track);
// Logged before charge cycles were read: a browser re-import can fill the count in.
const CYCLE_CHECK = 3;   // bump to let browser re-imports read the cycle count again
const needsCycles = (f) => f && f.track === 'ok' && (f.batteryCycles == null ? !f.batteryCyclesChecked : f.batteryCyclesVer !== CYCLE_CHECK);

// Ask DJI for a log's decryption keys. Done here rather than with the parser's own fetchKeychains, which
// reports every failure as "Invalid Api Key" - this passes on DJI's actual answer (HTTP status and message).
// The parser's own request is tried first (it's what has always worked); only if that fails is the request
// repeated directly, to get DJI's real reason (or the keys, if the second try succeeds).
async function fetchKeys(log, apiKey) {
  try { return await log.fetchKeychains(apiKey); } catch {}
  return fetchKeysDirect(log, apiKey);
}
async function fetchKeysDirect(log, apiKey) {
  const body = JSON.stringify(log.keychainsRequest());
  let res;
  try {
    res = await fetch('https://dev.dji.com/openapi/v1/flight-records/keychains', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Api-Key': apiKey }, body, signal: AbortSignal.timeout(30000) });
  } catch (e) { throw new Error('couldn’t reach DJI (' + String(e?.message || e).slice(0, 80) + ')'); }
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`DJI said HTTP ${res.status}${j?.result?.msg ? ': ' + j.result.msg : text ? ': ' + text.slice(0, 160) : ''}`);
  if (j?.result && j.result.code !== 0) throw new Error(`DJI said code ${j.result.code}: ${j.result.msg || ''}`);
  if (!Array.isArray(j?.data)) throw new Error('DJI sent no keys back');
  return j.data;
}

// Flights read before the two-battery / hot-swap fixes can have impossible figures: read those again in full.
const badFigures = (f) => f && f.isFlight && (f.videoSec > 86400 || (/Matrice ?30/i.test(f.aircraftModel || '') && !f.batteries) || !(f.durationMin > 0) || f.durationMin > 180 || f.batteryCycles >= 1000 || (f.airMin > 0 && f.durationMin > 0 && f.airMin > f.durationMin * 1.5 + 1));

async function processFile(user, buf, file, { cycleCheck = false } = {}) {
  const uid = user.id;
  const DJILog = await loadParser();
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const existing = store.flightBySha(uid, sha256);
  // Network pilots without their own DJI developer key use Aspex's (the owner account's).
  const apiKey = (user.djiApiKey || db.all('lbUsers').find(u => u.role === 'owner')?.djiApiKey || '').trim();
  if (existing && FINAL.has(existing.track) && !badFigures(existing)) {
    // Already logged. The only thing a re-import can add is a missing charge-cycle count, and it
    // changes nothing else on the flight (the pilot's CASA details stay as they are).
    if (!cycleCheck || !needsCycles(existing)) return { file, sha256, status: 'already had', flight: existing };
    let note;
    try {
      const log = new DJILog(new Uint8Array(buf));
      let keys = store.getKeys(sha256);
      if (!keys && apiKey && log.version >= 13) { keys = await fetchKeys(log, apiKey); store.putKeys(sha256, keys); }
      if (!keys && log.version >= 13) return { file, sha256, status: 'already had', flight: existing, note: 'add the DJI key in Settings to read its battery cycles' };
      const cyc = batteryCycles(log, keys);
      note = cyc.note;
      const flight = db.update('lbFlights', existing.id, { batteryCycles: cyc.cycles ?? null, batteryCyclesChecked: !/^records unreadable/.test(note), batteryCyclesNote: note, batteryCyclesVer: CYCLE_CHECK });
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
      maxHSpeedMs: round(d.maxHorizontalSpeed, 1), photos: d.captureNum, videoSec: d.videoTime > Math.max(d.totalTime, 600) * 2 ? round(d.videoTime / 1000, 1) : d.videoTime,
      aircraftModel: modelName(d.productType), aircraftName: d.aircraftName, aircraftSn: d.aircraftSn,
      rcSn: d.rcSn, cameraSn: d.cameraSn, batterySn: d.batterySn,
      app: `${d.appPlatform} ${d.appVersion}`,
      isFlight, track: 'not done', trackPoints: 0,
    };

    if (isFlight) {
      let keychains = null, keyError = '';
      if (log.version >= 13) {
        keychains = store.getKeys(sha256);
        if (!keychains && apiKey) {
          try { keychains = await fetchKeys(log, apiKey); store.putKeys(sha256, keychains); }
          catch (e) { keyError = String(e?.message || e); }
        }
      }
      if (log.version < 13 || keychains) {
        let frames = null;
        try { frames = log.frames(keychains); }
        catch (e) { entry.track = 'track unreadable'; entry.trackError = String(e?.message || e); }
        if (frames) {
          Object.assign(entry, flightStats(frames, entry));
          // The header's total time is wrong when the counter carried over or wrapped (a negative time on an M30).
          if (!(entry.durationMin > 0) || entry.durationMin > 180) {
            const s = airSeconds(frames);
            if (s > 0) { entry.durationMin = round(s / 60, 1); entry.endLocal = local(new Date(start.getTime() + s * 1000)); }
          }
          const cyc = batteryCycles(log, keychains);
          if (cyc.cycles != null) entry.batteryCycles = cyc.cycles;
          if (cyc.slot) entry.batterySlot = cyc.slot;              // two-battery aircraft: which slot DJI logged
          if (cyc.batteries) entry.batteries = cyc.batteries;
          entry.batteryCyclesChecked = true; entry.batteryCyclesNote = cyc.note; entry.batteryCyclesVer = CYCLE_CHECK;
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
  const packs = {};                               // two-battery aircraft: each slot's charge and temperature
  try {
    for (const r of log.records(keychains)) {
      seen[r.type] = (seen[r.type] || 0) + 1;
      if (r.type === 'SmartBatteryGroup' && r.content.type === 'SmartBatteryDynamic' && r.content.index >= 1 && r.content.index <= 2) {
        const c = r.content, p = (packs[c.index] ||= { slot: c.index, startPct: null, endPct: null, fullMah: null, maxTempC: -Infinity, minV: Infinity });
        if (c.capacity_percent > 0 && c.capacity_percent <= 100) { if (p.startPct == null) p.startPct = c.capacity_percent; p.endPct = c.capacity_percent; }
        if (c.full_capacity > 0 && c.full_capacity < 40000) p.fullMah = c.full_capacity;
        if (c.temperature > -40 && c.temperature < 90 && c.temperature > p.maxTempC) p.maxTempC = c.temperature;
        if (c.current_voltage > 5 && c.current_voltage < p.minV) p.minV = c.current_voltage;
      }
      if (r.type === 'SmartBatteryGroup') seen['SBG:' + r.content.type] = (seen['SBG:' + r.content.type] || 0) + 1;
      if (!staticRec && r.type === 'SmartBatteryGroup' && r.content.type === 'SmartBatteryStatic') staticRec = r.content;
      if (!center && r.type === 'CenterBattery') center = r.content;
    }
  } catch (e) { return { cycles: null, note: 'records unreadable: ' + String(e?.message || e).slice(0, 120) }; }
  const batteries = Object.values(packs).length > 1 ? Object.values(packs).map(p => ({ ...p,
    maxTempC: Number.isFinite(p.maxTempC) ? round(p.maxTempC, 1) : null, minV: Number.isFinite(p.minV) ? round(p.minV, 2) : null })) : null;
  if (staticRec && staticRec.loop_times) {
    const v = staticRec.loop_times;
    // On newer aircraft (e.g. Mavic 3 Enterprise) the record has one extra byte, so the reader sees every
    // field one byte early: designed capacity 5000 reads as 1280000 (5000 x 256). Then the real cycle count
    // is the high byte of loop_times plus, as its own high byte, the lowest byte of the next field.
    // The byte the reader takes as the capacity's lowest is really the battery's slot: 0 on single-battery
    // aircraft, 1 or 2 on two-battery ones like the Matrice 30 (5880 mAh in slot 1 reads as 5880 x 256 + 1).
    const dc = staticRec.designed_capacity, slot = dc & 0xff, cap = dc >> 8;
    const shifted = slot <= 3 && cap >= 1000 && cap <= 40000;
    const c = shifted ? (v >> 8) | ((staticRec.full_voltage & 0xff) << 8) : v;
    const raw = `raw loop_times ${v}, design ${dc}${shifted ? ` (${cap} mAh, slot ${slot})` : ' mAh'}, full ${staticRec.full_voltage}, life ${staticRec.battery_life}, type ${staticRec.battery_type}, version ${(staticRec.version_number || []).join('.')}`;
    if (c < 3000) return { cycles: c, slot: shifted ? slot : null, note: raw, batteries };
  }
  if (center && center.numberOfDischarges) return { cycles: center.numberOfDischarges, note: 'CenterBattery numberOfDischarges', batteries };
  const kinds = Object.entries(seen).filter(([k]) => /Battery|SBG/.test(k)).map(([k, n]) => `${k}×${n}`).join(', ') || 'no battery records';
  const detail = staticRec ? ` static: loop_times=${staticRec.loop_times}, design=${staticRec.designed_capacity}, life=${staticRec.battery_life}` : '';
  return { cycles: null, note: `no cycle count (${kinds}${detail})`, batteries };
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
// Time in the air from the aircraft's own flight-time counter. On aircraft that hot-swap batteries
// (Matrice 30, 300, 350) the counter keeps running from the previous flight instead of starting at 0,
// and it wraps round after 6553.5 s - so add up its steps rather than taking its largest value.
function airSeconds(frames) {
  let sum = 0, prev = null;
  for (const f of frames) {
    const t = f.osd?.flyTime; if (!Number.isFinite(t)) continue;
    if (prev != null) { let d = t - prev; if (d < -6000) d += 6553.6; if (d > 0 && d < 5) sum += d; }
    prev = t;
  }
  return sum;
}
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
    airMin: (() => { const s = airSeconds(frames); return s ? round(s / 60, 1) : maxFly ? round(maxFly / 60, 1) : e.durationMin; })(),
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

module.exports = { badFigures, fetchKeys, fetchKeysDirect, processFile, isDone, needsCycles, kml, csv };
