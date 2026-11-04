#!/usr/bin/env node
/*
 * test-filters.js — scenario tests for store / date-range filtering of the analysis engine.
 *
 *   node tools/test-filters.js datasets/<dataset>.zip [--exclude 77777]
 *
 * Verifies that a filtered analysis only uses records inside the selected scope, that insights are
 * regenerated for it, that monthly sales are never prorated for partial months, and that the portable
 * (packed) model gives exactly the same results as the original.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.self = global;
global.fflate = require(path.join(ROOT, 'lib', 'fflate.min.js'));
for (const f of require(path.join(ROOT, 'js', 'engine', 'files.json'))) require(path.join(ROOT, 'js', 'engine', f));
const LCI = global.LCI, U = LCI.util;

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: String(detail == null ? '' : detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? '  — ' + detail : ''}`); };
const day = (iso) => U.dayNum(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10));

async function main() {
  const zip = process.argv[2];
  const exI = process.argv.indexOf('--exclude');
  const cfg = { name: 'test', excludeStores: exI > 0 ? process.argv[exI + 1].split(',') : ['77777'] };
  const ing = new LCI.Ingestor(cfg);
  async function* chunks() { for await (const c of fs.createReadStream(zip, { highWaterMark: 1 << 20 })) yield new Uint8Array(c.buffer, c.byteOffset, c.length); }
  await LCI.pipeline.readZip(chunks(), ing, null);
  const { result: B, ctx } = LCI.pipeline.analyse(ing, cfg, null);
  const M0 = ctx.M0, R0 = ctx.R;
  const run = (f) => { const t = Date.now(); const o = LCI.pipeline.analyseFiltered(M0, cfg, f, R0); o.ms = Date.now() - t; return o; };
  const inside = (list, f, stores) => list.every((r) => r.day >= f.from && r.day <= f.to && (!stores || stores.has(r.s)));

  // 1. Organization, full period = base
  const o1 = run({});
  check('Organization · full period equals the base analysis', Math.abs(o1.result.financials.laborCost - B.financials.laborCost) < 0.01 && Math.abs(o1.result.financials.avoidCost - B.financials.avoidCost) < 0.01 && o1.result.insights.length === B.insights.length,
    `labor ${o1.result.financials.laborCost.toFixed(2)} · avoidable ${o1.result.financials.avoidCost.toFixed(2)} · ${o1.result.insights.length} findings · ${o1.ms} ms`);

  // 2. Organization, one full month
  const f2 = { from: day('2026-09-01'), to: day('2026-09-30') };
  const o2 = run(f2);
  const M2 = o2.ctx.M;
  check('Sep 1–30: every record set lies inside the range', ['schedule', 'punches', 'approvals', 'breaks', 'auditManual', 'auditEdits', 'violations', 'excPunch'].every((k) => inside(M2[k], f2)), `${M2.punches.length} punches · ${o2.ms} ms`);
  check('Sep 1–30: labor $ equals the sum of September punch pay', Math.abs(o2.result.financials.laborCost - U.sum(M0.punches.filter((p) => p.day >= f2.from && p.day <= f2.to).map((p) => p.pay || 0))) < 0.01, o2.result.financials.laborCost.toFixed(2));
  check('Sep 1–30: months, trends and Labor % use September only', o2.result.meta.months.length === 1 && o2.result.trends.series.length === 1 && JSON.stringify(o2.result.sales.salesMonths) === '["2026-09"]', JSON.stringify(o2.result.sales.salesMonths));
  check('Sep 1–30: insights regenerated (different from full period)', o2.result.insights.length > 0 && JSON.stringify(o2.result.insights.map((i) => i.title)) !== JSON.stringify(B.insights.map((i) => i.title)), `${o2.result.insights.length} findings`);
  const sepSales = U.sum(M0.sales.filter((a) => a.month === '2026-09').map((a) => a.as));
  check('Sep 1–30: actual sales = September monthly sales (not prorated)', Math.abs(o2.result.sales.tot.as - sepSales) < 0.5, o2.result.sales.tot.as.toFixed(2));
  const lr = o2.result.sales.laborRank;
  check('Labor % ranking sorted highest → lowest', lr.rows.every((r, i) => i === 0 || lr.rows[i - 1].laborPct >= r.laborPct), `${lr.rows.length} ranked · highest ${(lr.highest.laborPct * 100).toFixed(1)}% · lowest ${(lr.lowest.laborPct * 100).toFixed(1)}% · org ${(lr.orgPct * 100).toFixed(1)}%`);
  check('Labor % ranking has a previous comparable period (Aug)', JSON.stringify(lr.prevMonths) === '["2026-08"]' && lr.rows.some((r) => r.change != null), JSON.stringify(lr.prevMonths));
  const r0 = lr.rows[0];
  const recompute = U.sum(o2.ctx.SAL.table.filter((x) => x.s === r0.s).map((x) => x.pay)) / U.sum(o2.ctx.SAL.table.filter((x) => x.s === r0.s).map((x) => x.as));
  check('Labor % of top store = its punch pay ÷ its sales', Math.abs(recompute - r0.laborPct) < 1e-9, (r0.laborPct * 100).toFixed(2) + '%');

  // 3. Single store
  const store = B.stores.slice().sort((a, b) => b.avoid - a.avoid)[0].s;
  const o3 = run({ stores: [store] });
  const M3 = o3.ctx.M, S3 = new Set([store]);
  check(`Store ${store}: every record set belongs to that store`, ['schedule', 'punches', 'approvals', 'breaks', 'auditManual', 'auditEdits', 'violations', 'excPunch'].every((k) => inside(M3[k], { from: M0.period.start, to: M0.period.end }, S3)), `${M3.punches.length} punches · ${o3.ms} ms`);
  check(`Store ${store}: store table has only that store`, o3.result.stores.length === 1 && o3.result.stores[0].s === store, o3.result.stores.map((s) => s.s).join(','));
  check(`Store ${store}: labor $ equals that store's punch pay`, Math.abs(o3.result.financials.laborCost - U.sum(M0.punches.filter((p) => p.s === store).map((p) => p.pay || 0))) < 0.01, o3.result.financials.laborCost.toFixed(2));
  check(`Store ${store}: employees all worked at that store`, o3.result.employees.length > 0 && o3.result.employees.every((e) => M3.punches.some((p) => p.g === e.g) || M3.schedule.some((r) => r.g === e.g)), `${o3.result.employees.length} employees`);
  // A store view counts only that store's punches. It can differ slightly from the store's row in the org view:
  // employees who worked at two stores on one day are filed under one store there, each employee's median rate is
  // taken over the store's punches only, and weekly OT is attributed to the store worked most that week.
  const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
  // Measure the cause: employee-days at this store where the same GEID also punched or was scheduled elsewhere.
  const here = new Set(), elsewhere = new Set();
  for (const r of M0.punches.concat(M0.schedule)) { const k = r.g + '|' + r.day; if (r.s === store) here.add(k); else elsewhere.add(k); }
  const shared = [...here].filter((k) => elsewhere.has(k)).length;
  check(`Store ${store}: store view within 2% of its org-level row; differences come from shared employee-days`, rel(o3.ctx.ADH.tot.cAvoid, ctx.ADH.byStore[store].cAvoid) < 0.02 && rel(o3.ctx.ADH.tot.overPlan, ctx.ADH.byStore[store].overPlan) < 0.02 && (shared > 0 || rel(o3.ctx.ADH.tot.overPlan, ctx.ADH.byStore[store].overPlan) < 1e-9),
    `avoidable ${o3.ctx.ADH.tot.cAvoid.toFixed(2)} vs ${ctx.ADH.byStore[store].cAvoid.toFixed(2)} · above-plan min ${o3.ctx.ADH.tot.overPlan.toFixed(0)} vs ${ctx.ADH.byStore[store].overPlan.toFixed(0)} · ${shared} employee-days shared with another store`);
  check(`Store ${store}: insights generated for the store`, o3.result.insights.length > 0 && !o3.result.insights.some((i) => i.id === 'labor-rank' || i.id === 'persistent'), `${o3.result.insights.length} findings`);

  // 4. Partial months: no complete month → sales unavailable with an explanation
  const o4 = run({ from: day('2026-09-10'), to: day('2026-10-20') });
  check('Sep 10–Oct 20: sales / Labor % not calculated (no complete month)', o4.result.sales.available === false && /prorat/i.test(o4.result.sales.reason), o4.result.sales.reason.slice(0, 90));
  check('Sep 10–Oct 20: hours and punch analysis still run on the selected days', o4.result.financials.paidHours > 0 && inside(o4.ctx.M.punches, { from: day('2026-09-10'), to: day('2026-10-20') }), `${o4.result.financials.paidHours.toFixed(0)} h`);
  const o5 = run({ from: day('2026-08-15'), to: day('2026-10-31') });
  check('Aug 15–Oct 31: sales use Sep + Oct only; Aug reported as partial', JSON.stringify(o5.result.sales.salesMonths) === '["2026-09","2026-10"]' && JSON.stringify(o5.result.sales.partialMonths) === '["2026-08"]', JSON.stringify(o5.result.sales.partialMonths));
  const o6 = run({ from: day('2026-03-02'), to: day('2026-03-31') });
  check('Mar 2–31 counts as a full month (data starts Mar 2)', JSON.stringify(o6.result.sales.salesMonths) === '["2026-03"]', JSON.stringify(o6.result.sales.salesMonths));

  // 5. Manual punches respond to scope
  const manAll = M0.punches.filter((p) => p.src === 'MANUAL');
  check('Manual punches = punches with Source Id MANUAL', B.financials.manual.n === manAll.length && Math.abs(B.financials.manual.min - U.sum(manAll.map((p) => p.tot || 0))) < 1e-6, `${manAll.length} punches · ${(B.financials.manual.min / 60).toFixed(0)} h · ${new Set(manAll.map((p) => p.g)).size} employees`);
  check('Manual punches in Sep = September MANUAL punches', o2.result.financials.manual.n === manAll.filter((p) => p.day >= f2.from && p.day <= f2.to).length, o2.result.financials.manual.n);
  check(`Manual punches at store ${store} = its MANUAL punches`, o3.result.financials.manual.n === manAll.filter((p) => p.s === store).length, o3.result.financials.manual.n);
  check('Manual-punch avoidable is inside the avoidable total', B.financials.manual.avoidCost <= B.financials.avoidCost, `${B.financials.manual.avoidCost.toFixed(0)} ≤ ${B.financials.avoidCost.toFixed(0)}`);

  // 6. Packed model round trip
  let t = Date.now();
  const pm = LCI.scope.packModel(M0);
  const tPackOnly = Date.now() - t;
  t = Date.now();
  const M1 = LCI.scope.unpackModel(pm.chunks);
  const tPack = `pack ${tPackOnly} ms, unpack ${Date.now() - t} ms`;
  const a = LCI.pipeline.analyseFiltered(M0, cfg, f2, R0).result, b = LCI.pipeline.analyseFiltered(M1, cfg, f2, R0).result;
  const strip = (r) => JSON.stringify(Object.assign({}, r, { meta: Object.assign({}, r.meta, { generatedAt: 0 }) }));
  check('Packed model gives identical results', strip(a) === strip(b), `${(pm.zBytes / 1048576).toFixed(1)} MiB packed · ${tPack}`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
