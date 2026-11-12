// Automatic screening of new registrations by location.
// Kimberly ticks the regions she's recruiting in (Settings → Target regions). A new registration
// from outside those regions is marked "Not proceeding" and, if they gave a state, sent a polite email.
// Queensland and WA are split into regions by latitude/longitude, using the home base looked up on the map.
const db = require('./db');
const geo = require('./geo');
const { guessState } = require('./model');

const REGIONS = [
  { id: 'nqld', label: 'North Queensland', hint: 'North of Mackay – Townsville, Cairns, Mt Isa, Whitsundays' },
  { id: 'cqld', label: 'Central Queensland', hint: 'Mackay down to just north of Bundaberg – Rockhampton, Gladstone, Emerald, Longreach' },
  { id: 'swqld', label: 'South West Queensland', hint: 'South of that and west of Toowoomba – Dalby, Roma, Charleville, St George, Goondiwindi' },
  { id: 'seqld', label: 'South East Queensland', hint: 'Brisbane, Gold Coast, Sunshine Coast, Toowoomba, Bundaberg, Wide Bay' },
  { id: 'nwa', label: 'Northern Western Australia', hint: 'North of about Carnarvon – Pilbara, Kimberley, Gascoyne' },
  { id: 'swa', label: 'Southern Western Australia', hint: 'Perth, Geraldton and everything south' },
  { id: 'SA', label: 'South Australia' },
  { id: 'TAS', label: 'Tasmania' },
  { id: 'NSW', label: 'New South Wales' },
  { id: 'ACT', label: 'Australian Capital Territory' },
  { id: 'VIC', label: 'Victoria' },
  { id: 'NT', label: 'Northern Territory' },
  { id: 'nz', label: 'New Zealand' },
];
const regionLabel = (id) => (REGIONS.find(r => r.id === id) || { label: id }).label;

// The dividing lines (latitude is negative in the southern hemisphere).
function qldRegion(lat, lng) {
  if (lat > -21.0) return 'nqld';        // Mackay (-21.14) is Central
  if (lat >= -24.7) return 'cqld';       // Bundaberg (-24.87) is South East
  return lng < 151.5 ? 'swqld' : 'seqld'; // Toowoomba (151.95) is South East
}
const waRegion = (lat) => (lat > -26.0 ? 'nwa' : 'swa'); // Carnarvon (-24.9) is North, Geraldton (-28.8) South

const DEFAULTS = {
  key: 'screening',
  enabled: true,
  regions: ['nqld', 'cqld', 'swqld', 'nwa', 'swa', 'SA', 'TAS'],
  subject: 'Aspex Pilot Network – your registration',
  body: `Hi {first_name},

Thank you for registering your interest in the Aspex Pilot Network.

The network is currently focused on specific projects, which need pilots with particular skills in particular locations. Unfortunately your location isn't one we're recruiting in at the moment, so we won't be taking your registration further for now.

We've kept your details on file. If our needs change or we open up your area, we'll be in touch.

Thanks again for your interest, and all the best with your flying.

Kind regards,
Kimberly Olsen
Aspex Drone Services`,
};

function getSettings() {
  const s = db.where('settings', r => r.key === 'screening')[0];
  return { ...DEFAULTS, ...(s || {}) };
}
function saveSettings(changes) {
  const s = db.where('settings', r => r.key === 'screening')[0];
  if (s) db.update('settings', s.id, changes);
  else db.insert('settings', { ...DEFAULTS, ...changes });
}

// Work out which region a pilot is in: { region } or { noState: true } or { unknown: true }.
async function regionOf(p) {
  const text = String(p.homeBase || '');
  if (/new zealand|\bn\.?z\b/i.test(text)) return { region: 'nz' };
  const state = guessState(text) || '';
  if (!state) return { noState: true };
  if (state !== 'QLD' && state !== 'WA') return { region: state };
  // Queensland and WA: find the town on the map to see which part of the state it's in.
  const q = geo.queryFor({ homeBase: text, state });
  let hit = null;
  try { hit = await geo.lookup(q); } catch (e) { console.warn('Screening lookup failed:', e.message); }
  if (!hit) return { unknown: true, state };
  db.update('pilots', p.id, { geo: { q, lat: hit.lat, lng: hit.lng, label: hit.label } });
  return { region: state === 'QLD' ? qldRegion(hit.lat, hit.lng) : waRegion(hit.lat) };
}

const note = (pilotId, text) => db.insert('records', { pilotId, type: 'note', date: db.today(), text });

// Screen one newly registered pilot. sendEmail({ subject, body, pilots }) sends and logs the email.
async function screen(pilotId, sendEmail) {
  const s = getSettings();
  const p = db.get('pilots', pilotId);
  if (!s.enabled || !p) return { outcome: 'off' };
  const r = await regionOf(p);
  if (r.region) db.update('pilots', p.id, { region: regionLabel(r.region) });
  if (r.region && s.regions.includes(r.region)) return { outcome: 'accepted', region: r.region };
  if (r.unknown) { // in QLD or WA but the town couldn't be found: leave it for Kimberly to check
    note(p.id, `Automatic check: couldn't place "${p.homeBase}" on the map, so couldn't tell which part of ${r.state} it's in. Please check by hand.`);
    return { outcome: 'review' };
  }
  const why = r.noState ? 'no state given in home base' : `outside target regions (${regionLabel(r.region)})`;
  db.update('pilots', p.id, { stage: 'not_proceeding' });
  if (r.noState) { // Kimberly's rule: no state given → declined without an email
    note(p.id, `Auto-declined: ${why}. No email sent.`);
    return { outcome: 'declined', emailed: false };
  }
  note(p.id, `Auto-declined: ${why}. Polite "not recruiting in your area" email sent.`);
  sendEmail({ subject: s.subject, body: s.body, pilots: [db.get('pilots', p.id)] });
  return { outcome: 'declined', emailed: true };
}

module.exports = { REGIONS, regionLabel, getSettings, saveSettings, screen, qldRegion, waRegion };
