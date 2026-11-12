#!/usr/bin/env node
/*
 * test-focus.js — finding-specific drill-downs reconcile with the findings.
 *
 *   node tools/test-focus.js datasets/<dataset>.zip
 *
 * For every lens: Σ stores = the organization figure the finding reports; Σ employees in the top store =
 * the store figure; an employee drill-down holds only that employee's records of that lens at that store.
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
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1 : tol);

async function main() {
  const zip = process.argv[2];
  const cfg = { name: 'test', excludeStores: ['77777'] };
  const ing = new LCI.Ingestor(cfg);
  async function* chunks() { for await (const ch of fs.createReadStream(zip, { highWaterMark: 1 << 20 })) yield new Uint8Array(ch.buffer, ch.byteOffset, ch.length); }
  await LCI.pipeline.readZip(chunks(), ing, null);
  const { result: R, ctx } = LCI.pipeline.analyse(ing, cfg, null);
  const F = R.financials, t = ctx.ADH.tot;
  const org = {
    overplan: F.overPlan.cost, unsch: t.cUnsch, early: t.cEarly, late: t.cLate, meal: t.cMealSkip, ot: R.overtime.tot.prem,
    manual: F.manual.extraCost, edits: F.edits.netCost, avoid: F.avoidCost, labor: F.laborCost,
  };
  const q = (x) => LCI.present.query(ctx, Object.assign({ type: 'focus' }, x));

  check('Every finding carries a drill lens', R.insights.every((i) => i.lens && LCI.focus.LENS[i.lens]), R.insights.map((i) => `${i.id}→${i.lens}`).slice(0, 6).join(', ') + ' …');

  for (const lens of Object.keys(org)) {
    const o = q({ lens });
    const sumStores = U.sum(o.stores.map((s) => s.cost));
    check(`[${lens}] Σ stores = organization figure`, near(sumStores, org[lens], Math.max(1, org[lens] * 1e-9)), `${sumStores.toFixed(2)} vs ${org[lens].toFixed(2)} across ${o.stores.length} stores`);
    check(`[${lens}] drill-down headline = organization figure`, near(o.summary.cost, org[lens], Math.max(1, org[lens] * 1e-9)), `${o.summary.cost.toFixed(2)} vs ${org[lens].toFixed(2)}`);
    const top = o.stores[0];
    if (!top) continue;
    const st = q({ lens, s: top.s });
    const sumEmps = U.sum(st.employees.map((e) => e.cost));
    if (lens === 'overplan') check(`[${lens}] store ${top.name}: employee contributions (before netting) ≥ netted store figure`, sumEmps + 1 >= st.summary.cost, `${sumEmps.toFixed(0)} ≥ ${st.summary.cost.toFixed(0)}`);
    else check(`[${lens}] store ${top.name}: Σ employees = store figure`, near(sumEmps, st.summary.cost), `${sumEmps.toFixed(2)} vs ${st.summary.cost.toFixed(2)} (${st.employees.length} employees)`);
    const e0 = st.employees[0];
    if (!e0) continue;
    const em = q({ lens, s: top.s, g: e0.g });
    const onlyHere = em.records.every((r) => r.g === e0.g && r.s === top.s);
    check(`[${lens}] employee ${e0.g} at ${top.name}: only this finding's records for this employee and store`, onlyHere && em.records.length === e0.n && near(em.summary.cost, e0.cost, 0.01), `${em.records.length} records, $${em.summary.cost.toFixed(2)}`);
  }

  // Records are of the lens type only (spot checks).
  const lateRecs = LCI.focus.records(ctx, 'late', null, null);
  check('[late] every record is a late clock-out', lateRecs.length > 0 && lateRecs.every((r) => r.min > 0 && /after the scheduled end/.test(r.issue)), `${lateRecs.length} records`);
  const manRecs = LCI.focus.records(ctx, 'manual', null, null);
  check('[manual] records = days with MANUAL-source punches', manRecs.length === ctx.ADH.days.filter((d) => d.manN > 0 && d.nP > 0).length, `${manRecs.length} days`);
  const edRecs = LCI.focus.records(ctx, 'edits', null, null);
  check('[edits] records = edited paid punches (original vs adjusted)', edRecs.length === ctx.INT.editedList.length && edRecs.every((r) => r.adjIn !== undefined), `${edRecs.length} edits`);
  const mealRecs = LCI.focus.records(ctx, 'meal', null, null);
  check('[meal] every record is a worked-through meal or a missing meal break', mealRecs.every((r) => /meal/i.test(r.issue)), `${mealRecs.length} records`);

  // Explore entry (lens given directly, no finding) returns the same figures as the finding entry.
  for (const [lens, fid] of [['manual', 'manual-time'], ['ot', 'overtime'], ['overplan', 'over-plan']]) {
    const a = q({ lens }), b = LCI.focus.query(ctx, { type: 'focus', finding: fid });
    check(`[${lens}] Explore entry = finding entry`, near(a.summary.cost, b.summary.cost, 0.01) && a.stores.length === b.stores.length, `$${a.summary.cost.toFixed(2)} vs $${b.summary.cost.toFixed(2)}`);
  }
  // Lens extras are summed from the same records.
  const topOt = q({ lens: 'ot' }).stores[0], otS = q({ lens: 'ot', s: topOt.s });
  check('[ot] store: planned + past-schedule premium = recorded OT premium', near(otS.extras.premSched + otS.extras.premDrift, otS.summary.cost, 1), `${otS.extras.premSched.toFixed(2)} + ${otS.extras.premDrift.toFixed(2)} vs ${otS.summary.cost.toFixed(2)}`);
  const topMan = q({ lens: 'manual' }).stores[0], manS = q({ lens: 'manual', s: topMan.s });
  const x = manS.extras;
  check('[manual] store: clock-in / clock-out / both days ≤ manual days ≤ working days', x.inOnly + x.outOnly + x.both <= x.days && x.days <= x.workDays && x.days === manS.recordsTotal && x.punches >= x.days, JSON.stringify(x));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
