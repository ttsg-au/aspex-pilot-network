// The things the system knows about: pathway stages, credential types, record types,
// and helpers for expiry status and filtering.
const db = require('./db');
const config = require('./config');

const STATES = ['QLD', 'NSW', 'ACT', 'VIC', 'TAS', 'SA', 'WA', 'NT'];

// The pathway every pilot moves through. Works for sub-2 kg (excluded category) work now,
// and for flying under the Aspex ReOC later.
const STAGES = [
  { id: 'registered', label: 'Registered', hint: 'Form received, not yet contacted' },
  { id: 'contacted', label: 'Contacted', hint: 'Next steps sent' },
  { id: 'vetted', label: 'Credentials checked', hint: 'ARN, accreditation/RePL, insurance verified' },
  { id: 'inducted', label: 'Inducted', hint: 'Aspex procedures and safety briefing done' },
  { id: 'supervised', label: 'Supervised work', hint: 'Flying alongside or under supervision' },
  { id: 'approved', label: 'Approved for solo work', hint: 'Can be sent on jobs alone' },
  { id: 'on_hold', label: 'On hold', hint: 'Not available or paused' },
  { id: 'not_proceeding', label: 'Not proceeding', hint: 'Not suitable or withdrew' },
];
const stageLabel = (id) => (STAGES.find(s => s.id === id) || { label: id }).label;

const QUAL_TYPES = [
  { id: 'arn', label: 'ARN (Aviation Reference Number)', expires: false },
  { id: 'accreditation', label: 'RPA operator accreditation', expires: true },
  { id: 'repl', label: 'RePL (Remote Pilot Licence)', expires: false, detail: 'Ratings / category (e.g. multirotor up to 7 kg)' },
  { id: 'drone_reg', label: 'Drone registration (CASA)', expires: true, detail: 'Drone model and serial' },
  { id: 'reoc', label: 'ReOC (pilot’s own)', expires: true },
  { id: 'insurance', label: 'Public liability insurance', expires: true, detail: 'Insurer and cover amount' },
  { id: 'white_card', label: 'White Card (construction induction)', expires: false },
  { id: 'aroc', label: 'AROC (radio operator)', expires: false },
  { id: 'first_aid', label: 'First aid', expires: true },
  { id: 'thermography', label: 'Thermography training', expires: false },
  { id: 'other', label: 'Other', expires: true },
];
const qualLabel = (id) => (QUAL_TYPES.find(q => q.id === id) || { label: id }).label;

// Records of what's happened with a pilot — the history a Chief Remote Pilot keeps.
const RECORD_TYPES = [
  { id: 'note', label: 'Note / phone call' },
  { id: 'agreement', label: 'Contractor agreement signed' },
  { id: 'induction_procedures', label: 'Aspex procedures & safety induction' },
  { id: 'induction_opsmanual', label: 'Ops manual induction (ReOC)', reoc: true },
  { id: 'competency_check', label: 'Competency / proficiency check', reoc: true },
  { id: 'supervised_job', label: 'Supervised job completed' },
  { id: 'site_induction', label: 'Client site induction' },
  { id: 'incident', label: 'Incident / occurrence' },
];
const recordLabel = (id) => (RECORD_TYPES.find(r => r.id === id) || { label: id }).label;

const DRONE_OPTIONS = ['Mavic 3T', 'Mavic 3E', 'Matrice 4T', 'Matrice 4E', 'None yet', 'Other'];
const TRAVEL_OPTIONS = ['Up to 100 km', 'Up to 300 km', 'Anywhere in my state', 'Australia-wide'];
const CREDENTIAL_OPTIONS = ['RPA operator accreditation', 'RePL', 'ReOC'];

// ---- Expiry -------------------------------------------------------------
function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.round((Date.parse(dateStr) - Date.parse(db.today())) / 86400e3);
}
function expiryStatus(q) {
  if (!q.expiresOn) return 'none';
  const d = daysUntil(q.expiresOn);
  if (d < 0) return 'expired';
  if (d <= config.expiryWarnDays) return 'soon';
  return 'ok';
}

// ---- Pilot helpers ------------------------------------------------------
const qualsFor = (pilotId) => db.where('qualifications', q => q.pilotId === pilotId);
const recordsFor = (pilotId) => db.where('records', r => r.pilotId === pilotId)
  .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
const flightsFor = (pilotId) => db.where('flightLogs', f => f.pilotId === pilotId)
  .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
const firstName = (p) => (p.fullName || '').replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '').split(/\s+/)[0] || 'there';

function flightHours(pilotId) {
  const mins = flightsFor(pilotId).reduce((s, f) => s + (Number(f.minutes) || 0), 0);
  return Math.round(mins / 6) / 10;
}

// What's still missing before this pilot can work on a client site.
function readiness(p) {
  const quals = qualsFor(p.id);
  const has = (type) => quals.find(q => q.type === type && expiryStatus(q) !== 'expired');
  const verified = (type) => quals.find(q => q.type === type && q.verified && expiryStatus(q) !== 'expired');
  const recs = recordsFor(p.id);
  const did = (type) => recs.find(r => r.type === type);
  const yearAgo = db.today(-365);

  const partA = [
    { label: 'ARN', ok: !!verified('arn'), have: !!has('arn') },
    { label: 'Operator accreditation or RePL', ok: !!(verified('accreditation') || verified('repl')), have: !!(has('accreditation') || has('repl')) },
    { label: 'Public liability insurance', ok: !!verified('insurance'), have: !!has('insurance') },
    { label: 'White Card', ok: !!verified('white_card'), have: !!has('white_card') },
    { label: 'Contractor agreement', ok: !!did('agreement'), have: !!did('agreement') },
    { label: 'Aspex procedures & safety induction', ok: !!did('induction_procedures'), have: !!did('induction_procedures') },
  ];
  const reoc = [
    { label: 'RePL verified', ok: !!verified('repl'), have: !!has('repl') },
    { label: 'Inducted into Aspex ops manual', ok: !!did('induction_opsmanual'), have: !!did('induction_opsmanual') },
    { label: 'Competency check in last 12 months', ok: recs.some(r => r.type === 'competency_check' && (r.date || '') >= yearAgo), have: !!did('competency_check') },
  ];
  return { partA, reoc, partAReady: partA.every(x => x.ok), reocReady: reoc.every(x => x.ok) };
}

// Filters used on the pilot list and when choosing who to message.
function filterPilots(q = {}) {
  let list = db.all('pilots').slice();
  const text = (q.q || '').trim().toLowerCase();
  if (text) list = list.filter(p => [p.fullName, p.email, p.mobile, p.business, p.homeBase, p.region, p.notes]
    .join(' ').toLowerCase().includes(text));
  if (q.state) list = list.filter(p => p.state === q.state);
  if (q.stage) list = list.filter(p => p.stage === q.stage);
  else if (!q.includeInactive) list = list.filter(p => p.stage !== 'not_proceeding');
  if (q.part === 'A') list = list.filter(p => p.partA);
  if (q.part === 'B') list = list.filter(p => p.partB);
  if (q.qual) list = list.filter(p => qualsFor(p.id).some(x => x.type === q.qual && expiryStatus(x) !== 'expired'));
  if (q.drone) list = list.filter(p => (p.drones || []).includes(q.drone) || (q.drone === 'Other' && p.dronesOther));
  if (q.travel) list = list.filter(p => p.travel === q.travel);
  return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// Work out a state from free text like "Sydney, Nsw" or a postcode.
function guessState(text = '') {
  const t = ' ' + text.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ') + ' ';
  const names = { 'NEW SOUTH WALES': 'NSW', 'QUEENSLAND': 'QLD', 'VICTORIA': 'VIC', 'TASMANIA': 'TAS',
    'SOUTH AUSTRALIA': 'SA', 'WESTERN AUSTRALIA': 'WA', 'NORTHERN TERRITORY': 'NT', 'AUSTRALIAN CAPITAL TERRITORY': 'ACT' };
  for (const [n, s] of Object.entries(names)) if (t.includes(' ' + n + ' ')) return s;
  for (const s of STATES) if (t.includes(' ' + s + ' ')) return s;
  const pc = t.match(/\b(\d{4})\b/);
  if (pc) {
    const n = Number(pc[1]);
    if (n >= 2600 && n <= 2618 || n >= 2900 && n <= 2920) return 'ACT';
    if (n >= 1000 && n <= 2999) return 'NSW';
    if (n >= 3000 && n <= 3999) return 'VIC';
    if (n >= 4000 && n <= 4999) return 'QLD';
    if (n >= 5000 && n <= 5999) return 'SA';
    if (n >= 6000 && n <= 6999) return 'WA';
    if (n >= 7000 && n <= 7999) return 'TAS';
    if (n >= 800 && n <= 999) return 'NT';
  }
  return '';
}

module.exports = {
  STATES, STAGES, stageLabel, QUAL_TYPES, qualLabel, RECORD_TYPES, recordLabel,
  DRONE_OPTIONS, TRAVEL_OPTIONS, CREDENTIAL_OPTIONS,
  daysUntil, expiryStatus, qualsFor, recordsFor, flightsFor, flightHours, firstName,
  readiness, filterPilots, guessState,
};
