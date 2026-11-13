// Flight logbook routes, all under /logbook.
// Every person has their own logbook and logs in with their own email and password (accounts.js).
//   router     - the logbook pages and their data (logbook login required)
//   pcRouter   - for the "Import Flights" program on the drone PC; checked with that person's upload key
const express = require('express');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../config');
const db = require('../db');
const store = require('./store');
const dji = require('./dji');
const sites = require('./sites');
const { importCmd } = require('./pcscript');
const accounts = require('./accounts');

const router = express.Router();
router.use(accounts.pub);                                          // login, set password, forgotten password
router.use((req, res, next) => (!/^\/logbook(\/|$)/.test(req.path) || req.path.startsWith('/logbook/api/pc/')) ? next() : accounts.requireUser(req, res, next));
const pcRouter = express.Router();
const PUB = path.join(__dirname, 'public');
// Changes on every restart (each publish), so browsers and GoDaddy's cache fetch the new scripts.
const VERSION = Date.now().toString(36);
const raw = (limit) => [express.raw({ type: () => true, limit }),
  (req, res, next) => Buffer.isBuffer(req.body) ? next() : fail(res, 'Send the file as raw data (Content-Type: application/octet-stream).')];
const fail = (res, e, code = 400) => res.status(code).type('text').send(String(e?.message || e));

router.use(require('./network').router);                          // Aspex jobs shared with network pilots

// ---------- pages ----------
// The page uses relative links, so it must be served at /logbook/ (with the slash).
router.get('/logbook', (req, res) => req.originalUrl.split('?')[0].endsWith('/')
  ? res.type('html').set('Cache-Control', 'no-store').send(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/\.(cjs|js)"><\/script>/g, `.$1?v=${VERSION}"></script>`))
  : res.redirect('/logbook/'));
router.get('/logbook/help', (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(fs.readFileSync(path.join(PUB, 'help.html'))));
router.get(/^\/logbook\/(geo\.cjs|bb3\.cjs|ops\.js|inv\.js|casa\.js|aspex\.js)$/, (req, res) => res.type('text/javascript').set('Cache-Control', 'public, max-age=31536000, immutable').send(fs.readFileSync(path.join(PUB, req.params[0]))));

// ---------- data ----------
router.get('/logbook/api/logbook', (req, res) => res.json({ flights: store.flights(req.lb.id)
  .sort((a, b) => (a.startUtc || '').localeCompare(b.startUtc || '')).map(store.publicFlight) }));
router.get('/logbook/api/inventory', (req, res) => res.json(store.inventory(req.lb.id)));
router.post('/logbook/api/inventory', (req, res) => res.json(store.saveInventory(req.lb.id, req.body || {})));
router.get('/logbook/api/ops', (req, res) => res.json(store.ops(req.lb.id)));
router.post('/logbook/api/ops', express.json({ limit: '2mb' }), (req, res) => res.json(store.saveOps(req.lb.id, req.body || {})));
router.post('/logbook/api/flights/:sha', (req, res) => {          // CASA fields and notes on one flight
  const f = store.flightBySha(req.lb.id, req.params.sha);
  if (!f) return fail(res, 'no such flight', 404);
  const b = req.body || {}, ch = {};
  const LIM = { pic: 120, otherPilot: 120, opType: 5, serviceable: 3, defect: 2000, notes: 2000 };
  for (const [k, n] of Object.entries(LIM)) if (k in b) ch[k] = store.clean(b[k], n);
  if (ch.opType && !['VLOS', 'EVLOS', 'BVLOS'].includes(ch.opType)) delete ch.opType;
  if (ch.serviceable && !['yes', 'no'].includes(ch.serviceable)) delete ch.serviceable;
  res.json(store.publicFlight(db.update('lbFlights', f.id, ch)));
});
router.post('/logbook/api/sites/:id/kml', raw('20mb'), (req, res) => {
  try { res.json(sites.setBoundary(req.lb.id, store.safeKey(req.params.id), req.body, req.query.name || '')); } catch (e) { fail(res, e); }
});
router.post('/logbook/api/sites-from-points', express.json({ limit: '2mb' }), (req, res) => {
  try { res.json(sites.sitesFromPoints(req.lb.id, (req.body || {}).sites)); } catch (e) { fail(res, e); }
});
router.get('/logbook/api/near', async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail(res, 'bad position');
  res.json({ name: await sites.nearestPlace(lat, lon) });
});
router.post('/logbook/api/sites/:id/airspace', async (req, res) => {
  try { res.json(await sites.checkAirspace(req.lb.id, store.safeKey(req.params.id), req.query.refresh === '1')); } catch (e) { fail(res, e); }
});

async function track(req) {
  const f = store.flightByFile(req.lb.id, req.params.file + '.txt') || store.flightByFile(req.lb.id, req.params.file);
  if (!f?.trackFile) return null;
  const file = await db.readFile(f.trackFile);
  return file && { f, gj: JSON.parse(file.content.toString('utf8')) };
}
router.get('/logbook/api/track/:file', async (req, res) => {
  const t = await track(req);
  t ? res.type('application/geo+json').send(t.gj) : fail(res, 'no track', 404);
});
router.get('/logbook/kml/:file.kml', async (req, res) => {
  const t = await track(req);
  if (!t) return fail(res, 'no track', 404);
  res.type('application/vnd.google-earth.kml+xml').attachment(req.params.file + '.kml').send(dji.kml(t.f, t.gj));
});
router.get('/logbook/logbook.csv', (req, res) => {
  const rows = store.flights(req.lb.id).sort((a, b) => (a.startUtc || '').localeCompare(b.startUtc || ''));
  res.type('text/csv').attachment(`Aspex flight logbook ${db.today()}.csv`).send(dji.csv(rows));
});

// ---------- import: status, manual upload in the browser, settings ----------
router.get('/logbook/api/import/status', (req, res) => {
  res.json({ dji: !!(req.lb.djiApiKey || '').trim(), uploads: store.uploads(req.lb.id).slice(0, 60) });
});
// Files the browser needn't send: already logged, and either not a battery's latest flight or already
// cycle-checked. So dropping a whole folder only uploads what's new plus each battery's latest flight.
router.get('/logbook/api/import/skip', (req, res) => {
  const fl = store.flights(req.lb.id).filter(f => f.file);
  const latest = {};
  for (const f of fl) if (f.batterySn && f.track === 'ok' && (!latest[f.batterySn] || (f.startUtc || '') > (latest[f.batterySn].startUtc || ''))) latest[f.batterySn] = f;
  const wanted = new Set(Object.values(latest).filter(dji.needsCycles).map(f => f.file));
  res.json({ skip: fl.filter(f => dji.isDone(f) && !wanted.has(f.file)).map(f => f.file) });
});
router.post('/logbook/api/upload', raw('60mb'), async (req, res) => {   // drag-and-drop .txt files in the browser
  try {
    const name = path.basename(String(req.query.name || ''));
    if (!/^(DJI)?FlightRecord_.*\.txt$/i.test(name)) return fail(res, 'That isn’t a DJI flight record (DJIFlightRecord_….txt)');
    const r = await dji.processFile(req.lb, req.body, name, { cycleCheck: true });   // only browser drops look again for cycles
    const line = { file: name, status: r.status, track: r.flight.track, via: 'browser' };
    if (r.status !== 'already had') store.noteUpload(req.lb.id, line);
    res.json({ ...line, summary: summary(r) });
  } catch (e) { fail(res, e, 500); }
});
router.post('/logbook/api/upload-ebee', express.json({ limit: '10mb' }), async (req, res) => {   // one eBee flight, read in the browser
  try {
    const r = await require('./ebee').processFlight(req.lb, req.body || {});
    const line = { file: r.file, status: r.status, track: r.flight.track, via: 'browser' };
    if (r.status !== 'already had') store.noteUpload(req.lb.id, line);
    res.json({ ...line, summary: summary(r) });
  } catch (e) { fail(res, e, e.message && e.message.startsWith('That isn') ? 400 : 500); }
});
// The logbook owner's own pilot details (remote pilot log header).
const PROFILE = { fullName: 120, arn: 20, replNo: 40, replClass: 200, replExpiry: 10, insuranceExpiry: 10, otherQuals: 1000, defaultOpType: 5, remindersOff: 1 };
const reminders = require('./reminders');
router.get('/logbook/api/reminders', (req, res) => res.json(reminders.itemsFor(req.lb)));
router.post('/logbook/api/reminders/send', async (req, res) => {
  try { const r = await reminders.sendTo(db.get('lbUsers', req.lb.id), { force: true }); res.json({ ok: true, to: req.lb.email, sent: r.sent }); }
  catch (e) { fail(res, 'Couldn\u2019t send the email: ' + (e.message || e), 500); }
});
router.get('/logbook/api/profile', (req, res) => res.json({ fullName: req.lb.name, ...(req.lb.profile || {}) }));
router.post('/logbook/api/profile', (req, res) => {
  const p = { ...(req.lb.profile || {}) }, b = req.body || {};
  for (const [k, n] of Object.entries(PROFILE)) if (k in b) p[k] = store.clean(b[k], n);
  res.json(db.update('lbUsers', req.lb.id, { profile: p }).profile);
});
router.get('/logbook/api/settings', (req, res) => {
  const u = req.lb;
  res.json({ name: u.name, email: u.email, role: u.role, dji: !!(u.djiApiKey || '').trim(), djiHint: u.djiApiKey ? '…' + u.djiApiKey.slice(-4) : '',
    skydio: !!(u.skydioToken || '').trim(), skydioHint: u.skydioToken ? '…' + u.skydioToken.slice(-4) : '', skydioSyncedAt: u.skydioSyncedAt || '', skydioLast: u.skydioLast || null });
});
router.post('/logbook/api/settings', (req, res) => {
  const b = req.body || {}, ch = {};
  if (typeof b.djiApiKey === 'string') ch.djiApiKey = b.djiApiKey.trim().slice(0, 100);
  if (typeof b.skydioToken === 'string') ch.skydioToken = b.skydioToken.trim().slice(0, 200);
  if (b.newUploadKey) ch.uploadKey = require('crypto').randomBytes(18).toString('base64url');
  db.update('lbUsers', req.lb.id, ch);
  res.json({ ok: true });
});
// Moving history across from Drone Logbook CSV exports: preview first, then import.
router.post('/logbook/api/dlb/preview', express.json({ limit: '20mb' }), (req, res) => {
  try { const p = require('./dlb').plan(req.lb, req.body.files); res.json({ ...p, entries: undefined }); } catch (e) { fail(res, e, 400); }
});
router.post('/logbook/api/dlb/import', express.json({ limit: '20mb' }), (req, res) => {
  try { res.json(require('./dlb').commit(req.lb, req.body.files)); } catch (e) { fail(res, e, 400); }
});
router.post('/logbook/api/skydio/sync', async (req, res) => {
  try { res.json(await require('./skydio').sync(db.get('lbUsers', req.lb.id))); }
  catch (e) { res.status(e.status === 401 || e.status === 403 ? 400 : 502).type('text').send(String(e.message || e)); }
});
router.get('/logbook/import-flights.cmd', (req, res) => {
  res.type('application/octet-stream').attachment('Import Flights.cmd').send(importCmd(`${req.protocol}://${req.get('host')}`, req.lb.uploadKey));   // the address you downloaded it from
});

// One-off move from the old PC logbook ("Logbook export for website.json.gz").
router.post('/logbook/api/migrate', raw('100mb'), async (req, res) => {
  try {
    const uid = req.lb.id;
    let buf = req.body;
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const b = JSON.parse(buf.toString('utf8'));
    const out = { flights: 0, tracks: 0, keys: 0, skipped: 0 };
    const keyByFile = {};
    for (const [name, k] of Object.entries(b.keys || {})) keyByFile[name.replace(/\.keychains\.json$/, '')] = k;
    for (const f of b.logbook?.flights || []) {
      if (!f.sha256) continue;
      if (store.flightBySha(uid, f.sha256)) { out.skipped++; continue; }
      const base = (f.file || '').replace(/\.txt$/i, '');
      const { job, ...entry } = f;
      if (b.ops?.flightJob?.[f.sha256]) entry.jobId = b.ops.flightJob[f.sha256];
      const gj = b.tracks?.[base];
      if (gj && f.track === 'ok') { entry.trackFile = await db.saveFile(Buffer.from(JSON.stringify(gj)), base + '.geojson', 'application/geo+json'); out.tracks++; }
      store.putFlight(uid, entry); out.flights++;
      if (keyByFile[base]) { store.putKeys(f.sha256, keyByFile[base]); out.keys++; }
    }
    store.renumber(uid);
    // extra per-flight figures worked out later from the original files (e.g. battery cycle counts)
    for (const [sha, extra] of Object.entries(b.flightExtras || {})) {
      const f = store.flightBySha(uid, sha);
      if (f && extra && Number.isFinite(extra.batteryCycles)) { db.update('lbFlights', f.id, { batteryCycles: extra.batteryCycles }); out.extras = (out.extras || 0) + 1; }
    }
    if (b.inventory) store.saveInventory(uid, b.inventory);
    for (const kind of ['clients', 'sites', 'jobs']) {
      for (const [key, item] of Object.entries(b.ops?.[kind] || {})) if (store.safeKey(key) && item) store.putOps(uid, kind, key, item);
    }
    for (const f of b.logbook?.flights || []) {                    // job links for flights that were already here
      const jobId = b.ops?.flightJob?.[f.sha256], cur = jobId && store.flightBySha(uid, f.sha256);
      if (cur && !cur.jobId) db.update('lbFlights', cur.id, { jobId });
    }
    await db.flush();
    store.noteUpload(uid, { file: 'old PC logbook', status: `moved ${out.flights} flights, ${out.tracks} tracks`, via: 'migration' });
    res.json(out);
  } catch (e) { fail(res, e, 500); }
});

function summary(r) {
  const f = r.flight;
  if (r.status === 'already had') return 'already in the logbook' + (r.note ? ` (${r.note})` : '');
  if (r.status === 'cycles checked') return `already in the logbook; battery ${f.batteryCycles != null ? f.batteryCycles + ' charge cycles' : '-'} (${f.batteryCyclesNote || 'no cycle count'})`;
  if (!f.isFlight) return f.track === 'error' ? 'could not read: ' + (f.error || '') : 'motor start, no take-off';
  const t = { ok: 'track ok', 'no key': 'no GPS track yet - add the DJI key in Settings', 'key error': 'DJI refused the key request' }[f.track] || f.track;
  return `${f.flightNo || ''} ${f.durationMin} min, ${t}`.trim();
}

// ---------- the drone PC's Import Flights program ----------
pcRouter.use('/logbook/api/pc', (req, res, next) => {
  const u = accounts.byUploadKey(req.get('x-logbook-key') || '');
  if (!u || u.disabled) return fail(res, 'Upload key not accepted. Download Import Flights again from the logbook’s Import window.', 401);
  req.lb = u;
  next();
});
pcRouter.post('/logbook/api/pc/need', express.json({ limit: '5mb' }), (req, res) => {
  const byFile = new Map(store.flights(req.lb.id).map(f => [f.file, f]));
  const need = (req.body?.files || []).filter(x => {
    const f = byFile.get(x.name);
    return !f || !dji.isDone(f) || (f.bytes && x.bytes && f.bytes !== x.bytes);
  }).map(x => x.name);
  res.json({ need });
});
pcRouter.post('/logbook/api/pc/upload', raw('60mb'), async (req, res) => {
  try {
    const name = path.basename(String(req.query.name || ''));
    if (!/^(DJI)?FlightRecord_.*\.txt$/i.test(name)) return fail(res, 'not a DJI flight record');
    const r = await dji.processFile(req.lb, req.body, name);
    if (r.status !== 'already had') store.noteUpload(req.lb.id, { file: name, status: r.status, track: r.flight.track, via: 'drone PC' });
    res.json({ status: r.status, summary: summary(r) });
  } catch (e) { fail(res, e, 500); }
});
pcRouter.post('/logbook/api/pc/done', express.json(), (req, res) => {
  const b = req.body || {};
  store.noteUpload(req.lb.id, { file: 'Import Flights run', status: `${Number(b.copied) || 0} copied from controller, ${Number(b.sent) || 0} sent${b.failed ? `, ${Number(b.failed)} failed` : ''}`, via: 'drone PC', summaryLine: true });
  res.json({ ok: true });
});

module.exports = { router, pcRouter, admin: accounts.admin };
