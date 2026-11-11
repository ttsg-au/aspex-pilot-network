// Inventory: Batteries (with health ratings), Drones, Payloads.
// Shares globals with the main page script ($, esc, num, hrs, all, inv, dateOnly, model, saveField...).

// ---- battery health rules (shown on the page so the reasoning is visible) ----
const DESIGN_MAH = { Mavic3Enterprise: 5000, Mavic3: 5000, Mavic3Pro: 5000 };   // capacity of a new battery, by aircraft
const RULES = {
  capacity: { amber: 85, red: 80 },          // % of new capacity (latest flights)
  imbalance: { amber: 0.10, red: 0.20 },     // V, worst cell spread under load, last 5 flights
  lowCell: { amber: 3.4, red: 3.2 },         // V, lowest cell seen, last 5 flights
  temp: { amber: 60, red: 65 },              // °C, hottest seen, last 5 flights
  fixedAfter: 5,                             // flights with identical capacity before we call the gauge unreliable
  cycles: { amber: 150, red: 200 },          // charge cycles the battery reports (DJI's warranty covers 200 cycles / 12 months)
  idleDays: 90,                              // not used for this long: do a full charge-and-discharge
};
const cyclesOf = fl => { const c = fl.map(f => f.batteryCycles).filter(Number.isFinite); return c.length ? Math.max(...c) : null; };
const daysSince = s => s ? Math.floor((Date.now() - new Date(s.replace(' ', 'T'))) / 864e5) : null;
const RANK = { none: -1, green: 0, grey: 1, amber: 2, red: 3 };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

function batteryHealth(fl) {
  const l = fl.slice().sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  const recent = l.slice(-5), out = { level: 'green', reasons: [], checks: {} };
  const bump = (lvl, text) => { out.reasons.push({ lvl, text }); if (RANK[lvl] > RANK[out.level]) out.level = lvl; };
  if (!l.length) return { level: 'none', reasons: [{ lvl: 'none', text: 'No flights in this logbook yet.' }], checks: {} };

  // capacity
  const caps = l.map(f => f.batteryFullMah).filter(Boolean);
  const design = DESIGN_MAH[l[l.length - 1].aircraftModel];
  const fixed = caps.length >= RULES.fixedAfter && caps.every(c => c === caps[0]);
  out.caps = caps; out.design = design; out.fixed = fixed;
  if (fixed) {
    bump('grey', `<b>Gauge not reporting:</b> exactly ${num(caps[0])} mAh on all ${caps.length} flights, so its real capacity is unknown.`);
  } else if (caps.length && design) {
    const now = median(caps.slice(-3)), then = median(caps.slice(0, 3)), pct = now / design * 100;
    out.checks.capacityPct = pct;
    const trend = then && caps.length >= 6 ? ` (was ${num(then / design * 100, 0)}% when first logged)` : '';
    if (pct < RULES.capacity.red) bump('red', `<b>Capacity ${num(pct, 0)}%</b> of a new battery (${num(now)} of ${num(design)} mAh)${trend}. Below 80% is the usual point to retire a battery — expect noticeably shorter flights and earlier low-battery warnings.`);
    else if (pct < RULES.capacity.amber) bump('amber', `<b>Capacity ${num(pct, 0)}%</b> of a new battery (${num(now)} of ${num(design)} mAh)${trend}. Losing capacity — plan to replace it before it falls below 80%.`);
    else out.reasons.push({ lvl: 'green', text: `Capacity ${num(pct, 0)}% of a new battery (${num(now)} mAh)${trend}.` });
  } else if (caps.length) {
    out.reasons.push({ lvl: 'green', text: `Reports ${num(median(caps.slice(-3)))} mAh (no new-battery figure for this aircraft yet).` });
  }

  // cell balance under load
  const dev = Math.max(...recent.map(f => f.maxCellDevV || 0));
  out.checks.dev = dev;
  if (dev >= RULES.imbalance.red) bump('red', `<b>Cell imbalance ${num(dev, 2)} V</b> in a recent flight. One cell is sagging well below the others under load — a sign of a weak or failing cell. Don't use it for long or demanding flights until it's checked.`);
  else if (dev >= RULES.imbalance.amber) bump('amber', `<b>Cell imbalance ${num(dev, 2)} V</b> in a recent flight (healthy batteries in your fleet stay under about 0.09 V). Watch it; balance-charge and re-check.`);

  // lowest cell voltage
  const minV = Math.min(...recent.map(f => f.minCellV ?? 9));
  if (minV < 9) {
    out.checks.minV = minV;
    if (minV < RULES.lowCell.red) bump('red', `<b>A cell dropped to ${num(minV, 2)} V.</b> That deep a discharge damages lithium cells.`);
    else if (minV < RULES.lowCell.amber) bump('amber', `<b>A cell dropped to ${num(minV, 2)} V</b> — flown quite flat recently. Land with more in reserve.`);
  }

  // temperature
  const maxT = Math.max(...recent.map(f => f.maxBatteryTempC ?? -99));
  if (maxT > -99) {
    out.checks.maxT = maxT;
    if (maxT >= RULES.temp.red) bump('red', `<b>Reached ${num(maxT, 0)} °C</b> in a recent flight. Running that hot shortens battery life and can indicate internal resistance build-up.`);
    else if (maxT >= RULES.temp.amber) bump('amber', `<b>Reached ${num(maxT, 0)} °C</b> in a recent flight — on the hot side.`);
  }

  // charge cycles
  const cyc = cyclesOf(l);
  out.cycles = cyc;
  if (cyc != null) {
    if (cyc >= RULES.cycles.red) bump('red', `<b>${cyc} charge cycles.</b> Past the ${RULES.cycles.red} cycles DJI's warranty covers; DJI's app warns from here. Expect shorter flights - plan to replace it.`);
    else if (cyc >= RULES.cycles.amber) bump('amber', `<b>${cyc} charge cycles</b> - getting towards ${RULES.cycles.red}. Budget for a replacement.`);
  }
  // sitting unused
  const idle = daysSince(l[l.length - 1].startLocal);
  out.idle = idle;
  if (idle >= RULES.idleDays) out.reasons.push({ lvl: 'info', text: `<b>Not flown for ${idle} days.</b> Give it a full charge, fly or discharge it down, then return it to storage charge - lithium batteries should be cycled at least every 3 months.` });

  if (out.level === 'green' && !out.reasons.some(r => r.lvl !== 'green' && r.lvl !== 'info')) out.reasons.push({ lvl: 'green', text: 'Cell balance, voltage and temperature all normal.' });
  out.last = l[l.length - 1].startLocal; out.first = l[0].startLocal;
  return out;
}

function sparkline(caps, design) {
  if (!caps || caps.length < 2) return '';
  const w = 110, h = 26, lo = Math.min(...caps, design ? design * 0.75 : Infinity), hi = Math.max(...caps, design || 0);
  const x = i => (i / (caps.length - 1)) * (w - 2) + 1, y = v => h - 2 - ((v - lo) / ((hi - lo) || 1)) * (h - 4);
  const pts = caps.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ');
  const ref = design ? `<line x1="0" x2="${w}" y1="${y(design * 0.8).toFixed(1)}" y2="${y(design * 0.8).toFixed(1)}" stroke="#d0392b" stroke-dasharray="2 2" stroke-width="1"/>` : '';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="capacity trend">${ref}<polyline points="${pts}" fill="none" stroke="#0f6e5a" stroke-width="1.5"/></svg>`;
}

const LEVEL_LABEL = { green: 'Good', amber: 'Watch', red: 'Replace / check', grey: 'Gauge not reporting', none: 'Not flown yet' };
let invView = 'batteries';
function renderInventory() {
  document.querySelectorAll('nav.subtabs button').forEach(b => b.classList.toggle('on', b.dataset.iv === invView));
  for (const v of ['batteries', 'drones', 'payloads']) $('#iv-' + v).hidden = v !== invView;
  if (invView === 'batteries') renderBatteries(); else if (invView === 'drones') renderDrones(); else renderPayloads();
}
document.querySelectorAll('nav.subtabs button').forEach(b => b.onclick = () => { invView = b.dataset.iv; renderInventory(); });
const opts = (list, v) => list.map(o => `<option${o === v ? ' selected' : ''}>${o}</option>`).join('');
const flightsOf = (key, sn) => all.filter(f => f.isFlight && f[key] === sn).sort((a, b) => a.startLocal.localeCompare(b.startLocal));
const bindSave = root => root.querySelectorAll('[data-f]').forEach(el => el.onchange = () => saveField(el));

const SOURCES = ['Unknown', 'Genuine DJI', 'Non-genuine'];
// Genuine vs non-genuine: how long each kind lasted, on the evidence in this logbook
function sourceCompare(rows) {
  const groups = SOURCES.map(src => ({ src, r: rows.filter(x => (x.b.source || 'Unknown') === src) })).filter(g => g.r.length);
  if (groups.length < 2 && groups[0]?.src === 'Unknown') return '';
  const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const line = ({ src, r }) => {
    const flown = r.filter(x => x.fl.length);
    const caps = flown.filter(x => !x.h.fixed && x.h.caps?.length && x.h.design).map(x => median(x.h.caps.slice(-3)) / x.h.design * 100);
    const bad = r.filter(x => x.b.status === 'Retired' || ['red', 'grey'].includes(x.h.level)).length;
    const f = avg(flown.map(x => x.fl.length)), h = avg(flown.map(x => x.fl.reduce((s, y) => s + (y.durationMin || 0), 0)));
    return `<tr><td><b>${src}</b></td><td class="n">${r.length}</td><td class="n">${r.filter(x => x.b.status === 'Retired').length}</td>
      <td class="n">${f == null ? '–' : f.toFixed(0)}</td><td class="n">${h == null ? '–' : hrs(h)}</td>
      <td class="n">${caps.length ? avg(caps).toFixed(0) + '%' : '<span class="muted">not measurable</span>'}</td>
      <td class="n">${bad} of ${r.length}</td></tr>`;
  };
  return `<div class="panel" style="margin-top:12px"><h2>Genuine vs non-genuine <span class="hint">set each battery's Source in the table below</span></h2>
    <div class="scroll" style="max-height:none"><table>
      <tr><th>Source</th><th class="n">Batteries</th><th class="n">Retired</th><th class="n">Flights each (avg)</th><th class="n">Hours each (avg)</th><th class="n">Capacity now (avg)</th><th class="n">Retired, red or gauge not reporting</th></tr>
      ${groups.map(line).join('')}</table></div>
    <div class="note">Averages count only batteries that appear in imported flights. Flights flown before this logbook started aren't counted, so older batteries look younger than they are.</div></div>`;
}

// Storage and care: what's due, plus DJI's handling basics.
function storagePanel(rows) {
  const live = rows.filter(r => r.b.status !== 'Retired' && r.fl.length);
  const idle = live.filter(r => r.h.idle >= RULES.idleDays).sort((a, b) => b.h.idle - a.h.idle);
  const old = live.filter(r => r.h.cycles >= RULES.cycles.amber).sort((a, b) => b.h.cycles - a.h.cycles);
  const label = r => `<b>${esc(r.b.code || r.sn)}</b>`;
  return `<div class="panel" style="margin-top:12px"><h2>Storage and cycles <span class="hint">what needs doing now</span></h2>
    <div class="legend">
      <div><h5>Needs a full cycle - ${idle.length}</h5>${idle.length ? idle.map(r => `${label(r)} ${r.h.idle} days`).join(' · ') : 'None - everything has been used in the last 3 months.'}</div>
      <div><h5>High cycle count - ${old.length}</h5>${old.length ? old.map(r => `${label(r)} ${r.h.cycles}`).join(' · ') : `None at ${RULES.cycles.amber}+ cycles.`}</div>
      <div><h5>Storage basics</h5>Charge within a couple of days of flying. Store at 40-60% (storage charge) and let the battery's auto self-discharge do the rest. Keep cool and dry; don't store full or flat for long. Cycle every 3 months.</div>
      <div><h5>Cycle counts</h5>Read from the battery itself in each flight record. A cycle is roughly one full discharge, so two half flights = one cycle.</div>
    </div></div>`;
}

function renderBatteries() {
  const rows = Object.entries(inv.batteries).map(([sn, b]) => { const fl = flightsOf('batterySn', sn); return { sn, b, fl, h: batteryHealth(fl) }; });
  const count = lvl => rows.filter(r => r.b.status !== 'Retired' && r.h.level === lvl).length;
  const gaugeAlso = rows.filter(r => r.b.status !== 'Retired' && r.h.fixed && r.h.level !== 'grey').length;
  rows.sort((x, y) => (x.b.status === 'Retired') - (y.b.status === 'Retired') || (x.h.level === 'none') - (y.h.level === 'none') || RANK[y.h.level] - RANK[x.h.level] ||
    (x.b.code || 'zzz' + x.sn).localeCompare(y.b.code || 'zzz' + y.sn, undefined, { numeric: true }));
  // most recent record of any kind (a motor start with no take-off still records the battery's serial)
  const latest = all.filter(f => f.batterySn && f.startLocal).sort((a, b) => b.startLocal.localeCompare(a.startLocal))[0];
  const lr = latest && rows.find(r => r.sn === latest.batterySn);
  const recentRecs = all.filter(f => f.batterySn && f.startLocal).sort((a, b) => b.startLocal.localeCompare(a.startLocal)).slice(0, 8);
  $('#iv-batteries').innerHTML = `
    <div class="panel" style="margin-bottom:12px"><h2>Identify a battery <span class="hint">which physical battery is this?</span>
      <button class="btn sm" id="idImport">Import flights</button></h2>
      <div style="display:flex;gap:28px;align-items:center;padding:12px 14px;flex-wrap:wrap">
        ${latest ? `<div><div class="muted" style="font-size:12px">Battery in the most recent flight or motor start · ${esc(latest.startLocal)}${latest.isFlight ? '' : ' (no take-off)'}</div>
          <div style="font-family:var(--mono);font-size:28px;font-weight:600;letter-spacing:.5px">${esc(latest.batterySn)}</div>
          <div style="font-size:14px;margin-top:2px">${lr ? `<span class="hdot ${lr.h.level === 'none' ? 'grey' : lr.h.level}"></span>${LEVEL_LABEL[lr.h.level]}` : ''}
            ${batCode(latest.batterySn) ? ` · code <b>${esc(batCode(latest.batterySn))}</b>` : ' · <span class="muted">no code yet — type it below</span>'}</div></div>
          <div style="flex:0 0 auto">${lr && !lr.b.code ? `<input class="c" style="width:120px;font-size:15px" id="idCode" placeholder="give it a code">` : ''}</div>` : '<div class="muted">No records yet.</div>'}
        ${recentRecs.length > 1 ? `<table style="width:auto;font-size:13px"><tr><th colspan="4">Recent flights and motor starts, newest first</th></tr>
          ${recentRecs.map(f => { const r = rows.find(x => x.sn === f.batterySn); return `<tr><td>${esc(f.startLocal.slice(5, 16).replace('T', ' '))}</td>
            <td style="font-family:var(--mono)">${esc(f.batterySn)}</td><td><b>${esc(batCode(f.batterySn) || '—')}</b></td>
            <td>${f.isFlight ? 'flight' : '<span class="muted">no take-off</span>'}</td></tr>`; }).join('')}</table>` : ''}
        <ol class="muted" style="font-size:12.5px;margin:0;padding-left:18px;max-width:520px">
          <li>Put <b>one</b> battery in the drone and mark it (sticker or texta) so you know which is which.</li>
          <li>Make the controller log it: <b>either</b> a short, low hover, <b>or</b> with the <b>propellers off</b>, start the motors for ~5 s and stop them. Just powering on is not enough — DJI only writes a record once the motors start.</li>
          <li>Repeat for each battery, then plug the controller into the drone PC and double-click <b>Import Flights</b>. Each battery appears in the list above, newest first.</li>
        </ol>
      </div></div>
    <div class="panel"><h2>Battery health <span class="hint">worked out from the flight logs · the worst check decides the colour</span></h2>
      <div class="legend">
        <div><h5><span class="hdot green"></span>Good — ${count('green')}</h5>Capacity, cell balance, voltage and temperature all within normal limits.</div>
        <div><h5><span class="hdot amber"></span>Watch — ${count('amber')}</h5>Losing capacity, cells drifting apart, or running hot/flat. Still usable; keep an eye on it.</div>
        <div><h5><span class="hdot red"></span>Replace / check — ${count('red')}</h5>Below 80% capacity, a badly imbalanced cell, or abused. Retire or have it checked before relying on it.</div>
        <div><h5><span class="hdot grey"></span>Gauge not reporting — ${count('grey')}${gaugeAlso ? ` <span class="muted" style="font-weight:400">(+${gaugeAlso} also rated amber/red)</span>` : ''}</h5>Reports exactly the same capacity every flight. A genuine DJI battery's reading changes slightly each flight, so its real capacity can't be measured — consistent with a non-standard battery management chip. The other checks still apply.</div>
      </div>
      <div class="rules"><details><summary>The rules used</summary><table>
        <tr><th>Check</th><th>Amber</th><th>Red</th><th>Based on</th></tr>
        <tr><td>Capacity vs a new battery (${Object.values(DESIGN_MAH)[0]} mAh for Mavic 3 batteries)</td><td>under ${RULES.capacity.amber}%</td><td>under ${RULES.capacity.red}%</td><td>median of the last 3 flights</td></tr>
        <tr><td>Cell imbalance under load</td><td>${RULES.imbalance.amber} V or more</td><td>${RULES.imbalance.red} V or more</td><td>worst of the last 5 flights</td></tr>
        <tr><td>Lowest cell voltage</td><td>under ${RULES.lowCell.amber} V</td><td>under ${RULES.lowCell.red} V</td><td>last 5 flights</td></tr>
        <tr><td>Peak battery temperature</td><td>${RULES.temp.amber} °C or more</td><td>${RULES.temp.red} °C or more</td><td>last 5 flights</td></tr>
        <tr><td>Gauge not reporting</td><td colspan="2">identical capacity on ${RULES.fixedAfter}+ flights</td><td>all flights</td></tr>
        <tr><td>Charge cycles (reported by the battery)</td><td>${RULES.cycles.amber} or more</td><td>${RULES.cycles.red} or more</td><td>latest flight</td></tr>
        <tr><td>Not flown (shown under Storage, doesn't change the colour)</td><td colspan="2">${RULES.idleDays} days or more</td><td>last flight</td></tr>
      </table></details></div>
    </div>
    ${storagePanel(rows)}
    ${sourceCompare(rows)}
    <div class="panel" style="margin-top:12px"><h2>Batteries <span class="hint">give each battery its code · status is your own call; health is worked out</span></h2>
      <div style="display:flex;gap:8px;align-items:center;padding:10px 14px;flex-wrap:wrap;border-bottom:1px solid var(--line,#e5e5e5)">
        <b style="font-size:13px">Add a battery</b>
        <input class="c" id="addSn" placeholder="serial (from the battery or DJI app)" style="width:250px;font-family:var(--mono)">
        <input class="c" id="addCode" placeholder="code e.g. M3-20" style="width:120px">
        <select id="addSrc">${opts(SOURCES, 'Genuine DJI')}</select>
        <button class="btn sm" id="addBat">Add</button>
        <span class="muted" style="font-size:12px">New batteries also appear by themselves after their first imported flight.</span>
      </div>
      <div class="scroll" style="max-height:none"><table>
        <tr><th>Health</th><th>Code</th><th>Source</th><th>Serial</th><th>Why</th><th>Capacity trend</th><th class="n">Cycles</th><th class="n">Flights</th><th class="n">Hours</th><th>Last used</th><th>Status</th><th style="width:18%">Notes</th></tr>
        ${rows.map(({ sn, b, fl, h }) => `<tr class="${b.status === 'Retired' ? 'retired' : ''}" data-kind="batteries" data-sn="${esc(sn)}">
          <td style="white-space:nowrap">${h.level === 'none' ? '<span class="muted">' + LEVEL_LABEL.none + '</span>' : `<span class="hdot ${h.level}"></span>${LEVEL_LABEL[h.level]}`}</td>
          <td><input class="c" data-f="code" value="${esc(b.code)}" placeholder="M3-?"></td>
          <td><select data-f="source" class="src-${(b.source || 'Unknown').replace(/\W/g, '')}">${opts(SOURCES, b.source || 'Unknown')}</select></td>
          <td class="sn">${esc(sn)}</td>
          <td class="why">${h.reasons.filter(r => r.lvl !== 'green' || h.level === 'green').map(r => r.text).join('<br>')}</td>
          <td>${h.fixed ? '<span class="muted">flat — not measured</span>' : sparkline(h.caps, h.design)}</td>
          <td class="n">${h.cycles ?? '<span class="muted">–</span>'}</td><td class="n">${fl.length}</td><td class="n">${hrs(fl.reduce((s, f) => s + (f.durationMin || 0), 0))}</td><td>${dateOnly(h.last)}${h.idle != null && h.idle >= 30 ? `<span class="sn-sub">${h.idle} days ago</span>` : ''}</td>
          <td><select data-f="status">${opts(BAT_STATUS, b.status || 'In service')}</select></td>
          <td><input class="notes" data-f="notes" value="${esc(b.notes)}"></td></tr>`).join('')}
      </table></div>
      <div class="note">The red dashed line on each trend is 80% of a new battery. Batteries with no flights in this logbook yet (e.g. the Phantom, Mavic Mini and Skydio batteries) are listed at the bottom and get a rating once they fly.</div>
    </div>`;
  bindSave($('#iv-batteries'));
  $('#idImport').onclick = () => $('#importBtn').click();
  $('#addBat').onclick = async () => {
    const sn = $('#addSn').value.trim().toUpperCase().replace(/\s+/g, ''), code = $('#addCode').value.trim(), source = $('#addSrc').value;
    if (!/^[A-Z0-9]{6,30}$/.test(sn)) return toast('Serial should be 6-30 letters and numbers');
    if (inv.batteries[sn]) return toast(`${sn} is already listed${inv.batteries[sn].code ? ' as ' + inv.batteries[sn].code : ''}`);
    const clash = code && Object.entries(inv.batteries).find(([, b]) => (b.code || '').toLowerCase() === code.toLowerCase());
    if (clash) return toast(`${code} is already used by ${clash[0]}`);
    try {
      const r = await fetch('api/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batteries: { [sn]: { code, source, status: 'In service', notes: '' } } }) });
      if (!r.ok) throw new Error(r.status);
      inv = await r.json(); toast('Battery added'); renderInventory();
    } catch { toast('Could not save - is the logbook window still open?'); }
  };
  $('#idCode')?.addEventListener('change', async e => {
    const v = e.target.value.trim(); if (!v) return;
    const fake = { value: v, dataset: { f: 'code' }, closest: () => ({ dataset: { kind: 'batteries', sn: latest.batterySn } }) };
    await saveField(fake); renderInventory();
  });
}

function renderDrones() {
  const acs = Object.entries(inv.aircraft);
  $('#iv-drones').innerHTML = `<div class="panel"><h2>Drones <span class="hint">new drones appear here automatically the first time they fly</span></h2>
    <div class="scroll" style="max-height:none"><table>
      <tr><th>Code / name</th><th>Model</th><th>Serial</th><th>CASA registration</th><th>Rego expiry</th><th>Status</th><th>Maintenance</th><th class="n">Flights</th><th class="n">Hours</th><th>First flown</th><th>Last flown</th><th>Controllers seen</th><th style="width:26%">Notes</th></tr>
      ${acs.map(([sn, a]) => {
        const fl = flightsOf('aircraftSn', sn), rcs = [...new Set(fl.map(f => f.rcSn).filter(Boolean))];
        return `<tr class="${a.status === 'Retired' ? 'retired' : ''}" data-kind="aircraft" data-sn="${esc(sn)}">
          <td><input class="c" data-f="code" value="${esc(a.code)}" placeholder="e.g. Aspex 007"></td>
          <td>${esc(model(a.model || fl[0]?.aircraftModel))}${a.appName ? `<span class="sn-sub">${esc(a.appName)}</span>` : ''}</td><td class="sn">${esc(sn)}</td>
          <td><input class="r" data-f="registration" value="${esc(a.registration)}" placeholder="RPA rego"></td>
          <td><input type="date" data-f="regoExpiry" value="${esc(a.regoExpiry || '')}" style="font:inherit;padding:3px"></td>
          <td><select data-f="status">${opts(AC_STATUS, a.status || 'In service')}</select></td>
          <td style="white-space:nowrap">${fl.length ? dueBadge(sn) : ''} <button class="btn sm ghost" data-maint="${esc(sn)}">Log / view</button></td>
          <td class="n">${fl.length}</td><td class="n">${hrs(fl.reduce((s, f) => s + (f.durationMin || 0), 0))}</td><td>${dateOnly(fl[0]?.startLocal)}</td><td>${dateOnly(fl[fl.length - 1]?.startLocal)}</td>
          <td class="sn" style="font-size:11.5px">${rcs.map(esc).join('<br>') || '–'}</td>
          <td><input class="notes" data-f="notes" value="${esc(a.notes)}"></td></tr>`;
      }).join('') || '<tr><td class="empty">No drones yet</td></tr>'}
    </table></div></div><div id="maintBox"></div>`;
  bindSave($('#iv-drones'));
  $('#iv-drones').querySelectorAll('[data-maint]').forEach(b => b.onclick = () => { renderMaint(b.dataset.maint); $('#maintBox').scrollIntoView({ behavior: 'smooth' }); });
  if (maintSn) renderMaint(maintSn);
}

const PAYLOAD_TYPES = ['Integrated camera', 'Thermal camera', 'RGB camera', 'Multispectral', 'LiDAR', 'Zoom camera', 'Other'];
function renderPayloads() {
  const pl = Object.entries(inv.payloads || {});
  $('#iv-payloads').innerHTML = `<div class="panel"><h2>Payloads <span class="hint">cameras are picked up from the flight logs automatically</span></h2>
    <div class="scroll" style="max-height:none"><table>
      <tr><th>Code / name</th><th>Type</th><th>Serial</th><th>Fitted to</th><th>Status</th><th class="n">Flights</th><th class="n">Hours</th><th class="n">Photos</th><th>Last used</th><th style="width:26%">Notes</th></tr>
      ${pl.map(([sn, p]) => {
        const fl = flightsOf('cameraSn', sn), acs = [...new Set(fl.map(f => acCode(f.aircraftSn) || model(f.aircraftModel)))];
        return `<tr data-kind="payloads" data-sn="${esc(sn)}">
          <td><input class="c" style="width:130px" data-f="code" value="${esc(p.code)}" placeholder="e.g. 3T camera"></td>
          <td><select data-f="type">${opts(PAYLOAD_TYPES, p.type || 'Integrated camera')}</select></td><td class="sn">${esc(sn)}</td>
          <td>${acs.map(esc).join(', ') || '–'}</td>
          <td><select data-f="status">${opts(AC_STATUS, p.status || 'In service')}</select></td>
          <td class="n">${fl.length}</td><td class="n">${hrs(fl.reduce((s, f) => s + (f.durationMin || 0), 0))}</td>
          <td class="n">${num(fl.reduce((s, f) => s + (f.photos || 0), 0))}</td><td>${dateOnly(fl[fl.length - 1]?.startLocal)}</td>
          <td><input class="notes" data-f="notes" value="${esc(p.notes)}"></td></tr>`;
      }).join('') || '<tr><td class="empty">No payloads yet</td></tr>'}
    </table></div>
    <div class="note">On the Mavic 3T the wide, zoom and thermal cameras are one integrated gimbal with a single serial number.</div></div>`;
  bindSave($('#iv-payloads'));
}
