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
// "Sighted": Aspex records that it received and looked at a copy of a pilot's approval, and when -
// not that it checked the approval is adequate (the operation stays the pilot's). Kept in Aspex's own
// records, against a fingerprint of the approval, so if the pilot changes its dates, type, reference or
// document the record no longer matches and it shows as not sighted again.
const sightSig = (a) => [a.type, a.ref, a.validFrom, a.validTo, a.heightFt, a.docFile].map(x => x || '').join('|');
const sightings = () => { const o = owner(); return o ? store.state('sighted', o.id, {}) : {}; };
const pilotApprovals = (uid, key, job) => { const seen = sightings();
  return Object.entries(store.ops(uid).approvals).filter(([, a]) => store.keysOf(a.aspexJobs).includes(key)).map(([k, a]) => {
    const s = seen[uid + ':' + k];
    return { ...approvalOut(k, a, 'pilot', job), sightedAt: s && s.sig === sightSig(a) ? s.at : '' };
  }); };
const DOC_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
async function sendDoc(res, item) {
  const file = item?.docFile && await db.readFile(item.docFile);
  if (!file) return res.status(404).type('text').send('No document attached.');
  const name = String(item.docName || 'approval').replace(/["\r\n]/g, '');
  res.type(file.mime || DOC_TYPES[name.split('.').pop().toLowerCase()] || 'application/octet-stream')
    .set('Content-Disposition', `inline; filename="${name}"`).send(file.content);
}
const siteOut = (s) => s && { name: s.name, areaHa: s.areaHa, centroid: s.centroid, boundary: s.boundary, airspace: s.airspace };

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
// Safety items, labelled as in the logbook (read from the logbook's own list so the two never differ).
const SAFETY_LABELS = (() => {
  try {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'public', 'aspex.js'), 'utf8');
    const block = src.slice(src.indexOf('const SAFETY = ['), src.indexOf('];', src.indexOf('const SAFETY = [')));
    return Object.fromEntries([...block.matchAll(/\['([a-z]+)',\s*'[^']*',\s*(['"])(.*?)\2\]/g)].map(m => [m[1], m[3]]));
  } catch { return {}; }
})();
// The job details for the call-out email, from the logbook job: everything about the site and the
// job a pilot needs. Never the client, reference, SiteMark link, site owner/O&M or notes.
function calloutDetails(j, site, airspace) {
  const out = [], site1 = [];
  if (site?.centroid) site1.push(`Map: https://www.google.com/maps/search/?api=1&query=${site.centroid[0]},${site.centroid[1]}`);
  if (site?.areaHa) site1.push(`Site area: about ${Math.round(site.areaHa)} ha`);
  if (j.siteContactName || j.siteContactPhone) site1.push(`Site contact: ${[j.siteContactName, j.siteContactPhone].filter(Boolean).join(', ')}`);
  if (site1.length) out.push(site1.join('\n'));
  const docs = [];
  if (j.swmsUrl) docs.push('Site SWMS (please read before the job): ' + j.swmsUrl);
  if (j.dropboxUrl) docs.push('Job folder (Dropbox): ' + j.dropboxUrl);
  if (docs.length) out.push(docs.join('\n'));
  const keys = String(j.safety || '').split('|');
  const safety = keys.map(k => SAFETY_LABELS[k]).filter(Boolean);
  if (safety.length) out.push('Required on site:\n' + safety.map(x => '- ' + x).join('\n'));
  if (keys.includes('powerlines'))
    out.push('There are overhead power lines on this site. High-voltage lines must never be crossed (over, under or through). Smaller lines: clear them by at least 5 m above the wires unless the site sets a different rule.');
  if (j.safetyNotes) out.push('Safety notes:\n' + j.safetyNotes);
  if (j.capture) out.push('Capture settings:\n' + j.capture);
  if (airspace?.lines?.length) out.push('Airspace (preliminary check from OpenAIP data - confirm with official data and NOTAMs before flying):\n' + airspace.lines.map(x => '- ' + x).join('\n'));
  else if (airspace?.level === 'ok') out.push('Airspace: preliminary check found no issues (OpenAIP data - confirm with official data and NOTAMs before flying).');
  if (j.approvalRequired === '1') out.push('This job needs an airspace approval or permission' + (j.approvalNote ? ': ' + j.approvalNote : '.'));
  out.push('You fly this job as an independent operator, under your own accreditation and procedures. The work isn’t carried out under an Aspex ReOC. The site SWMS applies and must be followed.');
  out.push('If you’re assigned, the job and site boundary map will also be in your Aspex flight logbook under Aspex jobs.');
  return out.join('\n\n');
}

// One job: the logbook job holds everything; its pilot network call-out (the email, replies and
// assigning) is kept in step with it. Linking an older call-out first carries its rate, days etc.
// into the logbook job where the logbook job has none.
const CARRY = [['purpose', 'client'], ['start', 'startDate'], ['end', 'endDate'], ['town', 'location'], ['state', 'state'],
  ['daysNeeded', 'daysNeeded'], ['payNotes', 'payNotes'], ['requirements', 'requirements'], ['respondBy', 'respondBy']];
function syncCallout(uid, key, airspace) {
  let ops = store.ops(uid); let j = ops.jobs[key];
  if (!j) return null;
  let nj = j.networkJobId && db.get('jobs', j.networkJobId);
  if (nj) {
    const back = {};
    for (const [lk, ck] of CARRY) if (!j[lk] && nj[ck]) back[lk] = nj[ck];
    if (Object.keys(back).length) { store.saveOps(uid, { jobs: { [key]: back } }); ops = store.ops(uid); j = ops.jobs[key]; }
  }
  const site = ops.sites[j.siteId];
  const fields = { title: j.name || 'Aspex job', site: site?.name || '', details: calloutDetails(j, site, airspace), logbookJob: key };
  for (const [lk, ck] of CARRY) fields[ck] = j[lk] || '';
  if (nj) nj = db.update('jobs', nj.id, fields) || nj;
  else {
    nj = db.insert('jobs', { ...fields, part: 'any', privateNotes: '', status: 'open' });
    store.saveOps(uid, { jobs: { [key]: { networkJobId: nj.id } } });
  }
  return nj;
}
router.post('/logbook/api/jobs/:key/network-callout', ownerOnly, (req, res) => {
  const key = store.safeKey(req.params.key);
  const as = req.body?.airspace;
  const airspace = as && typeof as === 'object' ? { level: String(as.level || '').slice(0, 10), lines: (Array.isArray(as.lines) ? as.lines : []).slice(0, 20).map(x => String(x).slice(0, 500)) } : null;
  const nj = key && syncCallout(req.lb.id, key, airspace);
  if (!nj) return res.status(404).json({ error: 'Job not found' });
  res.json({ id: nj.id, url: `/jobs/${nj.id}#invite` });
});
router.get('/logbook/api/jobs/:key/network', ownerOnly, async (req, res) => {
  const x = linkedJobs().find(l => l.key === req.params.key);
  if (!x) return res.json({ pilots: [] });
  const ids = assignedPilotIds(x.job.networkJobId);
  const pilots = await Promise.all([...ids].map(async pid => {
    const p = db.get('pilots', pid) || {};
    const u = db.all('lbUsers').find(v => v.pilotId === pid && !v.disabled);
    const fl = u ? matchFlights(u.id, x.job, x.site) : [];
    const chk = u && fl.length ? (await require('./compliance').checkFlights(u.id, fl, aspexApprovalsFor(u))).flights : {};
    return { pilotId: pid, name: p.fullName || '(deleted pilot)', uid: u?.id || '', hasLogbook: !!u, active: !!u?.pwHash,
      progress: u ? (progress(u.id)[x.key] || {}) : {}, flights: fl.map(f => ({ ...flightOut(f), check: chk[f.sha256] || null })),
      approvals: u ? pilotApprovals(u.id, x.key, x.job) : [] };
  }));
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

router.post('/logbook/api/jobs/:key/network-approval/:uid/:akey/sighted', ownerOnly, (req, res) => {
  const x = linkedJobs().find(l => l.key === req.params.key);
  const u = x && db.get('lbUsers', req.params.uid);
  if (!u || !assignedPilotIds(x.job.networkJobId).has(u.pilotId)) return res.status(404).end();
  const d = store.safeKey(req.params.akey) && store.opsDoc(u.id, 'approvals', req.params.akey);
  if (!d || !store.keysOf(d.item.aspexJobs).includes(x.key)) return res.status(404).end();
  const seen = sightings(), id = u.id + ':' + req.params.akey;
  if (req.body?.on) seen[id] = { at: new Date().toISOString(), by: req.lb.email, sig: sightSig(d.item) }; else delete seen[id];
  store.setState('sighted', req.lb.id, seen);
  res.json({ sightedAt: seen[id]?.at || '' });
});
router.get('/logbook/api/jobs/:key/network-approval/:uid/:akey/doc', ownerOnly, (req, res) => {   // a pilot's own approval for the job
  const x = linkedJobs().find(l => l.key === req.params.key);
  const u = x && db.get('lbUsers', req.params.uid);
  if (!u || !assignedPilotIds(x.job.networkJobId).has(u.pilotId)) return res.status(404).end();
  const d = store.safeKey(req.params.akey) && store.opsDoc(u.id, 'approvals', req.params.akey);
  sendDoc(res, d && store.keysOf(d.item.aspexJobs).includes(x.key) ? d.item : null);
});

// Aspex's approvals linked to the Aspex jobs a pilot is on (for checking that pilot's flights).
function aspexApprovalsFor(u) {
  const o = owner(); if (!o) return [];
  const oo = store.ops(o.id), keys = new Set(jobsFor(u).map(j => j.key));
  return Object.entries(oo.approvals).filter(([, a]) => store.keysOf(a.jobs).some(k => keys.has(k))).map(([key, a]) => ({ key, a, ops: oo }));
}
// All the approvals assigned pilots have linked to one of the owner's jobs.
function pilotApprovalsForJob(key) {
  const x = linkedJobs().find(l => l.key === key); if (!x) return [];
  const ids = assignedPilotIds(x.job.networkJobId);
  return db.all('lbUsers').filter(u => ids.has(u.pilotId) && !u.disabled).flatMap(u => pilotApprovals(u.id, key, x.job));
}

// For the admin call-out page: the owner's logbook jobs, which one is linked to this call-out, and
// filling the call-out's details from a logbook job (linking the two at the same time).
function logbookJobsForCallout(networkJobId) {
  const o = owner(); if (!o) return { linkedKey: '', jobs: [] };
  const ops = store.ops(o.id);
  const jobs = Object.entries(ops.jobs).map(([key, j]) => ({ key, name: j.name || key, start: j.start || '', site: ops.sites[j.siteId]?.name || '' }))
    .sort((a, b) => b.start.localeCompare(a.start));
  const linkedKey = (Object.entries(ops.jobs).find(([, j]) => j.networkJobId === networkJobId) || [''])[0];
  return { linkedKey, jobs };
}
function fillCalloutFromLogbook(networkJobId, key) {
  const o = owner(); const ops = o && store.ops(o.id);
  if (!ops || !store.safeKey(key) || !ops.jobs[key]) return false;
  store.saveOps(o.id, { jobs: { [key]: { networkJobId } } });
  return !!syncCallout(o.id, key, null);
}

module.exports = { router, BASIS, jobsFor, sendDoc, pilotApprovalsForJob, aspexApprovalsFor, logbookJobsForCallout, fillCalloutFromLogbook };
