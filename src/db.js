// Simple file-based database. Everything lives in data/db.json, written safely
// (temp file + rename) so a crash mid-save can't corrupt it. A dated backup copy
// is kept for each day the data changes (last 30 days).
// No native modules, so it runs on GoDaddy's cPanel Node.js without compiling anything.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./config');

const COLLECTIONS = [
  'pilots',          // one per pilot
  'qualifications',  // credentials: ARN, accreditation, RePL, insurance, White Card...
  'records',         // pathway/ReOC records: inductions, competency checks, supervised jobs, notes
  'flightLogs',      // flight hours entries
  'messages',        // every email sent (one row per send, with recipients)
  'jobs',            // job call-outs
  'jobResponses',    // pilot replies to a job (interested / not available) and assignments
  'registrations',   // raw copies of every incoming form submission
];

const DB_FILE = path.join(dataDir, 'db.json');
const BACKUP_DIR = path.join(dataDir, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

let data = {};
if (fs.existsSync(DB_FILE)) data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
for (const c of COLLECTIONS) if (!Array.isArray(data[c])) data[c] = [];

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, DB_FILE);
  const today = new Date().toISOString().slice(0, 10);
  const backup = path.join(BACKUP_DIR, `db-${today}.json`);
  fs.copyFileSync(DB_FILE, backup);
  const old = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('db-')).sort();
  while (old.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, old.shift()));
}

const newId = () => crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();
// Today's date in Australia/Sydney as YYYY-MM-DD (UTC would be a day behind each morning).
const today = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400e3).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

module.exports = {
  all: (c) => data[c],
  get: (c, id) => data[c].find(r => r.id === id),
  where: (c, fn) => data[c].filter(fn),
  insert(c, row) {
    const rec = { id: newId(), createdAt: now(), ...row };
    data[c].push(rec);
    save();
    return rec;
  },
  update(c, id, changes) {
    const rec = data[c].find(r => r.id === id);
    if (!rec) return null;
    Object.assign(rec, changes, { updatedAt: now() });
    save();
    return rec;
  },
  remove(c, id) {
    const i = data[c].findIndex(r => r.id === id);
    if (i >= 0) { data[c].splice(i, 1); save(); }
  },
  removeWhere(c, fn) {
    const before = data[c].length;
    data[c] = data[c].filter(r => !fn(r));
    if (data[c].length !== before) save();
  },
  save,
  newId,
  now,
  today,
};
