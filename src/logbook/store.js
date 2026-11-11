// Flight logbook storage. Every logbook belongs to one account (uid): you, or a network pilot.
// Everything goes through the app's database layer (src/db.js), so on GoDaddy it lives in MySQL.
//   lbUsers    logbook accounts (email, password hash, DJI key, upload key) - see accounts.js
//   lbFlights  one record per DJI flight record file per account
//   lbKeys     DJI decryption keys per file (shared: a file's keys are the same whoever sends it)
//   lbOps      clients, sites and jobs (one record each, per account)
//   lbState    per-account single records: 'inventory:<uid>', 'uploads:<uid>'
// GPS tracks are stored as files (db.saveFile), referenced by flight.trackFile.
const crypto = require('crypto');
const db = require('../db');

const h40 = (s) => crypto.createHash('sha1').update(s).digest('hex');      // 40 hex characters
const clean = (v, n = 200) => String(v ?? '').slice(0, n);

// ---------- per-account single records ----------
const stateId = (name, uid) => h40(name + ':' + uid);
function state(name, uid, defaults = {}) {
  const r = db.get('lbState', stateId(name, uid));
  return r ? r.value : JSON.parse(JSON.stringify(defaults));
}
function setState(name, uid, value) {
  const id = stateId(name, uid);
  if (db.get('lbState', id)) db.update('lbState', id, { value });
  else db.insert('lbState', { id, name, uid, value });
  return value;
}

// ---------- flights ----------
const flightId = (uid, sha) => h40(uid + ':' + sha);
const flights = (uid) => db.all('lbFlights').filter(f => f.uid === uid);
const flightBySha = (uid, sha) => db.get('lbFlights', flightId(uid, sha));
const flightByFile = (uid, file) => flights(uid).find(f => f.file === file);
function putFlight(uid, entry) {
  const id = flightId(uid, entry.sha256);
  const cur = db.get('lbFlights', id);
  if (cur) {
    // keep what's been filled in by hand when a file is processed again
    const keep = { pilot: cur.pilot || '', notes: cur.notes || '', jobId: cur.jobId || '' };
    for (const k of Object.keys(cur)) if (!['id', 'uid', 'createdAt', 'updatedAt'].includes(k) && !(k in entry)) entry[k] = undefined;
    return db.update('lbFlights', id, { ...entry, ...keep, uid });
  }
  return db.insert('lbFlights', { id, ...entry, uid });
}
// Flight numbers YYMMDD-n, counting real flights within each local day.
function renumber(uid) {
  const list = flights(uid).sort((a, b) => (a.startUtc || '').localeCompare(b.startUtc || ''));
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
const publicFlight = (f) => {
  const { id, uid, createdAt, updatedAt, trackFile, ...rest } = f;
  return rest;
};

// ---------- decryption keys (per file) ----------
const keyId = (sha) => String(sha).slice(0, 40);
const getKeys = (sha) => db.get('lbKeys', keyId(sha))?.keychains || null;
function putKeys(sha, keychains) {
  const id = keyId(sha);
  if (db.get('lbKeys', id)) db.update('lbKeys', id, { keychains });
  else db.insert('lbKeys', { id, keychains });
}

// ---------- inventory ----------
function inventory(uid) {
  const inv = state('inventory', uid, {});
  inv.aircraft ||= {}; inv.batteries ||= {}; inv.payloads ||= {};
  for (const f of flights(uid)) {
    if (!f.isFlight) continue;
    if (f.aircraftSn && !inv.aircraft[f.aircraftSn])
      inv.aircraft[f.aircraftSn] = { code: '', registration: '', status: 'In service', notes: '', model: f.aircraftModel || '', appName: f.aircraftName || '' };
    if (f.batterySn && !inv.batteries[f.batterySn]) inv.batteries[f.batterySn] = { code: '', status: 'In service', notes: '' };
    if (f.cameraSn && !inv.payloads[f.cameraSn]) inv.payloads[f.cameraSn] = { code: '', type: 'Integrated camera', status: 'In service', notes: '' };
  }
  return inv;
}
const INV_FIELDS = [['aircraft', ['code', 'registration', 'status', 'notes', 'inspectEveryH']], ['batteries', ['code', 'source', 'status', 'notes']], ['payloads', ['code', 'type', 'status', 'notes']]];
function saveInventory(uid, b) {
  const cur = inventory(uid);
  for (const [kind, fields] of INV_FIELDS) {
    for (const [sn, item] of Object.entries(b[kind] || {})) {
      if (!/^[A-Z0-9]{6,30}$/i.test(sn) || !item || typeof item !== 'object') continue;
      cur[kind][sn] ||= {};
      for (const k of fields) if (k in item) cur[kind][sn][k] = clean(item[k], k === 'notes' ? 1000 : 60);
    }
  }
  setState('inventory', uid, cur);
  return cur;
}

// ---------- clients / sites / jobs ----------
const OPS_FIELDS = {
  clients: { name: 120, contact: 200, notes: 2000 },
  sites: { name: 120, owner: 120, om: 120, marginM: 10, notes: 2000 },
  jobs: { name: 160, clientId: 48, siteId: 48, status: 30, ref: 80, purpose: 200, operator: 160, opType: 10,
    dropboxUrl: 600, sitemarkUrl: 600, start: 10, end: 10, notes: 4000,
    networkJobId: 40, swmsUrl: 600, capture: 3000 },   // shared with network pilots (network.js)
  // drone maintenance log: inspections (with ticked checklist), parts replaced, firmware updates, repairs
  maint: { sn: 30, date: 10, type: 40, checks: 3000, parts: 1000, firmware: 300, by: 120, notes: 4000, hoursAt: 12 },
};
const safeKey = (k) => /^[a-z0-9-]{1,48}$/.test(k) ? k : null;
const opsId = (uid, kind, key) => h40(uid + ':' + kind + ':' + key);
const opsDoc = (uid, kind, key) => db.get('lbOps', opsId(uid, kind, key));

function ops(uid) {
  const o = { clients: {}, sites: {}, jobs: {}, maint: {}, flightJob: {} };
  for (const r of db.all('lbOps')) if (r.uid === uid && o[r.kind]) o[r.kind][r.key] = r.item;
  for (const f of flights(uid)) if (f.jobId && o.jobs[f.jobId]) o.flightJob[f.sha256] = f.jobId;
  return o;
}
function putOps(uid, kind, key, item) {
  const d = opsDoc(uid, kind, key);
  if (d) db.update('lbOps', d.id, { item });
  else db.insert('lbOps', { id: opsId(uid, kind, key), uid, kind, key, item });
}
function saveOps(uid, b) {
  for (const [kind, fields] of Object.entries(OPS_FIELDS)) {
    for (const [key, item] of Object.entries(b[kind] || {})) {
      if (!safeKey(key)) continue;
      if (item === null) {
        const d = opsDoc(uid, kind, key);
        if (d) db.remove('lbOps', d.id);
        if (kind === 'jobs') for (const f of flights(uid)) if (f.jobId === key) db.update('lbFlights', f.id, { jobId: '' });
        continue;
      }
      if (typeof item !== 'object') continue;
      const cur = opsDoc(uid, kind, key)?.item || { created: new Date().toISOString() };
      for (const [k, n] of Object.entries(fields)) if (k in item) cur[k] = clean(item[k], n);
      putOps(uid, kind, key, cur);
    }
  }
  for (const [sha, jobId] of Object.entries(b.flightJob || {})) {
    if (!/^[a-f0-9]{64}$/.test(sha)) continue;
    const f = flightBySha(uid, sha);
    if (!f) continue;
    if (!jobId) db.update('lbFlights', f.id, { jobId: '' });
    else if (opsDoc(uid, 'jobs', jobId)) db.update('lbFlights', f.id, { jobId });
  }
  return ops(uid);
}
function updateSite(uid, key, fn) {
  const d = opsDoc(uid, 'sites', key);
  if (!d) throw new Error('no such site');
  const item = d.item; fn(item); putOps(uid, 'sites', key, item);
  return ops(uid);
}

// ---------- upload history (shown in the Import window) ----------
function noteUpload(uid, line) {
  const u = state('uploads', uid, { list: [] });
  u.list.unshift({ at: new Date().toISOString(), ...line });
  u.list = u.list.slice(0, 200);
  setState('uploads', uid, u);
}
const uploads = (uid) => state('uploads', uid, { list: [] }).list;

// ---------- the first owner account takes over logbook data saved before accounts existed ----------
async function claimUnowned(uid) {
  let n = 0;
  for (const f of db.all('lbFlights').filter(f => !f.uid)) {
    const { id, createdAt, updatedAt, ...rest } = f;
    db.remove('lbFlights', id);
    db.insert('lbFlights', { ...rest, id: flightId(uid, f.sha256), uid });
    n++;
  }
  for (const r of db.all('lbOps').filter(r => !r.uid)) { db.remove('lbOps', r.id); putOps(uid, r.kind, r.key, r.item); }
  for (const name of ['inventory', 'uploads']) {
    const old = db.get('lbState', name);
    if (old) { setState(name, uid, old.value); db.remove('lbState', name); }
  }
  const s = db.get('lbState', 'settings');
  if (s) db.remove('lbState', 'settings');
  await db.flush();
  return { flights: n, djiApiKey: s?.value?.djiApiKey || '' };
}

module.exports = {
  clean, flights, flightBySha, flightByFile, putFlight, renumber, publicFlight,
  getKeys, putKeys, inventory, saveInventory, ops, saveOps, putOps, updateSite, safeKey,
  noteUpload, uploads, claimUnowned, state, setState,
};
