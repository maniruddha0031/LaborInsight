#!/usr/bin/env node
/*
 * ui-test.js — end-to-end test of the portal in real headless Chrome (DevTools protocol, no dependencies).
 *
 *   node tools/ui-test.js --chrome "<path to chrome.exe>" [--out <dir for screenshots/report>] [--port 8181]
 *
 * Steps: serve the project → open the page → pick the manifest dataset → Analyze → visit every view →
 * open a finding drill-down, a store and an employee → upload the same ZIP through the file input and
 * re-analyze (checks previous results are cleared) → upload an invalid file and a ZIP with no data files
 * (checks the error states). Fails on any page error or console error.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CHROME = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const OUT = arg('--out', path.join(os.tmpdir(), 'lci-ui-test'));
const PORT = +arg('--port', 8181);
const DBG = PORT + 1;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? '  — ' + detail : ''}`); };

function tinyZip(file, name, text) {
  const raw = Buffer.from(text), data = zlib.deflateRawSync(raw), nb = Buffer.from(name);
  const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(zlib.crc32(raw), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(zlib.crc32(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nb.length, 28);
  const cd = Buffer.concat([c, nb]); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(1, 8); e.writeUInt16LE(1, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(30 + nb.length + data.length, 16);
  fs.writeFileSync(file, Buffer.concat([h, nb, data, cd, e]));
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(PORT)], { env: Object.assign({}, process.env), stdio: 'ignore' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lci-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1440,1000', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) { await sleep(300); try { target = (await (await fetch(`http://127.0.0.1:${DBG}/json`)).json()).find((t) => t.type === 'page'); } catch (e) { /* not up yet */ } }
    if (!target) throw new Error('Chrome did not start');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const wait = new Map(); const errors = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); }
      if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text);
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value || a.description).join(' '));
      if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon|fonts\.g/.test(d.params.entry.url || '')) errors.push(d.params.entry.text + ' ' + (d.params.entry.url || ''));
    };
    const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text); return r.result.result.value; };
    const until = async (expr, ms, step) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (e) { /* page busy */ } await sleep(step || 500); } return false; };
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); };
    await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('DOM.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    // ---- 1. open: the default dataset's pre-computed analysis must show with no click and no upload ----
    const t0 = Date.now();
    await send('Page.navigate', { url: `http://localhost:${PORT}/` });
    const opened = await until(`!!(window.App && App.result && App.snap) && !document.querySelector('#v-overview').hidden && document.querySelectorAll('#v-overview .kpi').length >= 5`, 30000, 250);
    check('Opens on the default dataset analysis automatically (no upload, no Analyze click)', opened, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!opened) throw new Error('snapshot did not open: ' + (await ev(`document.querySelector('#dsMsg').innerText`)));
    check('Dataset dropdown lists the registered dataset', await ev(`document.querySelectorAll('#dsSelect option').length > 1 && document.querySelector('#dsSelect').value !== ''`), await ev(`[...document.querySelectorAll('#dsSelect option')].map(o=>o.textContent).join(' | ')`));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const meta = await ev(`({p:App.result.meta.period, stores:App.result.meta.storeCount, emps:App.result.meta.employeeCount, ins:App.result.insights.length, labor:App.result.financials.laborCost, avoid:App.result.financials.avoidCost, files:App.result.quality.summary})`);
    check('All files recognised', meta.files.recognised === meta.files.files && meta.files.files >= 1, JSON.stringify(meta.files));
    check('Analysis period detected', meta.p.startIso && meta.p.endIso, `${meta.p.startIso} → ${meta.p.endIso}`);
    check('Findings generated', meta.ins > 0, meta.ins);
    fs.writeFileSync(path.join(OUT, 'ui-result-meta.json'), JSON.stringify(meta, null, 2));
    await until(`!document.querySelector('#v-overview').hidden && document.querySelectorAll('#v-overview .kpi').length >= 5`, 10000);
    check('Overview KPIs rendered', await ev(`document.querySelectorAll('#v-overview .kpi').length`) >= 5, await ev(`[...document.querySelectorAll('#v-overview .kpi .kv')].map(x=>x.textContent).join(' | ')`));
    check('Overview charts rendered', await ev(`UI.chartCount() >= 1`), await ev(`UI.chartCount()`));
    await shot('03-overview');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 3000, deviceScaleFactor: 1, mobile: false });
    await sleep(600); await shot('03b-overview-full');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    // ---- 3. every view ----
    const views = await ev(`[...document.querySelectorAll('#nav button')].filter(b=>!b.disabled).map(b=>b.dataset.view)`);
    for (const v of views) {
      if (v === 'dataset') continue;
      const before = errors.length;
      await ev(`App.go(${JSON.stringify(v)})`);
      await sleep(900);
      const ok = await ev(`(()=>{const el=document.querySelector('#v-${v}');return !el.hidden && el.innerText.length>200 && !el.querySelector('.msg.err')})()`);
      check(`View renders: ${v}`, ok && errors.length === before, errors.slice(before).join(' ; ') || (await ev(`document.querySelector('#v-${v} h2') ? document.querySelector('#v-${v} h2').textContent : ''`)));
      await shot('10-' + v);
    }

    // ---- 4. drill-downs ----
    await ev(`App.go('findings')`); await sleep(500);
    await ev(`document.querySelector('#v-findings .fcard .fhead').click()`);
    check('Finding expands with evidence and drill table', await until(`document.querySelector('#v-findings .fcard .fbody:not([hidden]) .drill table tbody tr')`, 15000), await ev(`document.querySelector('#v-findings .fcard .ft').textContent`));
    await shot('20-finding-open');
    const firstStore = await ev(`App.result.stores.slice().sort((a,b)=>b.avoid-a.avoid)[0].s`);
    await ev(`App.go('stores', {s:${JSON.stringify(firstStore)}})`);
    check('Store drill-down loads', await until(`document.querySelector('#v-stores .crumb') && document.querySelectorAll('#v-stores canvas').length>=2 && document.querySelector('#sdE tbody tr')`, 20000), firstStore);
    await shot('21-store');
    const firstEmp = await ev(`App.result.employees.slice().sort((a,b)=>b.avoid-a.avoid)[0].g`);
    await ev(`App.go('employees', {g:${JSON.stringify(firstEmp)}})`);
    check('Employee (GEID) drill-down loads', await until(`document.querySelector('#v-employees .crumb') && document.querySelector('#edD tbody tr')`, 20000), firstEmp);
    await shot('22-employee');
    await ev(`App.go('findings')`); await sleep(400);
    const eff = `(document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))`;
    const before = await ev(eff);
    await ev(`document.querySelector('#themeBtn').click()`);
    const after = await ev(eff);
    await sleep(800); await ev(`App.go('overview')`); await sleep(900); await shot('23-overview-' + after);
    check('Theme toggle switches light/dark', before !== after, `${before} → ${after}`);
    await ev(`document.querySelector('#themeBtn').click()`);
    await sleep(500); await shot('23-overview-' + before);

    // ---- 4a. global filters (enhancement scenarios) ----
    const idle = `!!App.result && document.querySelector('#busy').hidden`;
    const pickPreset = async (k) => { await ev(`(()=>{const s=document.querySelector('#fPreset');s.value=${JSON.stringify(k)};s.dispatchEvent(new Event('change'))})()`); };
    await ev(`App.go('overview')`);
    check('Filter bar visible with active scope and period', await ev(`!document.querySelector('#fbar').hidden && /Organization/.test(document.querySelector('#fActive').innerText)`), await ev(`document.querySelector('#fActive').innerText`));
    // Scenario 1 — Organization, previous month
    const tf1 = Date.now();
    await pickPreset('prev');
    const s1 = await until(`App.isFiltered() && ${idle}`, 180000, 500);
    check('Scenario 1: Organization + previous month recalculates through the engine', s1, `${((Date.now() - tf1) / 1000).toFixed(1)} s (includes loading the data model the first time)`);
    if (s1) {
      const r1 = await ev(`({sc:App.result.meta.scope, stores:App.result.meta.storeCount, months:App.result.meta.months.map(m=>m.key), trend:App.result.trends.series.map(s=>s.month), ins:App.result.insights.length, labor:App.result.financials.laborCost, base:App.base.result.financials.laborCost, lr:App.result.sales.laborRank && App.result.sales.laborRank.rows.map(r=>r.laborPct)})`);
      check('Scenario 1: all stores included, one month only', r1.sc.kind === 'org' && r1.stores === meta.stores && JSON.stringify(r1.months) === JSON.stringify(r1.trend) && r1.months.length === 1, `${r1.stores} stores · ${r1.months.join(',')} · ${r1.ins} findings`);
      check('Scenario 1: KPIs changed from the full period', r1.labor > 0 && r1.labor < r1.base, `labor ${r1.labor.toFixed(0)} vs full ${r1.base.toFixed(0)}`);
      check('Scenario 1: Labor % ranking strictly highest → lowest', r1.lr && r1.lr.length > 3 && r1.lr.every((v, i) => i === 0 || r1.lr[i - 1] >= v), r1.lr ? `${r1.lr.length} stores, ${(r1.lr[0] * 100).toFixed(1)}% → ${(r1.lr[r1.lr.length - 1] * 100).toFixed(1)}%` : 'none');
      await ev(`App.go('laborrank')`); await sleep(600);
      const firstRows = await ev(`[...document.querySelectorAll('#lrT tbody tr')].slice(0,3).map(tr=>tr.children[2].innerText)`);
      check('Scenario 1: Labor % ranking view renders in descending order', firstRows.length === 3 && parseFloat(firstRows[0]) >= parseFloat(firstRows[1]) && parseFloat(firstRows[1]) >= parseFloat(firstRows[2]), firstRows.join(' ≥ '));
      await shot('60-laborrank-sep');
      await ev(`document.querySelector('#lrT tbody tr').click()`);
      check('Scenario 1: clicking a ranked store opens its detail', await until(`document.querySelector('#v-stores .crumb') && document.querySelectorAll('#v-stores canvas').length >= 2`, 20000));
    }
    // Scenario 2 — single store via the picker
    await ev(`App.go('overview')`);
    const pickStore = await ev(`App.base.result.stores.slice().sort((a,b)=>b.avoid-a.avoid)[1].s`);
    await ev(`document.querySelector('#fStoreBtn').click()`); await sleep(300);
    await ev(`(()=>{const q=document.querySelector('#storeQ');q.value=App.base.result.meta.storeNames[${JSON.stringify(pickStore)}];q.dispatchEvent(new Event('input'));const cb=[...document.querySelectorAll('#storeList input')].find(c=>c.value===${JSON.stringify(pickStore)});cb.checked=true;cb.dispatchEvent(new Event('change'));document.querySelector('#storeApply').click()})()`);
    const s2 = await until(`App.result.meta.scope.kind==='store' && ${idle}`, 120000, 400);
    check('Scenario 2: Store view selected through the picker', s2, await ev(`document.querySelector('#fActive').innerText`));
    if (s2) {
      const r2 = await ev(`({st:App.result.stores.map(s=>s.s), emps:App.result.employees.length, months:App.result.meta.months.length, title:document.querySelector('#v-overview h2').innerText, man:App.result.financials.manual.n})`);
      check('Scenario 2: every store-level figure is that store only (and the previous month)', r2.st.length === 1 && r2.st[0] === pickStore && r2.months === 1, `${r2.st.join(',')} · ${r2.emps} employees`);
      check('Scenario 2: heading names the store', /Store/.test(r2.title), r2.title);
      await shot('61-store-overview');
      const before2 = errors.length;
      for (const v of ['findings', 'actions', 'laborrank', 'manual', 'adherence', 'overtime', 'integrity', 'compliance', 'sales', 'stores', 'employees', 'trends']) {
        await ev(`App.go(${JSON.stringify(v)})`); await sleep(500);
        if (v === 'stores') await until(`document.querySelector('#v-stores .crumb')`, 20000);
      }
      check('Scenario 2: all views render for the store without errors', errors.length === before2, errors.slice(before2).join(' ; '));
      check('Scenario 2: Stores view opens the selected store directly', await ev(`App.go('stores'), true`) && await until(`document.querySelector('#v-stores h2') && document.querySelector('#v-stores h2').innerText.includes(App.base.result.meta.storeNames[${JSON.stringify(pickStore)}])`, 20000));
      const eg = await ev(`App.result.employees.slice().sort((a,b)=>b.avoid-a.avoid)[0].g`);
      await ev(`App.go('employees',{g:${JSON.stringify(eg)}})`);
      check('Scenario 2: employee (GEID) drill-down answers inside the store scope', await until(`document.querySelector('#edD tbody tr')`, 20000) && await ev(`[...document.querySelectorAll('#edD tbody tr')].every(tr=>tr.children[2].innerText===App.base.result.meta.storeNames[${JSON.stringify(pickStore)}])`), eg);
      // Scenario 3 — manual punches in scope
      await ev(`App.go('manual')`); await sleep(500);
      check('Scenario 3: manual punch view shows the store\'s manual punches', (await ev(`document.querySelector('#v-manual .kpi .kx').innerText.replace(/,/g,'')`)).startsWith(String(r2.man) + ' manual punches'), `${r2.man} manual punches`);
      await shot('62-store-manual');
    }
    // Scenario 4/5 — custom partial-month range: Labor % withheld, no proration
    await ev(`App.applyFilter({stores:null, from:null, to:null})`); await until(idle, 10000);
    await ev(`(()=>{document.querySelector('#fFrom').value='2026-09-10';document.querySelector('#fFrom').dispatchEvent(new Event('change'));document.querySelector('#fTo').value='2026-10-20';document.querySelector('#fTo').dispatchEvent(new Event('change'));document.querySelector('#fApply').click()})()`);
    const s4 = await until(`App.isFiltered() && App.result.meta.period.startIso==='2026-09-10' && ${idle}`, 180000, 500);
    check('Scenario 4: custom date range (Sep 10 – Oct 20) recalculates', s4, await ev(`App.result && App.result.meta.period.startIso + ' → ' + App.result.meta.period.endIso`));
    if (s4) {
      check('Scenario 5: partial months — sales / Labor % clearly not available (no proration)', await ev(`App.result.sales.available===false && /prorat/i.test(App.result.sales.reason) && /not available/i.test(document.querySelector('#fActive').innerText)`), await ev(`App.result.sales.reason`));
      check('Scenario 5: hours and punch findings still computed for the selected days', await ev(`App.result.financials.paidHours > 0 && App.result.insights.length > 0`), await ev(`App.result.insights.length + ' findings'`));
      await ev(`App.go('laborrank')`); await sleep(500);
      check('Scenario 5: Labor % ranking explains the limitation', await ev(`/prorat/i.test(document.querySelector('#v-laborrank').innerText)`));
      await shot('63-partial-month');
    }
    // Scenario 6 — usability: reset, sortable tables
    await ev(`document.querySelector('#fReset').click()`);
    check('Scenario 6: Reset filters returns to the full organization view instantly', await until(`App.result===App.base.result && ${idle}`, 5000, 200));
    await ev(`App.go('stores')`); await sleep(500);
    const sorted = await ev(`(()=>{const ths=[...document.querySelectorAll('#stT th')];const i=ths.findIndex(t=>/Paid hours/.test(t.innerText));ths[i].click();const v=[...document.querySelectorAll('#stT tbody tr')].slice(0,5).map(tr=>parseFloat(tr.children[i].innerText.replace(/[^0-9.]/g,'')));return v})()`);
    check('Scenario 6: tables sort on header click', sorted.every((v, i) => i === 0 || sorted[i - 1] >= v), sorted.join(' ≥ '));
    // Dollar-centric store ranking: switch the metric and check the order follows it.
    await ev(`App.go('stores')`); await sleep(400);
    const rk = await ev(`(()=>{const s=document.querySelector('#stRank');s.value='otPrem';s.dispatchEvent(new Event('change'));const rows=[...document.querySelectorAll('#stBars .brow')].map(b=>b.querySelector('.bl').innerText.split('\\n')[0].replace(/^\\d+\\. Store /,''));const vals=rows.map(n=>App.result.stores.find(x=>x.name===n).otPrem);return {rows,vals}})()`);
    check('Store ranking switches metric (OT cost) and ranks highest first', rk.vals.length >= 5 && rk.vals.every((v, i) => i === 0 || rk.vals[i - 1] >= v), rk.rows.slice(0, 3).join(', '));
    await shot('64-store-ranking');
    // Employee behaviour section and an employee's pattern panel.
    await ev(`App.go('behavior')`); await sleep(600);
    check('Employee behaviour view lists patterns with $ impact', await ev(`document.querySelectorAll('#bhT tbody tr').length > 5 && /\\$/.test(document.querySelector('#bhT tbody tr').innerText)`), await ev(`document.querySelector('#bhCatNote').innerText`));
    await ev(`(()=>{const c=[...document.querySelectorAll('#bhCats .chip')].find(b=>b.dataset.k==='manual');c&&c.click()})()`); await sleep(300);
    check('Behaviour view switches category (recurring manual punches)', await ev(`[...document.querySelectorAll('#bhT tbody tr')].slice(0,5).every(tr=>/manual/i.test(tr.children[2].innerText))`));
    await shot('65-behavior-manual');
    await ev(`document.querySelector('#bhT tbody tr').click()`);
    check('Employee page shows recurring behaviour patterns', await until(`document.querySelector('#edP tbody tr')`, 20000), await ev(`document.querySelector('#v-employees h2') && document.querySelector('#v-employees h2').innerText`));
    await shot('66-employee-patterns');

    // ---- 4b. re-analyse the registered ZIP in the browser; must reproduce the pre-computed result ----
    await ev(`App.go('dataset')`);
    await shot('01-dataset-screen');
    const tz = Date.now();
    await ev(`document.querySelector('#analyzeBtn').click()`);
    check('Re-analyze shows progress and clears the previous result', await until(`App.result === null && !document.querySelector('#progress').hidden && UI.chartCount() === 0`, 10000), await ev(`document.querySelector('#progMsg').textContent`));
    await sleep(3000); await shot('02-progress');
    const reDone = await until(`!!(App.result && !App.snap)`, 600000, 2000);
    check('Registered ZIP re-analysed through the UI', reDone, `${((Date.now() - tz) / 1000).toFixed(0)} s`);
    if (reDone) {
      const m1 = await ev(`({labor:App.result.financials.laborCost, avoid:App.result.financials.avoidCost, ins:App.result.insights.length})`);
      check('Re-analysis equals the pre-computed analysis', Math.abs(m1.labor - meta.labor) < 0.01 && Math.abs(m1.avoid - meta.avoid) < 0.01 && m1.ins === meta.ins, JSON.stringify(m1) + ' vs ' + JSON.stringify({ labor: meta.labor, avoid: meta.avoid, ins: meta.ins }));
    }

    // ---- 5. upload the ZIP through the file input; previous results must clear ----
    const prevAt = await ev(`App.result.meta.generatedAt`);
    await ev(`App.go('dataset')`);
    const doc = await send('DOM.getDocument', { depth: -1 });
    const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    const zipPath = path.join(ROOT, 'datasets', JSON.parse(fs.readFileSync(path.join(ROOT, 'datasets', 'manifest.json'))).datasets[0].files[0]);
    await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [zipPath] });
    await sleep(500);
    check('Uploaded ZIP selected', await ev(`!!App.file && document.querySelector('#dsSelect').value==='' && !document.querySelector('#analyzeBtn').disabled`), await ev(`App.file && App.file.name`));
    await ev(`document.querySelector('#analyzeBtn').click()`);
    await sleep(1500);
    check('Previous results cleared while new dataset processes', await ev(`App.result === null && document.querySelector('#v-overview').innerHTML === '' && UI.chartCount() === 0 && [...document.querySelectorAll('#nav button')].filter(b=>b.dataset.view!=='dataset').every(b=>b.disabled)`));
    const done2 = await until(`!!(App.result && App.result.meta.generatedAt !== ${JSON.stringify(prevAt)})`, 600000, 2000);
    check('Uploaded ZIP analysed through the same pipeline', done2);
    if (done2) {
      const m2 = await ev(`({labor:App.result.financials.laborCost, avoid:App.result.financials.avoidCost, ins:App.result.insights.length, name:App.result.meta.label})`);
      check('Upload result equals manifest result', Math.abs(m2.labor - meta.labor) < 0.01 && Math.abs(m2.avoid - meta.avoid) < 0.01 && m2.ins === meta.ins, JSON.stringify(m2));
      check('Sidebar shows uploaded dataset name', await ev(`document.querySelector('#srcName').textContent`) === m2.name, m2.name);
    }

    // ---- 6. invalid inputs ----
    const bad = path.join(OUT, 'not-a-zip.zip'); fs.writeFileSync(bad, 'this is not a zip file');
    const empty = path.join(OUT, 'no-data.zip'); tinyZip(empty, 'readme.csv', 'hello,world\n1,2\n');
    for (const [f, expect] of [[bad, /not a ZIP/i], [empty, /No usable punch records/i]]) {
      await ev(`App.go('dataset')`);
      await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [f] });
      await sleep(300);
      await ev(`document.querySelector('#analyzeBtn').click()`);
      const shown = await until(`/could not be analysed/i.test(document.querySelector('#dsMsg').innerText)`, 30000);
      const text = await ev(`document.querySelector('#dsMsg').innerText`);
      check(`Graceful error for ${path.basename(f)}`, shown && expect.test(text) && (await ev(`App.result === null`)), text.slice(0, 160));
      await shot('30-error-' + path.basename(f, '.zip'));
    }
    const wrongExt = path.join(OUT, 'data.csv'); fs.writeFileSync(wrongExt, 'a,b\n');
    await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [wrongExt] });
    await sleep(300);
    check('Non-ZIP upload rejected before processing', /not a \.zip/i.test(await ev(`document.querySelector('#dsMsg').innerText`)));

    // ---- 7. mobile width ----
    await ev(`document.querySelector('#dsSelect').value=document.querySelector('#dsSelect option:nth-child(2)').value; document.querySelector('#dsSelect').dispatchEvent(new Event('change'))`);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    check('No horizontal page scroll at phone width', await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), await ev(`document.documentElement.scrollWidth + ' / ' + window.innerWidth`));
    await shot('40-mobile-landing');

    // ---- 8. opened straight from disk (file://): the pre-computed analysis and drill-downs must still work ----
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const fileUrl = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^%2F/, '').replace(/^([A-Za-z])%3A/, '$1:');
    const tf = Date.now();
    await send('Page.navigate', { url: fileUrl });
    const fOpen = await until(`!!(window.App && App.result && App.snap) && document.querySelectorAll('#v-overview .kpi').length >= 5`, 30000, 250);
    check('Opened from disk (file://): analysis shows automatically', fOpen, `${((Date.now() - tf) / 1000).toFixed(1)} s`);
    if (fOpen) {
      const g2 = await ev(`App.result.employees[5].g`);
      await ev(`App.go('employees', {g:${JSON.stringify(g2)}})`);
      check('Opened from disk: employee day-by-day drill-down works', await until(`document.querySelector('#edD tbody tr') && !document.querySelector('#v-employees .msg.err')`, 15000), g2);
      await shot('50-file-mode-employee');
      const sF = await ev(`App.base.result.stores[3].s`);
      await ev(`App.applyFilter({stores:[${JSON.stringify(sF)}], from:null, to:null})`);
      check('Opened from disk: store filter works (engine runs from the bundle)', await until(`App.result && App.result.meta.scope.kind==='store' && document.querySelector('#busy').hidden`, 180000, 500), await ev(`App.result && App.result.meta.scope.storeLabel`));
      await shot('51-file-mode-store-filter');
    }

    check('No uncaught page errors or console errors', errors.length === 0, errors.slice(0, 5).join(' ; '));
  } catch (e) {
    check('Test run completed', false, e.stack || e.message);
  } finally {
    try { ws && ws.close(); } catch (e) { /* ignore */ }
    // Kill the whole Chrome process tree (on Windows .kill() only stops the parent; renderers/workers keep running).
    if (process.platform === 'win32') { try { require('child_process').execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* already gone */ } }
    chrome.kill(); server.kill();
    fs.writeFileSync(path.join(OUT, 'ui-test-report.json'), JSON.stringify(results, null, 2));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots and report: ${OUT}`);
    process.exitCode = failed ? 1 : 0;
  }
}
main();
