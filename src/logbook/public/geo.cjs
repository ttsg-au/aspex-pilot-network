// Geometry helpers shared by the logbook page and the server.
// Coordinates are [lon, lat] like GeoJSON. Accurate to well under 1% at farm scale.
const Geo = (() => {
  const R_LAT = 110574, R_LON = 111320;   // metres per degree
  const proj = (lat0, lon0) => ([lon, lat]) => [(lon - lon0) * Math.cos(lat0 * Math.PI / 180) * R_LON, (lat - lat0) * R_LAT];

  function ringArea(ring, P) {                      // m², shoelace in local metres
    let a = 0; const pts = ring.map(P);
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(a / 2);
  }
  function bbox(polys) {
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const p of polys) for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  }
  // polys: array of polygons, each [outerRing, ...holes]
  function areaHa(polys) {
    if (!polys?.length) return 0;
    const [x0, y0, x1, y1] = bbox(polys), P = proj((y0 + y1) / 2, (x0 + x1) / 2);
    let m2 = 0;
    for (const poly of polys) { m2 += ringArea(poly[0], P); for (const h of poly.slice(1)) m2 -= ringArea(h, P); }
    return m2 / 10000;
  }
  function centroid(polys) {                        // area-weighted centre of the outer rings
    const [x0, y0, x1, y1] = bbox(polys);
    let sx = 0, sy = 0, sa = 0;
    for (const poly of polys) {
      const r = poly[0];
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
        sx += (r[j][0] + r[i][0]) * f; sy += (r[j][1] + r[i][1]) * f; sa += f;
      }
    }
    return sa ? [sy / (3 * sa), sx / (3 * sa)] : [(y0 + y1) / 2, (x0 + x1) / 2];   // [lat, lon]
  }
  function inRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const inPolys = (pt, polys) => polys.some(p => inRing(pt, p[0]) && !p.slice(1).some(h => inRing(pt, h)));
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  // metres from a point [lon,lat] to the polygons (0 if inside)
  function distToPolys(pt, polys) {
    if (!polys?.length) return Infinity;
    if (inPolys(pt, polys)) return 0;
    const P = proj(pt[1], pt[0]), q = P(pt); let d = Infinity;
    for (const poly of polys) for (const ring of poly) {
      const r = ring.map(P);
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) d = Math.min(d, segDist(q, r[j], r[i]));
    }
    return d;
  }
  const metres = (a, b) => { const P = proj(a[1], a[0]); const q = P(b); return Math.hypot(q[0], q[1]); };   // [lon,lat] pairs
  // do two polygon sets overlap? (any vertex inside the other, or any edges cross)
  function overlaps(A, B) {
    for (const p of A) for (const v of p[0]) if (inPolys(v, B)) return true;
    for (const p of B) for (const v of p[0]) if (inPolys(v, A)) return true;
    const cross = (a, b, c, d) => {
      const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
      return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
    };
    for (const p of A) { const r = p[0]; for (let i = 0, j = r.length - 1; i < r.length; j = i++)
      for (const q of B) { const s = q[0]; for (let k = 0, l = s.length - 1; k < s.length; l = k++) if (cross(r[j], r[i], s[l], s[k])) return true; } }
    return false;
  }
  // GeoJSON geometry -> polys
  function fromGeoJSON(g) {
    if (!g) return [];
    if (g.type === 'Polygon') return [g.coordinates];
    if (g.type === 'MultiPolygon') return g.coordinates;
    return [];
  }
  return { areaHa, centroid, inPolys, distToPolys, metres, overlaps, bbox, fromGeoJSON };
})();
if (typeof module !== 'undefined') module.exports = Geo;
