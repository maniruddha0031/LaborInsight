#!/usr/bin/env node
/*
 * run-analysis.js — run the browser analysis engine from the command line (same code, no UI).
 *
 *   node tools/run-analysis.js <dataset.zip | folder-of-csv> [--out result.json] [--exclude 77777]
 *
 * Used for calculation validation and regression testing (see docs/TESTING.md).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.self = global;
global.fflate = require(path.join(ROOT, 'lib', 'fflate.min.js'));
const ENGINE = require(path.join(ROOT, 'js', 'engine', 'files.json'));
for (const f of ENGINE) require(path.join(ROOT, 'js', 'engine', f));
const LCI = global.LCI;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

async function ingestFolder(dir, ing) {
  for (const f of walk(dir).filter((p) => /\.(csv|txt|tsv)$/i.test(p)).sort()) {
    const tc = LCI.pipeline.textConsumer(ing, path.relative(dir, f).replace(/\\/g, '/'));
    for await (const chunk of fs.createReadStream(f, { highWaterMark: 1 << 20 })) tc.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
    tc.end();
    process.stderr.write('.');
  }
  process.stderr.write('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const src = args[0];
  if (!src) { console.error('usage: run-analysis.js <zip|folder> [--out file] [--exclude id,id] [--quiet]'); process.exit(2); }
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const cfg = { name: path.basename(src), excludeStores: (opt('--exclude') || '').split(',').filter(Boolean) };
  const t0 = Date.now();
  const ing = new LCI.Ingestor(cfg);
  if (fs.statSync(src).isDirectory()) await ingestFolder(src, ing);
  else {
    const total = fs.statSync(src).size;
    let last = 0;
    async function* chunks() { for await (const c of fs.createReadStream(src, { highWaterMark: 1 << 20 })) yield new Uint8Array(c.buffer, c.byteOffset, c.length); }
    await LCI.pipeline.readZip(chunks(), ing, ({ bytes, file }) => { const p = Math.floor((bytes / total) * 20); if (p > last) { last = p; process.stderr.write(`\r${(bytes / total * 100).toFixed(0)}% ${file}            `); } });
    process.stderr.write('\n');
  }
  const t1 = Date.now();
  const { result, ctx } = LCI.pipeline.analyse(ing, cfg, ({ msg }) => process.stderr.write('  ' + msg + '\n'));
  const t2 = Date.now();
  const out = opt('--out');
  if (out) fs.writeFileSync(out, JSON.stringify(result));
  console.error(`ingest ${((t1 - t0) / 1000).toFixed(1)}s, analyse ${((t2 - t1) / 1000).toFixed(1)}s, result ${(JSON.stringify(result).length / 1e6).toFixed(1)} MB`);
  if (!args.includes('--quiet')) {
    const F = ctx.F;
    const $ = (v) => '$' + Math.round(v).toLocaleString();
    const h = (m) => (m / 60).toFixed(0) + 'h';
    console.log('period', ctx.M.period.startIso, '→', ctx.M.period.endIso, 'months', ctx.M.months.map((m) => m.key + (m.partial ? '*' : '')).join(' '));
    console.log('excluded', ctx.M.excluded, 'stores', ctx.stores.length, 'employees', ctx.employees.length);
    console.log('labor', $(F.laborCost), 'paid', F.paidHours.toFixed(0) + 'h', 'sched', F.schedHours.toFixed(0) + 'h');
    for (const k in F.add) console.log('  add', k, h(F.add[k].min), $(F.add[k].cost));
    console.log('  OT premium', $(F.otPremium), 'sched', $(F.otPremiumSched), 'drift', $(F.otPremiumDrift));
    console.log('gross', $(F.grossAddCost), 'avoid', $(F.avoidCost), (F.avoidPct * 100).toFixed(2) + '%', 'runrate/mo', $(F.avoidRunRate));
    console.log('offsets', Object.fromEntries(Object.entries(F.offsets).map(([k, v]) => [k, h(v)])));
    console.log('edits added', h(F.editsAddedMin), $(F.editsAddedCost));
    console.log('insights', result.insights.length);
    for (const i of result.insights) console.log(' -', i.severity, '|', i.confidence, '|', i.title, '|', i.impact && i.impact.label);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
