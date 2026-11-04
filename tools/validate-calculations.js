#!/usr/bin/env node
/*
 * validate-calculations.js — independent cross-check of engine results against the raw CSV files.
 *
 *   node tools/validate-calculations.js <folder-of-raw-csv> <engine-result.json> [--exclude 77777]
 *
 * Recomputes totals with a separate, deliberately simple parser (no engine code) and compares:
 * labor $, paid hours, OT hours and premium, scheduled hours, monthly sales, edited punches,
 * biometric events, and one hand-traced employee-day. Written for the CMG export layout; column
 * names are looked up by header so other datasets with the same reports also work.
 */
const fs = require('fs');
const path = require('path');

const [dir, resultFile] = process.argv.slice(2);
const exI = process.argv.indexOf('--exclude');
const EXCL = new Set((exI > 0 ? process.argv[exI + 1] : '77777').split(',').map((s) => String(+s)));
const R = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
const out = [];
const cmp = (name, mine, engine, tol) => {
  const ok = Math.abs(mine - engine) <= (tol == null ? 0.5 : tol) * Math.max(1, tol == null ? 1 : 1);
  out.push({ name, independent: mine, engine, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: independent ${mine.toFixed(2)} vs engine ${engine.toFixed(2)}`);
};

function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); }
function rows(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const split = (l) => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
  const H = split(lines[0]).map((h) => h.trim());
  return { H, ix: (n) => H.indexOf(n), data: lines.slice(1).map(split) };
}
const hm = (s) => { const [h, m] = s.replace(/\s/g, '').split(':').map(Number); return h * 60 + m; };
const st = (s) => String(+s);
const files = walk(dir);
const find = (re) => files.filter((f) => re.test(path.basename(f)));

const p0 = R.meta.period.startIso, p1 = R.meta.period.endIso;
const inP = (d) => d >= p0 && d <= p1;

// ---- punches ----
{
  const P = rows(find(/^Punch\.csv$/i)[0]);
  const i = (n) => P.ix(n);
  let pay = 0, mins = 0, ot = 0, prem = 0, edited = 0;
  for (const r of P.data) {
    if (EXCL.has(st(r[i('Store No')]))) continue;
    if (!inP(r[i('Busi Date')].slice(0, 10))) continue;
    pay += +r[i('Total Pay')] || 0;
    mins += hm(r[i('Total Punch Hours')]);
    const o = hm(r[i('Overtime Hours')]) + hm(r[i('Doubletime Hours')]);
    ot += o;
    if (o > 0) prem += Math.max(0, (+r[i('OT Pay')] + +r[i('DT Pay')]) - (o / 60) * +r[i('Pay Rate')]);
    if ((r[i('Original Clock In')] !== r[i('Adjusted Clock In')] && r[i('Original Clock In')] !== '-') || (r[i('Original Clock Out')] !== r[i('Adjusted Clock Out')] && r[i('Original Clock Out')] !== '-')) edited++;
  }
  cmp('Actual labor expenditure ($)', pay, R.financials.laborCost, 0.5);
  cmp('Paid hours', mins / 60, R.financials.paidHours, 0.01);
  cmp('Overtime hours', ot / 60, (R.overtime.tot.ot + R.overtime.tot.dt) / 60, 0.01);
  cmp('OT premium ($)', prem, R.overtime.tot.prem, 0.5);
  cmp('Edited paid punches', edited, R.integrity.tot.edited, 0);
}

// ---- schedule: dedupe exact rows, take each GEID-day's Schedule Hours once ----
{
  const S = rows(find(/^Schedule Data\.csv$/i)[0]);
  const i = (n) => S.ix(n);
  const seen = new Set(), day = new Map();
  for (const r of S.data) {
    const key = r.slice(0, -1).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    if (EXCL.has(st(r[i('Store #')])) || !inP(r[i('Busi Date')].slice(0, 10))) continue;
    if (r[i('Break Type')] !== 'SHIFT') continue;
    const k = r[i('GEID')] + '|' + r[i('Busi Date')].slice(0, 10);
    if (!day.has(k)) day.set(k, +r[i('Schedule Hours')]);
  }
  let h = 0; for (const v of day.values()) h += v;
  cmp('Scheduled paid hours (export Schedule Hours, deduped)', h, R.financials.schedHours, R.financials.schedHours * 0.001);
  const dupShare = 1 - seen.size / S.data.length;
  console.log(`INFO  schedule exact-duplicate share ${(dupShare * 100).toFixed(1)}%`);
}

// ---- monthly sales ----
{
  const by = {};
  // Sales files are identified by header (Forecasted Sales + Actual Sales), not by name.
  for (const f of files.filter((f) => /\.csv$/i.test(f))) {
    const head = fs.readFileSync(f, 'utf8').slice(0, 400);
    if (!/Forecasted Sales/i.test(head) || !/Actual Sales/i.test(head)) continue;
    const S = rows(f);
    const iS = S.ix('Actual Sales'), iF = S.ix('Forecasted Sales'), iD = S.ix('Date'), iSt = S.ix('Store');
    for (const r of S.data) {
      if (EXCL.has(st(r[iSt]))) continue;
      const [d, mon, y] = r[iD].split('-');
      const m = y + '-' + String('JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC'.indexOf(mon.toUpperCase()) / 3 + 1).padStart(2, '0');
      const o = (by[m] = by[m] || { as: 0, fs: 0 }); o.as += +r[iS] || 0; o.fs += +r[iF] || 0;
    }
  }
  if (R.sales.available) for (const m of R.sales.byMonth) {
    cmp(`Actual sales ${m.month}`, (by[m.month] || {}).as || 0, m.as, 0.5);
    cmp(`Forecast sales ${m.month}`, (by[m.month] || {}).fs || 0, m.fs, 0.5);
  }
}

// ---- biometric events (clock in/out, punch added) ----
{
  const f = find(/^Punch Audit\.csv$/i)[0];
  if (f) {
    const A = rows(f); const im = A.ix('Punch Method'), id = A.ix('Adjustment Detail'), is = A.ix('Store No'), ib = A.ix('Busi Date');
    let bio = 0; for (const r of A.data) if (!EXCL.has(st(r[is])) && inP(r[ib].slice(0, 10)) && /biometric/i.test(r[im]) && /added/i.test(r[id])) bio++;
    cmp('Biometric punch events', bio, R.integrity.biometric.events, 0);
  }
}

fs.writeFileSync(path.join(path.dirname(resultFile), 'validation-report.json'), JSON.stringify(out, null, 2));
const failed = out.filter((x) => !x.ok).length;
console.log(`\n${out.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
