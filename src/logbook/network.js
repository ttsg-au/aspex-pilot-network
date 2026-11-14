// Aspex jobs shared with network pilots.
// A job in your (the owner's) logbook can be linked to a pilot network job. Pilots assigned to that
// network job who have a logbook account then see it under "Aspex jobs" in their own logbook:
// dates, site boundary, Dropbox folder, the site SWMS and Aspex's capture settings.
// Operating basis is always "independent operator" for now: pilots fly under their own accreditation
// and their own checklists; the work isn't carried out under an Aspex ReOC; the SWMS applies to the site.
// Their flights on the job's site during the job are visible to you (route included).
const express = require('express');
const db = require('../db');
const store = require('./store');
const Geo = require('./public/geo.cjs');

const BASIS = {
  independent: {
    label: 'Independent operator',
    text: 'You fly this job as an independent operator, under your own accreditation, licence and procedures. '
      + 'This work isn’t carried out under an Aspex ReOC. Your aircraft, pre-flight and operational checklists are your own. '
      + 'The site SWMS applies to everyone working on this site and must be followed. '
      + 'Your flights on this site during the job are shared with Aspex (route, times, aircraft, battery and defects) so the job can be recorded and any incident looked into.',
    acks: [
      'I’ll fly this job as an independent operator, under my own accreditation and using my own checklists and procedures.',
      'I’ve read the site SWMS and will follow it.',
      'I understand my flights on this job are shared with Aspex.',
    ],
  },
};

const owner = () => db.all('lbUsers').find(u => u.role === 'owner');
const assignedPilotIds = (networkJobId) => new Set(db.all('jobResponses').filter(r => r.jobId === networkJobId && r.assigned).map(r => r.pilotId));
const dayAdd = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// The owner's logbook jobs that are linked to a network job, with their site.
function linkedJobs() {
  const o = owner(); if (!o) return [];
  const ops = store.ops(o.id);
  return Object.entries(ops.jobs).filter(([, j]) => j.networkJobId).map(([key, j]) => ({ key, job: j, site: ops.sites[j.siteId] || null }));
}
// A pilot's flights that belong to the job: take-off on (or near) the site, within the job's dates.
function matchFlights(uid, job, site) {
  if (!site?.boundary?.length || !job.start) return [];
  const from = dayAdd(job.start, -1), to = dayAdd(job.end || job.start, 1), margin = Number(site.marginM) || 500;
  return store.flights(uid).filter(f => f.isFlight && f.takeoffLat != null && f.startLocal
    && f.startLocal.slice(0, 10) >= from && f.startLocal.slice(0, 10) <= to
    && Geo.distToPolys([f.takeoffLon, f.takeoffLat], site.boundary) <= margin)
    .sort((a, b) => a.startLocal.localeCompare(b.startLocal));
}
const progress = (uid) => store.state('aspexjobs', uid, {});
const setProgress = (uid, v) => store.setState('aspexjobs', uid, v);
const flightOut = (f) => ({ sha256: f.sha256, file: f.file, flightNo: f.flightNo, startLocal: f.startLocal, endLocal: f.endLocal, durationMin: f.durationMin,
  aircraftModel: f.aircraftModel, aircraftSn: f.aircraftSn, batterySn: f.batterySn, maxHeightM: f.maxHeightM, distanceKm: f.distanceKm,
  track: f.track, pic: f.pic, opType: f.opType, serviceable: f.serviceable, defect: f.defect, takeoffLat: f.takeoffLat, takeoffLon: f.takeoffLon });
// Approvals linked to a job: the summary others may see (no private notes), and the document.
const approvalOut = (key, a, from, job) => ({ key, from, type: a.type, title: a.title, authority: a.authority, ref: a.ref,
  validFrom: a.validFrom, validTo: a.validTo, area: a.area, heightFt: a.heightFt, conditions: a.conditions,
  docName: a.docFile ? a.docName : '', covers: store.covers(a, job || {}) });
const ownerApprovals = (key, job) => { const o = owner(); if (!o) return [];
  return Object.entries(store.ops(o.id).approvals).filter(([, a]) => store.keysOf(a.jobs).includes(key)).map(([k, a]) => approvalOut(k, a, 'Aspex', job)); };
const pilotApprovals = (uid, key, job) => Object.entries(store.ops(uid).approvals)
  .filter(([, a]) => store.keysOf(a.aspexJobs).includes(key)).map(([k, a]) => approvalOut(k, a, 'pilot', job));
const DOC_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
async function sendDoc(res, item) {
  const file = item?.docFile && await db.readFile(item.docFile);
  if (!file) return res.status(404).type('text').send('No document attached.');
  const name = String(item.docName || 'approval').replace(/["\r\n]/g, '');
  res.type(file.mime || DOC_TYPES[name.split('.').pop().toLowerCase()] || 'application/octet-stream')
    .set('Content-Disposition', `inline; filename="${name}"`).send(file.content);
}
const siteOut = (s) => s && { name: s.name, areaHa: s.areaHa, centroid: s.centroid, boundary: s.boundary };

// Jobs a pilot (logbook user) has been assigned to.
function jobsFor(u) {
  if (!u.pilotId) return [];
  const prog = progress(u.id);
  return linkedJobs().filter(x => assignedPilotIds(x.job.networkJobId).has(u.pilotId)).map(({ key, job, site }) => ({
    key, name: job.name, start: job.start, end: job.end, status: job.status,   // no client, ref, SiteMark link or notes
    dropboxUrl: job.dropboxUrl, swmsUrl: job.swmsUrl, capture: job.capture, basis: BASIS.independent,
    siteContactName: job.siteContactName, siteContactPhone: job.siteContactPhone, safety: job.safety, safetyNotes: job.safetyNotes,
    approvalRequired: job.approvalRequired === '1', approvalNote: job.approvalNote || '',
    approvals: [...ownerApprovals(key, job), ...pilotApprovals(u.id, key, job)],
    site: siteOut(site), progress: prog[key] || {},
    flights: matchFlights(u.id, job, site).map(flightOut),
  }));
}

const router = express.Router();          // mounted after the logbook login check
const ownerOnly = (req, res, next) => req.lb.role === 'owner' ? next() : res.status(403).type('text').send('Only the Aspex account can see this.');

// ---- pilot side ----
router.get('/logbook/api/aspex-jobs', (req, res) => res.json({ jobs: jobsFor(req.lb) }));
function myJob(req, res) {
  const j = jobsFor(req.lb).find(x => x.key === req.params.key);
  if (!j) { res.status(404).type('text').send('That job isn’t assigned to you.'); return null; }
  return j;
}
router.post('/logbook/api/aspex-jobs/:key/ack', (req, res) => {
  const j = myJob(req, res); if (!j) return;
  const ticks = req.body?.ticks || [];
  if (ticks.length !== j.basis.acks.length || !ticks.every(Boolean)) return res.status(400).type('text').send('Tick all three to accept the job.');
  const p = progress(req.lb.id);
  p[j.key] = { ...(p[j.key] || {}), ackAt: new Date().toISOString(), ackBasis: 'independent', ackText: j.basis.acks };
  setProgress(req.lb.id, p); res.json(p[j.key]);
});
router.post('/logbook/api/aspex-jobs/:key/day', (req, res) => {          // "I did my own pre-flight checks" for a day
  const j = myJob(req, res); if (!j) return;
  const date = String(req.body?.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).end();
  const p = progress(req.lb.id), e = p[j.key] = { ...(p[j.key] || {}) };
  e.days = { ...(e.days || {}) };
  if (req.body.done) e.days[date] = { at: new Date().toISOString(), note: store.clean(req.body.note, 500) }; else delete e.days[date];
  setProgress(req.lb.id, p); res.json(e);
});
router.post('/logbook/api/aspex-jobs/:key/complete', (req, res) => {
  const j = myJob(req, res); if (!j) return;
  const p = progress(req.lb.id), e = p[j.key] = { ...(p[j.key] || {}) };
  e.completeAt = req.body?.undo ? '' : new Date().toISOString();
  setProgress(req.lb.id, p); res.json(e);
});
router.get('/logbook/aspex-jobs/:key/site.kml', (req, res) => {
  const j = myJob(req, res); if (!j) return;
  if (!j.site?.boundary) return res.status(404).type('text').send('No site boundary loaded yet.');
  const x = (s) => String(s ?? '').replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  const ring = (r) => r.map(p => `${p[0]},${p[1]},0`).join(' ');
  res.type('application/vnd.google-earth.kml+xml').attachment(`${(j.site.name || 'site').replace(/[^\w -]/g, '')} boundary.kml`).send(
    `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(j.site.name)}</name>`
    + j.site.boundary.map(poly => `<Placemark><name>${x(j.site.name)}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(poly[0])}</coordinates></LinearRing></outerBoundaryIs>`
      + poly.slice(1).map(h => `<innerBoundaryIs><LinearRing><coordinates>${ring(h)}</coordinates></LinearRing></innerBoundaryIs>`).join('') + '</Polygon></Placemark>').join('')
    + '</Document></kml>');
});
router.get('/logbook/api/aspex-jobs/:key/track/:file', async (req, res) => {
  const j = myJob(req, res); if (!j) return;
  const f = j.flights.find(x => x.file === req.params.file);
  const full = f && store.flightBySha(req.lb.id, f.sha256);
  const file = full?.trackFile && await db.readFile(full.trackFile);
  file ? res.type('application/geo+json').send(file.content) : res.status(404).end();
});

router.get('/logbook/api/aspex-jobs/:key/approval/:akey/doc', (req, res) => {   // an Aspex approval for this job
  const j = myJob(req, res); if (!j) return;
  const a = j.approvals.find(x => x.from === 'Aspex' && x.key === req.params.akey);
  sendDoc(res, a && store.opsDoc(owner().id, 'approvals', a.key)?.item);
});

// ---- owner side ----
router.get('/logbook/api/network-jobs', ownerOnly, (req, res) => res.json({
  jobs: db.all('jobs').slice().sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || ''))).map(j => ({ id: j.id, title: j.title, startDate: j.startDate, status: j.status })),
}));
router.get('/logbook/api/jobs/:key/network', ownerOnly, (req, res) => {
  const x = linkedJobs().find(l => l.key === req.params.key);
  if (!x) return res.json({ pilots: [] });
  const ids = assignedPilotIds(x.job.networkJobId);
  const pilots = [...ids].map(pid => {
    const p = db.get('pilots', pid) || {};
    const u = db.all('lbUsers').find(v => v.pilotId === pid && !v.disabled);
    const fl = u ? matchFlights(u.id, x.job, x.site) : [];
    return { pilotId: pid, name: p.fullName || '(deleted pilot)', uid: u?.id || '', hasLogbook: !!u, active: !!u?.pwHash,
      progress: u ? (progress(u.id)[x.key] || {}) : {}, flights: fl.map(flightOut),
      approvals: u ? pilotApprovals(u.id, x.key, x.job) : [] };
  });
  res.json({ pilots, basis: BASIS.independent.label });
});
router.get('/logbook/api/jobs/:key/network-track/:uid/:file', ownerOnly, async (req, res) => {
  const x = linkedJobs().find(l => l.key === req.params.key);
  const u = x && db.get('lbUsers', req.params.uid);
  if (!u || !assignedPilotIds(x.job.networkJobId).has(u.pilotId)) return res.status(404).end();
  const f = matchFlights(u.id, x.job, x.site).find(y => y.file === req.params.file);   // only flights on this job
  const file = f?.trackFile && await db.readFile(f.trackFile);
  file ? res.type('application/geo+json').send(file.content) : res.status(404).end();
});

router.get('/logbook/api/jobs/:key/network-approval/:uid/:akey/doc', ownerOnly, (req, res) => {   // a pilot's own approval for the job
  const x = linkedJobs().find(l => l.key === req.params.key);
  const u = x && db.get('lbUsers', req.params.uid);
  if (!u || !assignedPilotIds(x.job.networkJobId).has(u.pilotId)) return res.status(404).end();
  const d = store.safeKey(req.params.akey) && store.opsDoc(u.id, 'approvals', req.params.akey);
  sendDoc(res, d && store.keysOf(d.item.aspexJobs).includes(x.key) ? d.item : null);
});

// All the approvals assigned pilots have linked to one of the owner's jobs.
function pilotApprovalsForJob(key) {
  const x = linkedJobs().find(l => l.key === key); if (!x) return [];
  const ids = assignedPilotIds(x.job.networkJobId);
  return db.all('lbUsers').filter(u => ids.has(u.pilotId) && !u.disabled).flatMap(u => pilotApprovals(u.id, key, x.job));
}

module.exports = { router, BASIS, jobsFor, sendDoc, pilotApprovalsForJob };
