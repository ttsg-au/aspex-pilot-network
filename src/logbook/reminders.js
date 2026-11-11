// Weekly reminder email for each logbook account (you and each network pilot):
// licences and paperwork expiring, drones due for inspection, batteries needing attention.
// Sent on Monday morning (Sydney time), only when something is due. Checked hourly, so a
// restart doesn't skip a week; a record per person stops it sending twice.
const config = require('../config');
const db = require('../db');
const mail = require('../mail');
const store = require('./store');

const DESIGN_MAH = { Mavic3Enterprise: 5000, Mavic3: 5000, Mavic3Pro: 5000 };
const sydney = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour) % 24, date: `${p.year}-${p.month}-${p.day}` };
};
const daysTo = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(sydney().date + 'T00:00:00Z')) / 864e5);
const fmt = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

function expiry(list, label, iso, warnDays = 60) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  const d = daysTo(iso);
  if (d < 0) list.push({ level: 'red', text: `${label} expired on ${fmt(iso)}.` });
  else if (d <= warnDays) list.push({ level: d <= 14 ? 'red' : 'amber', text: `${label} expires ${d === 0 ? 'today' : `in ${d} days`} (${fmt(iso)}).` });
}

// Everything due for one person.
function itemsFor(u) {
  const out = { paperwork: [], drones: [], batteries: [] };
  const prof = u.profile || {};
  expiry(out.paperwork, 'Your RePL', prof.replExpiry);
  expiry(out.paperwork, 'Your insurance', prof.insuranceExpiry);

  const flights = store.flights(u.id).filter(f => f.isFlight);
  const inv = store.inventory(u.id), ops = store.ops(u.id);
  for (const [sn, a] of Object.entries(inv.aircraft)) {
    if (a.status === 'Retired') continue;
    const name = a.code || a.model || sn;
    expiry(out.drones, `${name} registration`, a.regoExpiry);
    const mine = flights.filter(f => f.aircraftSn === sn);
    if (!mine.length) continue;
    const hours = mine.reduce((s, f) => s + (f.durationMin || 0), 0) / 60;
    const every = Number(a.inspectEveryH) || 50;
    const last = Object.values(ops.maint || {}).filter(m => m.sn === sn && /inspection/i.test(m.type)).sort((x, y) => (y.date || '').localeCompare(x.date || ''))[0];
    const since = hours - (last ? Number(last.hoursAt) || 0 : 0), left = every - since;
    if (left < 0) out.drones.push({ level: 'red', text: `${name}: inspection overdue by ${(-left).toFixed(1)} flight hours (every ${every} h).` });
    else if (left <= 5) out.drones.push({ level: 'amber', text: `${name}: inspection due in ${left.toFixed(1)} flight hours.` });
  }

  const idleList = [];
  for (const [sn, b] of Object.entries(inv.batteries)) {
    if (b.status === 'Retired') continue;
    const fl = flights.filter(f => f.batterySn === sn).sort((x, y) => x.startLocal.localeCompare(y.startLocal));
    if (!fl.length) continue;
    const name = b.code || sn, notes = [];
    let level = 'amber';
    const cyc = Math.max(...fl.map(f => f.batteryCycles).filter(Number.isFinite), -1);
    if (cyc >= 200) { notes.push(`${cyc} charge cycles - plan to replace`); level = 'red'; } else if (cyc >= 150) notes.push(`${cyc} charge cycles`);
    const caps = fl.map(f => f.batteryFullMah).filter(Boolean), design = DESIGN_MAH[fl[fl.length - 1].aircraftModel];
    const fixed = caps.length >= 5 && caps.every(c => c === caps[0]);
    if (design && caps.length && !fixed) { const pct = median(caps.slice(-3)) / design * 100; if (pct < 80) { notes.push(`capacity down to ${Math.round(pct)}% of new`); level = 'red'; } }
    const idle = Math.floor((Date.now() - Date.parse(fl[fl.length - 1].startLocal.replace(' ', 'T') + '+10:00')) / 864e5);
    if (notes.length) out.batteries.push({ level, text: `${name}: ${notes.join('; ')}.` });
    if (idle >= 90) idleList.push(`${name} (${idle} days)`);
  }
  // one line for all the batteries that have been sitting unused
  if (idleList.length) out.batteries.push({ level: 'amber', text: `Not flown for 3+ months - give each a full charge and discharge, then back to storage charge: ${idleList.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ')}.` });
  out.batteries.sort((a, b) => (a.level === 'red' ? 0 : 1) - (b.level === 'red' ? 0 : 1));
  return out;
}
const count = (it) => it.paperwork.length + it.drones.length + it.batteries.length;

async function sendTo(u, { force = false } = {}) {
  const it = itemsFor(u);
  if (!count(it) && !force) return { sent: false, items: it };
  const sec = (title, list) => list.length ? `**${title}**\n${list.map(x => `${x.level === 'red' ? '🔴' : '🟠'} ${x.text}`).join('\n')}\n\n` : '';
  const first = (u.profile?.fullName || u.name || '').split(' ')[0] || 'there';
  const text = count(it)
    ? `Hi ${first},\n\nHere's what's coming up in your flight logbook:\n\n${sec('Licences and paperwork', it.paperwork)}${sec('Drones', it.drones)}${sec('Batteries', it.batteries)}You get this email on Mondays when something is due. You can turn it off on the Me tab in your logbook.`
    : `Hi ${first},\n\nNothing is due in your flight logbook right now. This is a test of your weekly reminder email.`;
  await mail.send({ to: u.email, subject: count(it) ? `Flight logbook: ${count(it)} thing${count(it) === 1 ? '' : 's'} need${count(it) === 1 ? 's' : ''} attention` : 'Flight logbook reminders (test)',
    text, buttons: [{ label: 'Open my logbook', url: `${config.baseUrl}/logbook/`, primary: true }] });
  return { sent: true, items: it };
}

// Monday from 8 am Sydney time, once per person per week.
async function weeklyCheck() {
  const now = sydney();
  if (now.weekday !== 'Mon' || now.hour < 8) return;
  for (const u of db.all('lbUsers')) {
    if (u.disabled || !u.pwHash || u.profile?.remindersOff) continue;
    if (u.remindersSentFor === now.date) continue;
    try {
      const r = await sendTo(u);
      db.update('lbUsers', u.id, { remindersSentFor: now.date, remindersLast: r.sent ? new Date().toISOString() : u.remindersLast });
    } catch (e) { console.error('Logbook reminder email to', u.email, 'failed:', e.message); }
  }
}
function start() {
  setTimeout(() => weeklyCheck().catch(() => {}), 60e3);
  setInterval(() => weeklyCheck().catch(() => {}), 60 * 60e3).unref?.();
}

module.exports = { itemsFor, sendTo, start };
