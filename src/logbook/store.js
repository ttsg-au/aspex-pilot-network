// Flight logbook storage.
// Everything goes through the app's database layer (src/db.js), so on GoDaddy it lives in MySQL.
//   lbFlights  one record per DJI flight record file (id = first 40 characters of the file's SHA-256)
//   lbKeys     DJI decryption keys per file, so a file never needs keys fetched twice
//   lbOps      clients, sites and jobs (one record each)
//   lbState    single records: 'inventory', 'settings', 'uploads'
// GPS tracks are stored as files (db.saveFile), referenced by flight.trackFile.
const crypto = require('crypto');
const db = require('../db');

const shaId = (sha) => String(sha).slice(0, 40);
const clean = (v, n = 200) => String(v ?? '').slice(0, n);

// ---------- single-record state ----------
function state(id, defaults = {}) {
  const r = db.get('lbState', id);
  return r ? r.value : JSON.parse(JSON.stringify(defaults));
}
function setState(id, value) {
  if (db.get('lbState', id)) db.update('lbState', id, { value });
  else db.insert('lbState', { id, value });
  return value;
}

// ---------- settings ----------
function settings() {
  const s = state('settings', {});
  if (!s.uploadKey) { s.uploadKey = crypto.randomBytes(18).toString('base64url'); setState('settings', s); }
  return s;
}
const saveSettings = (changes) => setState('settings', { ...settings(), ...changes });

// ---------- flights ----------
const flights = () => db.all('lbFlights');
const flightBySha = (sha) => db.get('lbFlights', shaId(sha));
const flightByFile = (file) => db.all('lbFlights').find(f => f.file === file);
function putFlight(entry) {
  const id = shaId(entry.sha256);
  const cur = db.get('lbFlights', id);
  if (cur) {
    // keep what you've filled in by hand when a file is processed again
    const keep = { pilot: cur.pilot || '', notes: cur.notes || '', jobId: cur.jobId || '' };
    for (const k of Object.keys(cur)) if (!['id', 'createdAt', 'updatedAt'].includes(k) && !(k in entry)) entry[k] = undefined;
    return db.update('lbFlights', id, { ...entry, ...keep });
  }
  return db.insert('lbFlights', { id, ...entry });
}
// Flight numbers YYMMDD-n, counting real flights within each local day.
function renumber() {
  const list = flights().slice().sort((a, b) => (a.startUtc || '').localeCompare(b.startUtc || ''));
  const perDay = {};
  for (const f of list) {
    let no = '';
    if (f.isFlight && f.startLocal) {
      const day = f.startLocal.slice(2, 10).replace(/-/g, '');
      perDay[day] = (perDay[day] || 0) + 1;
      no = `${day}-${perDay[day]}`;
    }
    if (f.flightNo !== no) db.update('lbFlights', f.id, { flightNo: no });
  }
}
// What the browser gets: no internal fields.
const publicFlight = (f) => {
  const { id, createdAt, updatedAt, trackFile, ...rest } = f;
  return rest;
};

// ---------- decryption keys ----------
const getKeys = (sha) => db.get('lbKeys', shaId(sha))?.keychains || null;
function putKeys(sha, keychains) {
  const id = shaId(sha);
  if (db.get('lbKeys', id)) db.update('lbKeys', id, { keychains });
  else db.insert('lbKeys', { id, keychains });
}

// ---------- inventory ----------
function inventory() {
  const inv = state('inventory', {});
  inv.aircraft ||= {}; inv.batteries ||= {}; inv.payloads ||= {};
  for (const f of flights()) {
    if (!f.isFlight) continue;
    if (f.aircraftSn && !inv.aircraft[f.aircraftSn])
      inv.aircraft[f.aircraftSn] = { code: '', registration: '', status: 'In service', notes: '', model: f.aircraftModel || '', appName: f.aircraftName || '' };
    if (f.batterySn && !inv.batteries[f.batterySn]) inv.batteries[f.batterySn] = { code: '', status: 'In service', notes: '' };
    if (f.cameraSn && !inv.payloads[f.cameraSn]) inv.payloads[f.cameraSn] = { code: '', type: 'Integrated camera', status: 'In service', notes: '' };
  }
  return inv;
}
const INV_FIELDS = [['aircraft', ['code', 'registration', 'status', 'notes']], ['batteries', ['code', 'source', 'status', 'notes']], ['payloads', ['code', 'type', 'status', 'notes']]];
function saveInventory(b) {
  const cur = inventory();
  for (const [kind, fields] of INV_FIELDS) {
    for (const [sn, item] of Object.entries(b[kind] || {})) {
      if (!/^[A-Z0-9]{6,30}$/i.test(sn) || !item || typeof item !== 'object') continue;
      cur[kind][sn] ||= {};
      for (const k of fields) if (k in item) cur[kind][sn][k] = clean(item[k], k === 'notes' ? 1000 : 60);
    }
  }
  setState('inventory', cur);
  return cur;
}

// ---------- clients / sites / jobs ----------
const OPS_FIELDS = {
  clients: { name: 120, contact: 200, notes: 2000 },
  sites: { name: 120, owner: 120, om: 120, marginM: 10, notes: 2000 },
  jobs: { name: 160, clientId: 48, siteId: 48, status: 30, ref: 80, purpose: 200, operator: 160, opType: 10,
    dropboxUrl: 600, sitemarkUrl: 600, start: 10, end: 10, notes: 4000 },
};
const safeKey = (k) => /^[a-z0-9-]{1,48}$/.test(k) ? k : null;
const opsId = (kind, key) => crypto.createHash('sha1').update(kind + ':' + key).digest('hex').slice(0, 24);
const opsDoc = (kind, key) => db.get('lbOps', opsId(kind, key));

function ops() {
  const o = { clients: {}, sites: {}, jobs: {}, flightJob: {} };
  for (const r of db.all('lbOps')) if (o[r.kind]) o[r.kind][r.key] = r.item;
  for (const f of flights()) if (f.jobId && o.jobs[f.jobId]) o.flightJob[f.sha256] = f.jobId;
  return o;
}
function putOps(kind, key, item) {
  const d = opsDoc(kind, key);
  if (d) db.update('lbOps', d.id, { item });
  else db.insert('lbOps', { id: opsId(kind, key), kind, key, item });
}
function saveOps(b) {
  for (const [kind, fields] of Object.entries(OPS_FIELDS)) {
    for (const [key, item] of Object.entries(b[kind] || {})) {
      if (!safeKey(key)) continue;
      if (item === null) {
        const d = opsDoc(kind, key);
        if (d) db.remove('lbOps', d.id);
        if (kind === 'jobs') for (const f of flights()) if (f.jobId === key) db.update('lbFlights', f.id, { jobId: '' });
        continue;
      }
      if (typeof item !== 'object') continue;
      const cur = opsDoc(kind, key)?.item || { created: new Date().toISOString() };
      for (const [k, n] of Object.entries(fields)) if (k in item) cur[k] = clean(item[k], n);
      putOps(kind, key, cur);
    }
  }
  for (const [sha, jobId] of Object.entries(b.flightJob || {})) {
    if (!/^[a-f0-9]{64}$/.test(sha)) continue;
    const f = flightBySha(sha);
    if (!f) continue;
    if (!jobId) db.update('lbFlights', f.id, { jobId: '' });
    else if (opsDoc('jobs', jobId)) db.update('lbFlights', f.id, { jobId });
  }
  return ops();
}
function updateSite(key, fn) {
  const d = opsDoc('sites', key);
  if (!d) throw new Error('no such site');
  const item = d.item; fn(item); putOps('sites', key, item);
  return ops();
}

// ---------- upload history (shown in the Import window) ----------
function noteUpload(line) {
  const u = state('uploads', { list: [] });
  u.list.unshift({ at: new Date().toISOString(), ...line });
  u.list = u.list.slice(0, 200);
  setState('uploads', u);
}
const uploads = () => state('uploads', { list: [] }).list;

module.exports = {
  shaId, clean, settings, saveSettings,
  flights, flightBySha, flightByFile, putFlight, renumber, publicFlight,
  getKeys, putKeys, inventory, saveInventory, ops, saveOps, putOps, updateSite, safeKey,
  noteUpload, uploads, state, setState,
};
