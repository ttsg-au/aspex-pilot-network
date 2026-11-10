// Finds map positions for pilots from their home base (suburb/town + state), using
// OpenStreetMap's free Nominatim service. Results are saved on the pilot as `geo`, so each
// place is only looked up once. Nominatim allows one request per second, so lookups run
// one at a time in the background.
const db = require('./db');

const STATES = { NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', WA: 'Western Australia', SA: 'South Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory' };
const queryFor = (p) => {
  // Spell out state abbreviations wherever they appear ("Secret Harbour, WA" -> "..., Western Australia").
  const full = (t) => String(t || '').replace(/\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/gi, m => STATES[m.toUpperCase()]);
  let base = full(p.homeBase).replace(/\b\d{4}\b/g, '').replace(/\s+/g, ' ').replace(/[ ,]+$/, '').trim();
  if (!base) return '';
  const st = full(p.state);
  if (st && !base.toLowerCase().includes(st.toLowerCase())) base += ', ' + st;
  return base + ', Australia';
};

// A pilot needs a lookup when they have a home base and no saved position for it.
const needsLookup = (p) => {
  const q = queryFor(p);
  if (!q || (p.geo && p.geo.manual)) return false;
  return !p.geo || p.geo.q !== q;
};

async function lookup(q) {
  if (process.env.GEO_STUB) { // for local testing without internet
    const h = [...q].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    return { lat: -25 - (h % 1000) / 100, lng: 120 + (h % 2900) / 100, label: q };
  }
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=au&q=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { 'User-Agent': 'AspexPilotNetwork/1.0 (admin@aspex.com.au)', 'Accept-Language': 'en-AU' } });
  if (!res.ok) throw new Error('lookup failed ' + res.status);
  const [hit] = await res.json();
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name } : null;
}

let running = false;
async function run() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const p = db.all('pilots').find(needsLookup);
      if (!p) break;
      const q = queryFor(p);
      let geo;
      try {
        // If the full text isn't found, try just the town/suburb (first part) in Australia.
        let hit = await lookup(q);
        if (!hit && q.includes(',')) { await new Promise(r => setTimeout(r, 1100)); hit = await lookup(q.split(',')[0] + ', Australia'); }
        geo = hit ? { q, lat: hit.lat, lng: hit.lng, label: hit.label } : { q, notFound: true };
      } catch (e) {
        console.warn('Map lookup failed:', e.message);
        break; // try again next time the Pilots page is opened
      }
      db.update('pilots', p.id, { geo });
      await new Promise(r => setTimeout(r, 1100));
    }
  } finally { running = false; }
}

// Start background lookups (doesn't wait). Returns how many are still to do.
function refresh() {
  const pending = db.all('pilots').filter(needsLookup).length;
  if (pending) run();
  return pending;
}

// "-32.4, 115.75" -> { lat, lng } within Australia's rough bounds, else null.
function parsePos(s) {
  const m = String(s || '').match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return lat < -8 && lat > -45 && lng > 110 && lng < 160 ? { lat, lng } : null;
}

module.exports = { refresh, queryFor, parsePos };
