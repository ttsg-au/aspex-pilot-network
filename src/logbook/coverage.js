// Photo coverage check for a job.
// The pilot's browser reads just the position block of each photo (GPS, height, gimbal angle, camera)
// straight off their SSD or card - nothing is uploaded but a few numbers per photo. Here we keep those
// numbers per job and per person, so the job map can show what's covered and where the gaps are,
// day by day, while the pilots are still on site.
//
// Stored as one file per job and person (app_files), with a small index in state 'coverage' keyed by job.
const express = require('express');
const zlib = require('zlib');
const db = require('../db');
const store = require('./store');

const owner = () => db.all('lbUsers').find(u => u.role === 'owner');
const MAX_IMAGES = 600000;    // per person per job (a big solar farm is well over 100,000 photos)

// The job's key, name and site, if this logbook user may see / add coverage for it.
// The owner: any of her own jobs. A pilot: an Aspex job assigned to them.
function jobFor(u, key) {
  const o = owner();
  if (u.role === 'owner') {
    const ops = store.ops(u.id), j = ops.jobs[key];
    return j ? { key, name: j.name, site: ops.sites[j.siteId] || null } : null;
  }
  const j = require('./network').jobsFor(u).find(x => x.key === key);
  return j && o ? { key, name: j.name, site: j.site } : null;
}

const index = (key) => store.state('coverage', 'job:' + key, {});
const setIndex = (key, v) => store.setState('coverage', 'job:' + key, v);

// Each person's photo positions for a job: kept in memory while the app runs, and saved to the
// database in chunks (a few thousand photos each) so no single save is too big. If a save or a read
// fails, the request fails loudly instead of quietly starting again from nothing.
const CHUNK = 4000;
const cache = new Map();                         // 'job|uid' -> [records]
const idsOf = (entry) => entry?.fileIds || (entry?.fileId ? [entry.fileId] : []);

async function readImages(key, uid, entry) {
  const ck = key + '|' + uid;
  if (cache.has(ck)) return cache.get(ck);
  const all = [];
  for (const id of idsOf(entry)) {
    const f = await db.readFile(id);
    if (!f) throw new Error('missing saved photo file ' + id);
    all.push(...JSON.parse(f.content.toString()));
  }
  cache.set(ck, all);
  return all;
}
// Saves the chunks from `from` (a photo index) onwards; the chunks before it haven't changed and keep
// their saved files. Returns the full list of file ids, and the old ids that are no longer used.
async function saveImages(key, uid, all, from = 0, oldIds = []) {
  const first = Math.floor(from / CHUNK), ids = oldIds.slice(0, first), fresh = [];
  for (let k = first * CHUNK; k < all.length; k += CHUNK) {
    const id = await db.saveFile(Buffer.from(JSON.stringify(all.slice(k, k + CHUNK))), `coverage-${key}-${uid}-${ids.length + 1}.json`, 'application/json');
    if (!(await db.readFile(id))) {                // the database didn't keep it
      for (const x of fresh) db.deleteFile(x);
      throw new Error('the database did not save the photo positions');
    }
    ids.push(id); fresh.push(id);
  }
  return { ids, unused: oldIds.filter(x => !ids.includes(x)) };
}

// One photo as sent by the browser -> a compact, checked record.
const n = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x * 1e6) / 1e6 : null; };
function clean(p) {
  const r = {
    f: String(p.f || '').slice(0, 120),                 // file name
    d: /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(p.d || '') ? p.d : '',   // date taken (local)
    t: ['T', 'W', 'Z', 'V', 'M'].includes(p.t) ? p.t : 'V',   // thermal / wide / zoom / visual / other
    lat: n(p.lat, -90, 90), lon: n(p.lon, -180, 180),
    w: n(p.w, 0.5, 2000), h: n(p.h, 0.5, 2000),          // footprint on the ground, metres
    yaw: n(p.yaw, -360, 360) ?? 0, alt: n(p.alt, -500, 2000),
    off: p.off ? 1 : 0,                                  // not pointing straight down: not counted
  };
  return r.f && r.lat != null && r.lon != null ? r : null;
}

const router = express.Router();

// Add (or replace) photos for this job. The same photo sent again replaces the earlier copy.
router.post('/logbook/api/coverage/:key', express.json({ limit: '4mb' }), async (req, res) => {
  const job = jobFor(req.lb, req.params.key);
  if (!job) return res.status(404).type('text').send('That job isn’t one of yours.');
  const add = (Array.isArray(req.body?.images) ? req.body.images : []).slice(0, 5000).map(clean).filter(Boolean);
  const uid = req.lb.id, idx = index(job.key), mine = idx[uid] || {};
  let prev;
  try { prev = await readImages(job.key, uid, mine); }
  catch (e) {
    console.error('Coverage: could not read saved photos for', job.key, uid, e.message);
    return res.status(503).type('text').send('The photos already saved for this job couldn’t be read just now, so nothing was changed. Please try again in a minute');
  }
  // Photos already saved are updated in place; new ones go on the end. Only the chunks that changed are saved again.
  const all = prev.slice(), at = new Map(all.map((p, k) => [p.f + '|' + p.d, k]));
  let from = all.length;
  for (const p of add) {
    const k = at.get(p.f + '|' + p.d);
    if (k != null) { all[k] = p; from = Math.min(from, k); }
    else { at.set(p.f + '|' + p.d, all.length); all.push(p); }
  }
  let keep = all;
  if (all.length > MAX_IMAGES) { keep = all.slice(-MAX_IMAGES); from = 0; }
  const canReuse = Array.isArray(mine.fileIds);        // older saves weren't in even chunks: save everything again
  let saved;
  try { saved = await saveImages(job.key, uid, keep, canReuse ? from : 0, canReuse ? mine.fileIds : []); }
  catch (e) {
    console.error('Coverage: could not save photos for', job.key, uid, e.message);
    return res.status(503).type('text').send('The photo positions couldn’t be saved just now. Please try again in a minute');
  }
  cache.set(job.key + '|' + uid, keep);
  for (const id of canReuse ? saved.unused : idsOf(mine)) db.deleteFile(id);
  idx[uid] = { fileIds: saved.ids, name: req.lb.name || req.lb.email, count: keep.length, updatedAt: new Date().toISOString(),
    days: [...new Set(keep.map(p => p.d.slice(0, 10)).filter(Boolean))].sort() };
  setIndex(job.key, idx);
  if (all.length > MAX_IMAGES) console.error('Coverage: over', MAX_IMAGES, 'photos for', job.key, uid);
  res.json({ added: add.length, total: keep.length, dropped: all.length - keep.length });
});

// Everything needed to draw the coverage map: the site boundary and the photos.
// The owner sees every pilot's photos on her job; a pilot sees only their own.
router.get('/logbook/api/coverage/:key', async (req, res) => {
  const job = jobFor(req.lb, req.params.key);
  if (!job) return res.status(404).type('text').send('That job isn’t one of yours.');
  const idx = index(job.key), people = [];
  for (const [uid, e] of Object.entries(idx)) {
    if (req.lb.role !== 'owner' && uid !== req.lb.id) continue;
    let images = [];
    try { images = await readImages(job.key, uid, e); } catch (err) { console.error('Coverage: could not read photos for', job.key, uid, err.message); }
    people.push({ uid, name: e.name, count: images.length || e.count, updatedAt: e.updatedAt, images });
  }
  const body = JSON.stringify({ key: job.key, me: req.lb.id, name: job.name, boundary: job.site?.boundary || null, blocks: job.site?.blocks || null, siteName: job.site?.name || '', people });
  res.type('json');                                    // a whole solar farm is tens of MB: send it compressed
  if (/\bgzip\b/.test(req.get('accept-encoding') || '')) { res.set('Content-Encoding', 'gzip'); res.set('Vary', 'Accept-Encoding'); return res.send(zlib.gzipSync(body)); }
  res.send(body);
});

// Clear my photos for this job (e.g. sent the wrong folder).
router.post('/logbook/api/coverage/:key/clear', async (req, res) => {
  const job = jobFor(req.lb, req.params.key);
  if (!job) return res.status(404).end();
  const idx = index(job.key);
  for (const id of idsOf(idx[req.lb.id])) db.deleteFile(id);
  cache.delete(job.key + '|' + req.lb.id);
  delete idx[req.lb.id]; setIndex(job.key, idx);
  res.json({ ok: true });
});

module.exports = { router, clean };
