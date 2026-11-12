// senseFly eBee flight logs (.bb3), shared by the logbook page and the server.
// The eBee splits each flight's log into ~1 MB parts (…_0072_part001.bb3, part002…). Joined in
// order, they contain the GNSS receiver's own data stream. On the eBee X that's Septentrio SBF,
// which is a published format: each block starts "$@", has a CRC, and block 4007 (PVTGeodetic)
// holds time, latitude, longitude, height and velocity. senseFly's own data in between is skipped.
const BB3 = (() => {
  const GPS_EPOCH = Date.UTC(1980, 0, 6), LEAP_S = 18;   // GPS time runs 18 s ahead of UTC (since 2017)

  function crc16(b, start, end) {                      // CRC-16-CCITT, as SBF uses
    let c = 0;
    for (let i = start; i < end; i++) {
      c ^= b[i] << 8;
      for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    }
    return c;
  }

  // "IX-12-61425_0072_part003.bb3" -> { base: "IX-12-61425_0072", serial: "IX-12-61425", flight: 72, part: 3 }
  function nameInfo(name) {
    const m = String(name).match(/^(.*?)_(\d+)_part(\d+)\.bb3$/i);
    if (!m) return null;
    return { base: `${m[1]}_${m[2]}`, serial: m[1], flight: Number(m[2]), part: Number(m[3]) };
  }

  // Position fixes from the joined log: [utcMs, lat, lon, heightM, groundSpeedMs], ~10 per second.
  function fixes(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = [];
    for (let i = 0; i + 8 <= b.length; i++) {
      if (b[i] !== 0x24 || b[i + 1] !== 0x40) continue;           // "$@"
      const crc = dv.getUint16(i + 2, true), id = dv.getUint16(i + 4, true) & 0x1fff, len = dv.getUint16(i + 6, true);
      if (len < 8 || len % 4 || i + len > b.length) continue;
      if (id !== 4007 || len < 56) continue;                      // only position blocks
      if (crc16(b, i + 4, i + len) !== crc) continue;
      const tow = dv.getUint32(i + 8, true), wn = dv.getUint16(i + 12, true), err = b[i + 15];
      const lat = dv.getFloat64(i + 16, true), lon = dv.getFloat64(i + 24, true), h = dv.getFloat64(i + 32, true);
      const vn = dv.getFloat32(i + 44, true), ve = dv.getFloat32(i + 48, true);
      if (err !== 0 || !(Math.abs(lat) <= Math.PI / 2) || !(Math.abs(lon) <= Math.PI) || !Number.isFinite(h)) continue;
      const t = GPS_EPOCH + wn * 604800000 + tow - LEAP_S * 1000;
      out.push([t, lat * 180 / Math.PI, lon * 180 / Math.PI, h, Math.hypot(vn, ve)]);
      i += len - 1;
    }
    return out;
  }

  const metres = (a, b) => {
    const r = Math.PI / 180, x = (b[2] - a[2]) * r * Math.cos((a[1] + b[1]) / 2 * r), y = (b[1] - a[1]) * r;
    return Math.sqrt(x * x + y * y) * 6371000;
  };

  // Keep about one fix per second (enough for the logbook and the map).
  function thin(fx) {
    const out = []; let last = -Infinity;
    for (const f of fx) if (f[0] - last >= 1000) { out.push(f); last = f[0]; }
    if (fx.length && out[out.length - 1] !== fx[fx.length - 1]) out.push(fx[fx.length - 1]);
    return out;
  }

  // Take-off, landing and flight figures from ~1 Hz fixes.
  function summarise(fx) {
    if (fx.length < 10) return { isFlight: false };
    const ground = fx.slice(0, 20).map(f => f[3]).sort((a, b) => a - b)[10] ?? fx[0][3];  // height on the ground before take-off
    const air = (f) => f[3] - ground > 5 || f[4] > 5;
    const a = fx.findIndex(air);
    if (a < 0) return { isFlight: false, startMs: fx[0][0], endMs: fx[fx.length - 1][0] };
    let z = fx.length - 1; while (z > a && !air(fx[z])) z--;
    const flown = fx.slice(a, z + 1);
    let dist = 0, maxH = -Infinity, maxV = 0, maxR = 0;
    for (let i = 0; i < flown.length; i++) {
      const f = flown[i];
      if (i) { const d = metres(flown[i - 1], f); if (d < 500) dist += d; }   // ignore impossible jumps
      maxH = Math.max(maxH, f[3] - ground); maxV = Math.max(maxV, f[4]);
      maxR = Math.max(maxR, metres(fx[a], f));
    }
    return {
      isFlight: true, startMs: fx[a][0], endMs: fx[z][0],
      takeoffLat: fx[a][1], takeoffLon: fx[a][2],
      durationMin: (fx[z][0] - fx[a][0]) / 60000, distanceKm: dist / 1000,
      maxHeightM: maxH, maxHSpeedMs: maxV, maxRangeM: maxR, groundHeight: ground,
    };
  }

  return { nameInfo, fixes, thin, summarise };
})();
if (typeof module !== 'undefined') module.exports = BB3;
