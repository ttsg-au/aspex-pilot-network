// Data store.
//
// On GoDaddy, the app's own disk is wiped when the app is restarted or redeployed,
// so records MUST live in the managed MySQL database. When MySQL settings are present
// (see config.js), every record and every certificate file is kept there.
// Without MySQL settings (e.g. testing on a laptop) it falls back to data/db.json.
//
// Records are held in memory for speed and written through to MySQL on every change,
// in order. The app waits for the database to load before it starts taking requests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const COLLECTIONS = [
  'pilots', 'qualifications', 'records', 'flightLogs',
  'messages', 'jobs', 'jobResponses', 'registrations',
];

const data = {};
for (const c of COLLECTIONS) data[c] = [];

let pool = null;            // mysql2 pool when using MySQL
let writeChain = Promise.resolve();
let lastWriteError = null;  // shown on the dashboard if saving ever fails
const mode = () => (pool ? 'mysql' : 'file');

// ---------- File mode (local testing only) ----------
const DB_FILE = path.join(config.dataDir, 'db.json');
function fileLoad() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return;
  const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  for (const c of COLLECTIONS) if (Array.isArray(saved[c])) data[c] = saved[c];
}
function fileSave() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- MySQL mode ----------
async function mysqlInit() {
  const mysql = require('mysql2/promise');
  const m = config.mysql;
  pool = m.url
    ? mysql.createPool({ uri: m.url, connectionLimit: 4, ...(m.ssl ? { ssl: { rejectUnauthorized: false } } : {}) })
    : mysql.createPool({
      host: m.host, port: m.port, user: m.user, password: m.password, database: m.database,
      connectionLimit: 4, ...(m.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  await pool.query(`CREATE TABLE IF NOT EXISTS app_records (
    collection VARCHAR(40) NOT NULL,
    id VARCHAR(40) NOT NULL,
    doc LONGTEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (collection, id)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_files (
    id VARCHAR(40) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    mime VARCHAR(100) NOT NULL,
    content LONGBLOB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  const [rows] = await pool.query('SELECT collection, doc FROM app_records');
  for (const r of rows) if (data[r.collection]) data[r.collection].push(JSON.parse(r.doc));
  for (const c of COLLECTIONS) data[c].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

// Queue a database write; writes run one at a time, in the order they were made.
function queue(fn) {
  writeChain = writeChain.then(async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await fn(); lastWriteError = null; return; }
      catch (e) {
        lastWriteError = { at: new Date().toISOString(), message: e.message };
        console.error(`Database write failed (attempt ${attempt}):`, e.message);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  });
  return writeChain;
}
const putDoc = (c, rec) => queue(() => pool.query(
  'INSERT INTO app_records (collection, id, doc) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE doc = VALUES(doc)',
  [c, rec.id, JSON.stringify(rec)]));
const delDoc = (c, id) => queue(() => pool.query('DELETE FROM app_records WHERE collection = ? AND id = ?', [c, id]));

function persist(c, rec, deleted = false) {
  if (pool) return deleted ? delDoc(c, rec.id) : putDoc(c, rec);
  fileSave();
  return Promise.resolve();
}

// ---------- Startup ----------
async function init() {
  if (config.mysql.configured) {
    await mysqlInit();
    console.log(`Database: MySQL (${config.mysql.url ? 'URL' : config.mysql.host + '/' + config.mysql.database}), ${data.pilots.length} pilots loaded`);
  } else {
    fileLoad();
    console.warn('Database: LOCAL FILE (data/db.json). Fine for testing, but on GoDaddy this is wiped on restart. Set the MySQL settings.');
  }
}

const newId = () => crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();
// Today's date in Australia/Sydney as YYYY-MM-DD (UTC would be a day behind each morning).
const today = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400e3).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

// ---------- Certificate files ----------
const FILE_DIR = path.join(config.dataDir, 'uploads');
async function saveFile(buffer, name, mime) {
  const id = crypto.randomBytes(10).toString('hex');
  if (pool) await queue(() => pool.query('INSERT INTO app_files (id, name, mime, content) VALUES (?, ?, ?, ?)', [id, name, mime, buffer]));
  else { fs.mkdirSync(FILE_DIR, { recursive: true }); fs.writeFileSync(path.join(FILE_DIR, id), buffer); }
  return id;
}
async function readFile(id) {
  if (pool) {
    const [rows] = await pool.query('SELECT name, mime, content FROM app_files WHERE id = ?', [id]);
    return rows[0] || null;
  }
  const f = path.join(FILE_DIR, path.basename(id));
  return fs.existsSync(f) ? { content: fs.readFileSync(f) } : null;
}
function deleteFile(id) {
  if (!id) return;
  if (pool) queue(() => pool.query('DELETE FROM app_files WHERE id = ?', [id]));
  else fs.rmSync(path.join(FILE_DIR, path.basename(id)), { force: true });
}

module.exports = {
  init,
  mode,
  status: () => ({ mode: mode(), lastWriteError }),
  flush: () => writeChain,
  all: (c) => data[c],
  get: (c, id) => data[c].find(r => r.id === id),
  where: (c, fn) => data[c].filter(fn),
  insert(c, row) {
    const rec = { id: newId(), createdAt: now(), ...row };
    data[c].push(rec);
    persist(c, rec);
    return rec;
  },
  update(c, id, changes) {
    const rec = data[c].find(r => r.id === id);
    if (!rec) return null;
    Object.assign(rec, changes, { updatedAt: now() });
    persist(c, rec);
    return rec;
  },
  remove(c, id) {
    const i = data[c].findIndex(r => r.id === id);
    if (i >= 0) { const [rec] = data[c].splice(i, 1); persist(c, rec, true); }
  },
  removeWhere(c, fn) {
    const gone = data[c].filter(fn);
    if (!gone.length) return;
    data[c] = data[c].filter(r => !fn(r));
    for (const rec of gone) persist(c, rec, true);
  },
  // Full backup (everything except certificate files) and restore.
  exportAll: () => JSON.parse(JSON.stringify(data)),
  async importAll(saved) {
    for (const c of COLLECTIONS) {
      if (!Array.isArray(saved[c])) continue;
      for (const rec of saved[c]) {
        if (!rec || !rec.id) continue;
        const i = data[c].findIndex(r => r.id === rec.id);
        if (i >= 0) data[c][i] = rec; else data[c].push(rec);
        persist(c, rec);
      }
    }
    await writeChain;
  },
  saveFile, readFile, deleteFile,
  newId, now, today,
};
