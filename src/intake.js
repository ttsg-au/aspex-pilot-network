// Turns a website registration (from the form webhook, or pasted from the
// "Expression of Interest – Pilot Network" notification email) into a pilot record.
const db = require('./db');
const { guessState, DRONE_OPTIONS } = require('./model');

// Map whatever field names/labels arrive onto our fields.
const KEY_MAP = [
  ['fullName', ['pilot', 'full name', 'fullname', 'name', 'your name']],
  ['business', ['business', 'business name and abn', 'business name', 'business abn']],
  ['email', ['email', 'email address', 'e mail']],
  ['mobile', ['mobile', 'phone', 'mobile number', 'phone number']],
  ['homeBase', ['base', 'home base', 'home base town state', 'location']],
  ['travel', ['travel', 'how far will you travel', 'travel distance']],
  ['interest', ['interest', 'which part are you interested in', 'part']],
  ['credentials', ['credentials', 'casa credentials held', 'casa credentials']],
  ['arn', ['arn']],
  ['drones', ['drones', 'drones you own or can access']],
  ['dronesOther', ['other', 'other please specify', 'drones other', 'other drones']],
  ['insurance', ['insurance', 'public liability insurance']],
  ['coverAmount', ['cover amount', 'cover']],
  ['whiteCard', ['white card', 'do you hold a white card']],
  ['experience', ['experience', 'thermography or mapping experience']],
  ['goals', ['goals', 'what do you want to get out of this']],
  ['portfolio', ['portfolio', 'website or portfolio link', 'website']],
];
const norm = (k) => String(k).toLowerCase().replace(/form_fields|\[|\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function fieldFor(key) {
  const k = norm(key);
  for (const [field, names] of KEY_MAP) if (names.includes(k) || k === norm(field)) return field;
  return null;
}

// Accepts a flat object of key → value (strings or arrays).
function normalise(input) {
  const out = {};
  const put = (key, value) => {
    const f = fieldFor(key);
    if (!f) return;
    const v = Array.isArray(value) ? value.join(', ') : String(value ?? '').trim();
    if (v && !out[f]) out[f] = v;
  };
  // Elementor's webhook sends fields[...] entries with id/title/value; handle both shapes.
  if (input.fields && typeof input.fields === 'object') {
    for (const [id, f] of Object.entries(input.fields)) {
      if (f && typeof f === 'object') { put(f.title || f.id || id, f.value); put(f.id || id, f.value); }
      else put(id, f);
    }
  }
  for (const [k, v] of Object.entries(input)) if (k !== 'fields') put(k, v);
  return out;
}

// Parses the text of a notification email ("Pilot: ...", "Email: ...", one per line;
// Experience/Goals can run over several lines).
function parseNotificationEmail(text) {
  const out = {};
  let current = null;
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const m = line.match(/^([A-Za-z][A-Za-z \-–]{1,40}):\s?(.*)$/);
    if (m && fieldFor(m[1])) {
      current = m[1];
      out[current] = m[2].trim();
    } else if (current && line.trim()) {
      out[current] += '\n' + line.trim();
    }
  }
  return normalise(out);
}

const yes = (v) => /^\s*(yes|y|true|1)\b/i.test(v || '');
const splitList = (v) => String(v || '').split(/\s*,\s*(?=[A-Z])/).map(s => s.trim()).filter(Boolean);

function extractAbn(text = '') {
  const m = text.match(/(\d[\d ]{9,14}\d)/g) || [];
  const abn = m.map(s => s.replace(/\s/g, '')).find(s => s.length === 11);
  return abn ? abn.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4') : '';
}

// Create a new pilot, or update the existing one with the same email.
function upsertFromRegistration(reg, source = 'website form') {
  db.insert('registrations', { source, data: reg });
  const email = (reg.email || '').toLowerCase();
  if (!email) throw new Error('Registration has no email address');

  const interest = reg.interest || '';
  const drones = splitList(reg.drones).filter(d => DRONE_OPTIONS.includes(d) || d);
  // "Mr TREVOR JENNINGS" → "Trevor Jennings" (so emails say "Hi Trevor")
  const tidyName = (n) => String(n || '').trim().replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '')
    .split(/\s+/).map(w => w.length > 1 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w).join(' ');
  const fields = {
    fullName: tidyName(reg.fullName),
    email,
    mobile: (reg.mobile || '').replace(/[^\d+ ]/g, '').trim(),
    business: reg.business || '',
    abn: extractAbn(reg.business),
    homeBase: reg.homeBase || '',
    state: guessState(reg.homeBase),
    travel: reg.travel || '',
    partA: /part a|solar|sub.?2/i.test(interest),
    partB: /part b|certified|reoc/i.test(interest),
    credentialsClaimed: splitList(reg.credentials),
    drones,
    dronesOther: reg.dronesOther || '',
    insuranceStatus: reg.insurance || '',
    coverAmount: reg.coverAmount || '',
    whiteCard: reg.whiteCard || '',
    experience: reg.experience || '',
    goals: reg.goals || '',
    portfolio: reg.portfolio || '',
  };

  let pilot = db.all('pilots').find(p => (p.email || '').toLowerCase() === email);
  const isNew = !pilot;
  if (pilot) {
    // Keep anything you've edited by hand (state, stage, notes); refresh the form answers.
    const keep = { state: pilot.state || fields.state };
    pilot = db.update('pilots', pilot.id, { ...fields, ...keep });
    db.insert('records', { pilotId: pilot.id, type: 'note', date: db.today(),
      text: `Registration form submitted again (${source}); form answers updated.` });
  } else {
    pilot = db.insert('pilots', { ...fields, stage: 'registered', region: '', notes: '', registeredAt: db.now(), source });
  }

  // Turn what they told us into (unverified) credential records you can then check.
  const existing = db.where('qualifications', q => q.pilotId === pilot.id).map(q => q.type);
  const addQual = (type, extra = {}) => {
    if (existing.includes(type)) return;
    db.insert('qualifications', { pilotId: pilot.id, type, number: '', detail: '', issuedOn: '', expiresOn: '',
      verified: false, file: null, note: 'From registration form', ...extra });
    existing.push(type);
  };
  if (reg.arn) addQual('arn', { number: reg.arn.replace(/\s/g, '') });
  const creds = fields.credentialsClaimed.join(' ').toLowerCase();
  if (creds.includes('accreditation')) addQual('accreditation');
  if (/\brepl\b/.test(creds)) addQual('repl');
  if (/\breoc\b/.test(creds)) addQual('reoc');
  if (yes(reg.insurance)) addQual('insurance', { detail: reg.coverAmount ? `Cover: ${reg.coverAmount}` : '' });
  if (yes(reg.whiteCard)) addQual('white_card');

  return { pilot, isNew };
}

module.exports = { normalise, parseNotificationEmail, upsertFromRegistration, extractAbn };
