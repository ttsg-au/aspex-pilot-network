// Photo coverage check for a job.
// The pilot's browser reads just the position block of each photo (GPS, height, gimbal angle, camera)
// straight off their SSD or card - nothing is uploaded but a few numbers per photo. Here we keep those
// numbers per job and per person, so the job map can show what's covered and where the gaps are,
// day by day, while the pilots are still on site.
//
// Stored as one file per job and person (app_files), with a small index in state 'coverage' keyed by job.
const express = require('express');
const db = require('../db');
const store = require('./store');

const owner = () => db.all('lbUsers').find(u => u.role === 'owner');
const MAX_IMAGES = 60000;     // per person per job

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

async function readImages(entry) {
  if (!entry?.fileId) return [];
  try { const f = await db.readFile(entry.fileId); return f ? JSON.parse(f.content.toString()) : []; } catch { return []; }
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
  const idx = index(job.key), mine = idx[req.lb.id] || {};
  const byKey = new Map((await readImages(mine)).map(p => [p.f + '|' + p.d, p]));
  for (const p of add) byKey.set(p.f + '|' + p.d, p);
  const all = [...byKey.values()].slice(-MAX_IMAGES);
  const fileId = await db.saveFile(Buffer.from(JSON.stringify(all)), `coverage-${job.key}-${req.lb.id}.json`, 'application/json');
  if (mine.fileId) db.deleteFile(mine.fileId);
  idx[req.lb.id] = { fileId, name: req.lb.name || req.lb.email, count: all.length, updatedAt: new Date().toISOString(),
    days: [...new Set(all.map(p => p.d.slice(0, 10)).filter(Boolean))].sort() };
  setIndex(job.key, idx);
  res.json({ added: add.length, total: all.length });
});

// Everything needed to draw the coverage map: the site boundary and the photos.
// The owner sees every pilot's photos on her job; a pilot sees only their own.
router.get('/logbook/api/coverage/:key', async (req, res) => {
  const job = jobFor(req.lb, req.params.key);
  if (!job) return res.status(404).type('text').send('That job isn’t one of yours.');
  const idx = index(job.key), people = [];
  for (const [uid, e] of Object.entries(idx)) {
    if (req.lb.role !== 'owner' && uid !== req.lb.id) continue;
    people.push({ uid, name: e.name, count: e.count, updatedAt: e.updatedAt, images: await readImages(e) });
  }
  res.json({ key: job.key, me: req.lb.id, name: job.name, boundary: job.site?.boundary || null, siteName: job.site?.name || '', people });
});

// Clear my photos for this job (e.g. sent the wrong folder).
router.post('/logbook/api/coverage/:key/clear', async (req, res) => {
  const job = jobFor(req.lb, req.params.key);
  if (!job) return res.status(404).end();
  const idx = index(job.key);
  if (idx[req.lb.id]?.fileId) db.deleteFile(idx[req.lb.id].fileId);
  delete idx[req.lb.id]; setIndex(job.key, idx);
  res.json({ ok: true });
});

module.exports = { router, clean };
