#!/usr/bin/env node
/*
 * test-behavior.js — validation of employee behaviour patterns and dollar attribution.
 *
 *   node tools/test-behavior.js datasets/<dataset>.zip
 *
 * Part 1 builds a small synthetic dataset in memory (known answers) and runs it through the real pipeline:
 *   consecutive working days across days off, a run broken by a day with no data, PIN punches not counted
 *   as manual, and early clock-in dollars = minutes × rate.
 * Part 2 checks the real dataset: the top manual-punch pattern recomputed from raw punches, cost
 *   reconciliation (parts = total, Σ stores = Σ employees = org), and patterns recalculated for a filter.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.self = global;
global.fflate = require(path.join(ROOT, 'lib', 'fflate.min.js'));
for (const f of require(path.join(ROOT, 'js', 'engine', 'files.json'))) require(path.join(ROOT, 'js', 'engine', f));
const LCI = global.LCI, U = LCI.util;

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? '  — ' + detail : ''}`); };
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);

// ---------- Part 1: synthetic dataset ----------
function synthetic() {
  const iso = (d) => U.isoDay(d);
  const start = U.dayNum(2026, 5, 4); // a Monday
  const P = ['Payroll Start Date,Payroll End Date,Busi Date,Day,Store No,Geid,First Name,Last Name,Age,Timecard,Minor Type,Job Code,Payroll ID,Original Clock In,Original Clock Out,Source Id,Adjusted Clock In,Adjusted Clock Out,Pay Rate,OT Payrate,DT Payrate,Regular Hours,Overtime Hours,Doubletime Hours,Total Break Hours,Total Punch Hours,Normal Pay,OT Pay,DT Pay,Total Pay,CC Tips,Total Tips,S No.'];
  const Sc = ['Busi Date,Store #,GEID,First Name,Last Name,Timecard,Job Code Desc,Is Minor,Start Time,End Time,Schedule Hours,Break Type,S No.'];
  let n = 0;
  const punch = (day, g, name, src, inT, outT, rate) => {
    const [h1, m1] = inT.split(':').map(Number), [h2, m2] = outT.split(':').map(Number);
    const mins = h2 * 60 + m2 - (h1 * 60 + m1);
    const hm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    const d = iso(day);
    P.push([`${iso(start)} 00:00:00`, `${iso(start + 13)} 00:00:00`, `${d} 00:00:00`, 'X', '00999', g, name, 'Sample', 30, g, 'No', 'Team Member', 'P' + g,
      `${d} ${inT}:00`, `${d} ${outT}:00`, src, `${d} ${inT}:00`, `${d} ${outT}:00`, rate, rate * 1.5, rate, hm, '00:00', '00:00', '00:00', hm, (mins / 60) * rate, 0, 0, (mins / 60) * rate, 0, 0, ++n].join(','));
  };
  const sched = (day, g, name) => Sc.push([`${iso(day)} 00:00:00`, '00999', g, name, 'Sample', g, 'Job Deployment', 'No', '09:00', '17:00', 8, 'SHIFT', ++n].join(','));
  // 12 calendar days. Day index 6 has NO data for anyone (data gap). A: works every day except the gap,
  // 20 calendar days; day 15 has NO data for anyone (data gap).
  //   Alpha  works every day with data, manual every time → runs of 15 and 4 (broken by the gap): occ 19, longest 15.
  //   Bravo  has days off on 2, 5 and 9 (others worked those days), manual every working day → the days off do not
  //          break the run: days 0–14 minus 3 days off = 12, then the gap, then 4: occ 16, longest 12.
  //   Charlie PIN/clock punches clocking in 20 min early every day → not manual; early-in $ = 19 × 20 min × $18/h.
  const daysOff = new Set([2, 5, 9]);
  for (let i = 0; i < 20; i++) {
    const day = start + i;
    if (i === 15) continue; // no data at all this day
    sched(day, '1001', 'Alpha'); punch(day, '1001', 'Alpha', 'MANUAL', '09:00', '17:00', 15);
    if (!daysOff.has(i)) { sched(day, '1002', 'Bravo'); punch(day, '1002', 'Bravo', 'MANUAL', '09:00', '17:00', 15); }
    sched(day, '1003', 'Charlie'); punch(day, '1003', 'Charlie', 'CLOCK_TIMECARD', '08:40', '17:00', 18);
  }
  return { punch: P.join('\n') + '\n', schedule: Sc.join('\n') + '\n' };
}

async function main() {
  const syn = synthetic();
  const ing0 = new LCI.Ingestor({});
  for (const [name, text] of [['Punch.csv', syn.punch], ['Schedule Data.csv', syn.schedule]]) { const tc = LCI.pipeline.textConsumer(ing0, name); tc.push(new TextEncoder().encode(text)); tc.end(); }
  const { result: S, ctx: SC } = LCI.pipeline.analyse(ing0, { name: 'synthetic' }, null);
  const pat = (g, cat) => S.behavior.patterns.find((p) => p.g === g && p.cat === cat);
  const a = pat('1001', 'manual');
  check('Synthetic: a day with no data breaks the working-day run', a && a.streak === 15 && a.occ === 19, a ? `occ ${a.occ}, longest run ${a.streak} (${a.streakFrom} – ${a.streakTo})` : 'not detected');
  const b = pat('1002', 'manual');
  check('Synthetic: days off are skipped — they neither break nor extend a run', b && b.streak === 12 && b.occ === 16 && b.calStreak === 5, b ? `occ ${b.occ}, longest working-day run ${b.streak}, longest calendar run ${b.calStreak}` : 'not detected');
  check('Synthetic: PIN / clock punches are not manual', !pat('1003', 'manual') && SC.ADH.byEmp['1003'].manN === 0, `Charlie manual punches: ${SC.ADH.byEmp['1003'].manN}`);
  const c = pat('1003', 'early');
  check('Synthetic: recurring early clock-in detected with its $ (minutes × rate)', c && c.occ === 19 && near(c.cost, 19 * (20 / 60) * 18), c ? `${c.occ} days, $${c.cost.toFixed(2)} = 19 × 20 min × $18/h` : 'not detected');

  // ---------- Part 2: real dataset ----------
  const zip = process.argv[2];
  const cfg = { name: 'test', excludeStores: ['77777'] };
  const ing = new LCI.Ingestor(cfg);
  async function* chunks() { for await (const ch of fs.createReadStream(zip, { highWaterMark: 1 << 20 })) yield new Uint8Array(ch.buffer, ch.byteOffset, ch.length); }
  await LCI.pipeline.readZip(chunks(), ing, null);
  const { result: R, ctx } = LCI.pipeline.analyse(ing, cfg, null);
  const M = ctx.M, B = R.behavior;

  // Top manual pattern recomputed from raw punches.
  const top = B.patterns.filter((p) => p.cat === 'manual').sort((x, y) => y.occ - x.occ)[0];
  const mine = M.punches.filter((p) => p.g === top.g);
  const work = [...new Set(mine.map((p) => p.day))].sort((x, y) => x - y);
  const manDays = new Set(mine.filter((p) => p.src === 'MANUAL').map((p) => p.day));
  const dataDays = new Set(M.punches.map((p) => p.day));
  let run = 0, best = 0, prev = null;
  for (const d of work) {
    if (prev != null) for (let x = prev + 1; x < d; x++) if (!dataDays.has(x)) { run = 0; break; }
    run = manDays.has(d) ? run + 1 : 0; best = Math.max(best, run); prev = d;
  }
  check('Real data: top manual-punch pattern matches an independent recount from raw punches', top.occ === manDays.size && top.workDays === work.length && top.streak === best,
    `${top.name} (GEID ${top.g}): ${top.occ} of ${top.workDays} working days, run ${top.streak} — recount ${manDays.size} of ${work.length}, run ${best}`);
  check('Real data: manual patterns use Source Id MANUAL only (no PIN punches)', B.patterns.filter((p) => p.cat === 'manual').every((p) => (ctx.ADH.byEmp[p.g] || {}).manN > 0), `${B.summary.manual.emps} employees`);

  // Cost reconciliation (no double counting).
  const F = R.financials;
  const partsSum = U.sum(F.parts.map((p) => p.cost));
  check('Cost attribution: category parts add up to the additional labor cost', near(partsSum, F.grossAddCost, 0.5), `${partsSum.toFixed(2)} vs ${F.grossAddCost.toFixed(2)}`);
  check('Cost attribution: overtime counted once (premium only)', near(F.parts.find((p) => p.k === 'ot').cost, R.overtime.tot.prem, 0.01), `${R.overtime.tot.prem.toFixed(2)}`);
  check('Cost attribution: Σ stores = organization additional cost', near(U.sum(R.stores.map((s) => s.grossAdd)) - U.sum(Object.values(ctx.OT.byStore).map((o) => o.prem)) + R.overtime.tot.prem, F.grossAddCost, 1), '');
  const empAdh = U.sum(R.employees.map((e) => e.cEarly + e.cLate + e.cUnsch + e.cMeal));
  check('Cost attribution: Σ employees (early+late+unscheduled+meals) = organization', near(empAdh, F.grossAddCost - R.overtime.tot.prem, 1), `${empAdh.toFixed(2)}`);
  check('Cost attribution: avoidable never exceeds additional', R.employees.every((e) => e.avoid <= e.grossAdd + 0.01) && F.avoidCost <= F.grossAddCost, '');
  check('Lenses are not added: manual-punch $ ≤ additional cost', F.lenses.every((l) => l.cost <= F.grossAddCost), F.lenses.map((l) => `${l.k} ${l.cost.toFixed(0)}`).join(', '));
  const d0 = ctx.ADH.days.find((d) => d.early > 30 && isFinite(d.rate));
  check('Early clock-in $ on an employee-day = minutes × that day\'s rate', near(d0.cEarly, (d0.early / 60) * d0.rate, 1e-6), `${d0.early} min × $${d0.rate.toFixed(2)}/h = $${d0.cEarly.toFixed(2)}`);

  // Patterns recalculated for a filter.
  const f = { from: U.dayNum(2026, 9, 1), to: U.dayNum(2026, 9, 30) };
  const o = LCI.pipeline.analyseFiltered(ctx.M0, cfg, f, ctx.R);
  const pf = o.result.behavior.patterns;
  // Day-based patterns must lie inside Sep 1–30; overtime is weekly, so its weeks must overlap the range.
  const inRange = (p) => (p.cat === 'overtime' ? p.lastDay >= f.from && p.lastDay <= f.to && p.first >= '2026-09-01' : p.lastDay >= f.from && p.lastDay <= f.to && p.first >= '2026-09-01');
  for (const p of pf.filter((x) => !inRange(x)).slice(0, 4)) console.log('   out of range:', p.cat, p.g, p.first, U.isoDay(p.lastDay), (p.cats || []).join('+'));
  check('Filter Sep 1–30: patterns are recalculated inside the range', pf.length > 0 && pf.every(inRange) && pf.length !== B.patterns.length, `${pf.length} patterns (full period ${B.patterns.length})`);
  const st = R.stores.slice().sort((x, y) => y.grossAdd - x.grossAdd)[0].s;
  const o2 = LCI.pipeline.analyseFiltered(ctx.M0, cfg, { stores: [st] }, ctx.R);
  check(`Filter store ${st}: every pattern belongs to that store's records`, o2.result.behavior.patterns.every((p) => o2.ctx.M.punches.some((q) => q.g === p.g)), `${o2.result.behavior.patterns.length} patterns`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
