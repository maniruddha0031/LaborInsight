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

    // ---- 4b. finding presentation and contextual drill-downs (Finding → Store → Employee) ----
    {
      const fq = (q) => ev('App.query(' + JSON.stringify(Object.assign({ type: 'focus' }, q)) + ')');
      const inFocus = (f, lvl) => "App.current==='focus' && App.params.f===" + JSON.stringify(f) + " && " + (lvl === 'org' ? "document.querySelector('#fcS tbody tr')" : lvl === 'store' ? "document.querySelector('#fcE tbody tr') && document.querySelector('#fcR')" : "document.querySelector('#fcAll') && document.querySelector('#fcR')");
      await ev("App.go('findings')"); await sleep(500);
      // Scenario 1 — structured bullets
      const fid = await ev("(()=>{const c=[...document.querySelectorAll('#v-findings .fcard')][2]||document.querySelector('#v-findings .fcard');c.scrollIntoView();c.querySelector('.fhead').click();return c.id.slice(3)})()");
      await until("document.querySelector('#fd-" + fid + " .fbody:not([hidden]) .drill table tbody tr')", 20000);
      const card = await ev("(()=>{const c=document.querySelector('#fd-" + fid + "');const h=[...c.querySelectorAll('.fx h5')].map(x=>x.innerText.trim().toLowerCase());return {h, li:c.querySelectorAll('.fx .fx-pts li').length, big:c.querySelector('.fx-big').innerText, hl:c.querySelectorAll('.fx b.hlv').length, ev:!!c.querySelector('details.fx-ev') && !c.querySelector('details.fx-ev').open}})()");
      check('Drill 1: expanded finding shows What happened / Where / Why it matters / Financial impact / What to do as bullets',
        ['what happened', 'where', 'why it matters', 'financial impact', 'what to do'].every((k) => card.h.includes(k)) && card.li >= 5, card.h.join(' · ') + ' · ' + card.li + ' bullets');
      check('Drill 1: $ headline and highlighted figures; evidence & method collapsed', /\$|h/.test(card.big) && card.hl >= 3 && card.ev, card.big + ' · ' + card.hl + ' highlighted values');
      await shot('24-finding-bullets');
      // Scenario 2 — store row → this finding for that store
      await ev("window.scrollTo({top: document.querySelector('#fd-" + fid + " .drill').getBoundingClientRect().top + window.scrollY - 200})"); await sleep(300);
      const yBefore = await ev('window.scrollY');
      await ev("document.querySelector('#fd-" + fid + " .drill tbody tr').click()");
      const lvl1 = await until("App.current==='focus' && document.querySelector('#v-focus h2')", 240000, 400) && await ev("App.params.g ? 'employee' : App.params.s ? 'store' : 'org'");
      check('Drill 2: a finding row opens the contextual drill-down (not the generic page)', lvl1 && (await ev("App.params.f")) === fid, lvl1 + ' · ' + (await ev("document.querySelector('#v-focus h2') && document.querySelector('#v-focus h2').innerText")));
      check('Drill 2: breadcrumbs Organization / Findings / finding / …', await ev("/Organization.*Findings/s.test(document.querySelector('#v-focus .crumb').innerText) && document.querySelector('#nav button[data-view=findings]').getAttribute('aria-selected')==='true'"), await ev("document.querySelector('#v-focus .crumb').innerText.replace(/\\n/g,' ')"));
      await shot('25-focus-first');
      // Back → finding still open, scroll restored
      await ev('App.back()'); await sleep(900);
      const back1 = await ev("({v:App.current, open:!!document.querySelector('#fd-" + fid + " .fbody:not([hidden])'), y:window.scrollY})");
      check('Drill 4: Back returns to Findings with the same finding expanded and scroll position', back1.v === 'findings' && back1.open && Math.abs(back1.y - yBefore) < 60, 'y ' + back1.y + ' vs ' + yBefore);

      // Scenarios 2/3/7/8 for each lens: org → store → employee, figures reconcile, records stay in context
      const lenses = ['overplan', 'manual', 'ot', 'early', 'late', 'edits', 'meal'];
      for (const lens of lenses) {
        const ins = await ev("(()=>{const i=App.result.insights.find(x=>x.lens===" + JSON.stringify(lens) + ");return i?{id:i.id,title:i.title}:null})()");
        if (!ins) { check('Drill (' + lens + '): finding present', false, 'no finding uses this lens'); continue; }
        await ev("App.go('findings',{open:" + JSON.stringify(ins.id) + "})"); await sleep(600);
        await ev("(()=>{const b=document.querySelector('#fd-" + ins.id + " [data-explore]');b&&b.click()})()");
        const okOrg = await until(inFocus(ins.id, 'org'), 90000, 400);
        const org = okOrg && await fq({ finding: ins.id });
        const sumSt = org ? org.stores.reduce((a, r) => a + r.cost, 0) : NaN;
        check('Drill (' + lens + '): "' + ins.title.slice(0, 50) + '" by store — Σ stores = finding total', okOrg && Math.abs(sumSt - org.summary.cost) < 1, org ? '$' + org.summary.cost.toFixed(2) + ' = Σ ' + org.stores.length + ' stores $' + sumSt.toFixed(2) : 'did not load');
        if (!okOrg) continue;
        await ev("document.querySelector('#fcS tbody tr').click()");
        const okSt = await until(inFocus(ins.id, 'store'), 60000, 300);
        const sp = await ev('App.params');
        const st = okSt && await fq({ finding: ins.id, s: sp.s });
        const sumE = st ? st.employees.reduce((a, r) => a + r.cost, 0) : NaN;
        check('Drill (' + lens + '): store level shows only this finding for store ' + sp.s, okSt && st.records.every((r) => r.s === sp.s) && (lens === 'overplan' ? sumE >= st.summary.cost - 1 : Math.abs(sumE - st.summary.cost) < 1) && Math.abs((org.stores.find((x) => x.s === sp.s) || {}).cost - st.summary.cost) < 1,
          st ? 'store $' + st.summary.cost.toFixed(2) + ' · Σ employees $' + sumE.toFixed(2) + ' · ' + st.recordsTotal + ' records · ' + st.employees.length + ' employees' : 'did not load');
        if (lens === 'manual' || lens === 'late') await shot('26-focus-store-' + lens);
        if (!okSt) continue;
        await ev("document.querySelector('#fcE tbody tr').click()");
        const okE = await until(inFocus(ins.id, 'emp'), 60000, 300);
        const ep = await ev('App.params');
        const em = okE && await fq({ finding: ins.id, s: ep.s, g: ep.g });
        const sumR = em ? em.records.reduce((a, r) => a + r.cost, 0) : NaN;
        const empRow = st.employees.find((x) => x.g === ep.g) || {};
        check('Drill (' + lens + '): employee level has only GEID ' + ep.g + "'s records for this finding and store",
          okE && em.records.length > 0 && em.records.every((r) => r.g === ep.g && r.s === ep.s) && Math.abs(sumR - em.summary.cost) < 0.5 && Math.abs(empRow.cost - em.summary.cost) < 0.5,
          em ? em.name + ' · $' + em.summary.cost.toFixed(2) + ' · ' + em.records.length + ' records' : 'did not load');
        if (lens === 'manual' || lens === 'late') await shot('27-focus-employee-' + lens);
        if (lens === 'manual') {
          check('Drill 3: employee records show business date, schedule, clock-in/out, hours and $', await ev("(()=>{const h=[...document.querySelectorAll('#fcR th')].map(t=>t.innerText).join('|');return /date/i.test(h)&&/Sched\\. start/.test(h)&&/Clock-in/.test(h)&&/Clock-out/.test(h)&&/Paid hours/.test(h)&&/\\$/.test(h)})()"), await ev("[...document.querySelectorAll('#fcR th')].map(t=>t.innerText).join(' | ')"));
          await ev('App.back()');
          const okBack = await until(inFocus(ins.id, 'store') + " && App.params.s===" + JSON.stringify(ep.s) + " && !App.params.g", 20000, 200);
          check('Drill 4: Back from employee returns to the same finding + store', okBack, JSON.stringify(await ev('App.params')));
          await ev("App.go('focus'," + JSON.stringify({ f: ins.id, s: ep.s, g: ep.g }) + ")"); await until(inFocus(ins.id, 'emp'), 20000, 200);
          await ev("document.querySelector('#fcAll').click()");
          check('Drill 3: "View all employee insights" opens the full employee page', await until("App.current==='employees' && App.params.g===" + JSON.stringify(ep.g) + " && document.querySelector('#edD tbody tr')", 20000), ep.g);
        }
      }
      // Scenarios 5/6 — sidebar stays generic
      await ev("document.querySelector('#nav button[data-view=stores]').click()"); await sleep(700);
      check('Drill 5: sidebar Stores opens the generic all-stores overview', await ev("App.current==='stores' && !App.params.s && !App.params.f && document.querySelectorAll('#stT tbody tr').length > 5"), await ev("document.querySelector('#v-stores h2').innerText"));
      await ev("document.querySelector('#nav button[data-view=employees]').click()"); await sleep(700);
      check('Drill 6: sidebar Employees opens the generic all-employees overview', await ev("App.current==='employees' && !App.params.g && !App.params.f && !document.querySelector('#edD')"), await ev("document.querySelector('#v-employees h2').innerText"));
    }

    // ---- 4c. Findings filter chips (severity × evidence type) and keyword headlines ----
    {
      const FST = "(()=>{const ids=[...document.querySelectorAll('#fList .fcard')].map(c=>c.id.slice(3));const I=Object.fromEntries(App.result.insights.map(i=>[i.id,i]));const chip=(g,v)=>document.querySelector('.ffilters .chip[data-g='+g+'][data-v=\"'+v+'\"]');const pressed=(g)=>[...document.querySelectorAll('.ffilters .chip[data-g='+g+']')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.v);return {ids, sev:ids.map(id=>I[id].severity), kind:ids.map(id=>I[id].kind), pSev:pressed('sev'), pKind:pressed('kind'), count:document.querySelector('#fCount').innerText, n:(g,v)=>0}})()";
      const st = () => ev(FST);
      const click = (g, v) => ev("document.querySelector('.ffilters .chip[data-g=" + g + "][data-v=\"" + v + "\"]').click()");
      const chipN = (g) => ev("Object.fromEntries([...document.querySelectorAll('.ffilters .chip[data-g=" + g + "]')].map(b=>[b.dataset.v,+b.querySelector('.n').textContent]))");
      await ev("App.go('findings')"); await sleep(500);
      await ev("(()=>{const r=document.querySelector('#ffReset');if(!r.disabled)r.click()})()");
      const all = await ev("App.result.insights.map(i=>({id:i.id,sev:i.severity,kind:i.kind,cat:i.category,cost:i.impact&&i.impact.cost,title:i.title}))");
      const cnt = (f) => all.filter(f).length;
      // 7 — counts come from the data
      const sevN = await chipN('sev'), kindN = await chipN('kind');
      check('Findings chips 7: counts are computed from the current findings', sevN.All === all.length && ['Critical', 'High', 'Medium', 'Low'].every((v) => sevN[v] === cnt((i) => i.sev === v)) && ['confirmed', 'estimate', 'risk', 'validate'].every((v) => kindN[v] === cnt((i) => i.kind === v)),
        'Severity ' + JSON.stringify(sevN) + ' · Evidence ' + JSON.stringify(kindN));
      check('Findings chips: two labelled groups, All active by default', await ev("[...document.querySelectorAll('.ffilters .fgl')].map(x=>x.innerText.toLowerCase()).join('|')==='severity|evidence type'") && (await st()).pSev.join() === 'All' && (await st()).pKind.join() === 'All', (await st()).count);
      // 1 — Critical only
      await click('sev', 'Critical'); let x = await st();
      check('Findings chips 1: Critical shows only Critical findings', x.ids.length === cnt((i) => i.sev === 'Critical') && x.sev.every((v) => v === 'Critical') && x.count.includes('Showing ' + x.ids.length + ' of ' + all.length), x.count);
      await shot('28-findings-critical');
      // 2 — Critical + Estimate
      await click('kind', 'estimate'); x = await st();
      const ce = cnt((i) => i.sev === 'Critical' && i.kind === 'estimate');
      const sevN2 = await chipN('sev');
      check('Findings chips 2: Critical + Estimate combine (AND)', x.ids.length === ce && x.sev.every((v) => v === 'Critical') && x.kind.every((v) => v === 'estimate') && x.pSev.join() === 'Critical' && x.pKind.join() === 'estimate', x.count);
      check('Findings chips 2: severity counts follow the active evidence type', ['Critical', 'High', 'Medium', 'Low'].every((v) => sevN2[v] === cnt((i) => i.sev === v && i.kind === 'estimate')) && sevN2.All === cnt((i) => i.kind === 'estimate'), JSON.stringify(sevN2));
      await shot('29-findings-critical-estimate');
      // 3 — clear Severity only
      await click('sev', 'All'); x = await st();
      check('Findings chips 3: Severity "All" keeps the Evidence type filter', x.pSev.join() === 'All' && x.pKind.join() === 'estimate' && x.ids.length === cnt((i) => i.kind === 'estimate') && x.kind.every((v) => v === 'estimate'), x.count);
      // 4 — clear Evidence type only
      await click('sev', 'High'); await click('kind', 'All'); x = await st();
      check('Findings chips 4: Evidence type "All" keeps the Severity filter', x.pSev.join() === 'High' && x.pKind.join() === 'All' && x.ids.length === cnt((i) => i.sev === 'High') && x.sev.every((v) => v === 'High'), x.count);
      // 5 — search with filters active
      await click('kind', 'estimate');
      await ev("(()=>{const q=document.querySelector('#fQ');q.value='employees';q.dispatchEvent(new Event('input'))})()"); x = await st();
      const exp = await ev("App.result.insights.filter(i=>i.severity==='High'&&i.kind==='estimate'&&(i.title+' '+i.what+' '+i.where+' '+LCIViews.findingHeadline(i).kw).toLowerCase().includes('employees')).map(i=>i.id)");
      check('Findings chips 5: search works together with severity and evidence type', x.ids.length > 0 && JSON.stringify(x.ids) === JSON.stringify(exp) && x.count.includes('Showing ' + exp.length), x.count + ' · ' + x.ids.join(','));
      // Area together with the chips
      const area = await ev("App.result.insights.find(i=>i.severity==='High'&&i.kind==='estimate').category");
      await ev("(()=>{const q=document.querySelector('#fQ');q.value='';q.dispatchEvent(new Event('input'));const c=document.querySelector('#fCat');c.value=" + JSON.stringify(area) + ";c.dispatchEvent(new Event('change'))})()"); x = await st();
      check('Findings chips: Area works together with the chips', x.ids.length === cnt((i) => i.sev === 'High' && i.kind === 'estimate' && i.cat === area) && x.pSev.join() === 'High' && x.pKind.join() === 'estimate', area + ' · ' + x.count);
      // 10 — expansion and drill-down keep the filters
      const fid2 = x.ids[0];
      await ev("document.querySelector('#fd-" + fid2 + " .fhead').click()");
      const opened = await until("document.querySelector('#fd-" + fid2 + " .fbody:not([hidden]) .drill table tbody tr')", 20000);
      await ev("document.querySelector('#fd-" + fid2 + " .drill tbody tr').click()");
      const inF = await until("App.current==='focus' && App.params.f===" + JSON.stringify(fid2) + " && document.querySelector('#v-focus h2')", 120000, 400);
      await ev('App.back()'); await sleep(900); x = await st();
      check('Findings chips 10: expanding and drilling still work, and Back keeps all finding filters', opened && inF && x.pSev.join() === 'High' && x.pKind.join() === 'estimate' && (await ev("document.querySelector('#fCat').value")) === area && (await ev("!!document.querySelector('#fd-" + fid2 + " .fbody:not([hidden])')")), fid2 + ' · ' + x.count);
      // Reset
      await ev("document.querySelector('#ffReset').click()"); x = await st();
      check('Findings chips: Reset filters clears severity, evidence type, area and search', x.ids.length === all.length && x.pSev.join() === 'All' && x.pKind.join() === 'All' && (await ev("document.querySelector('#fCat').value==='All' && document.querySelector('#fQ').value===''")), x.count);
      // 8 — keyword headlines
      const hd = await ev("[...document.querySelectorAll('#fList .fcard')].map(c=>({id:c.id.slice(3),kw:(c.querySelector('.fkw')||{}).innerText||'',first:c.querySelector('.ft').children[1]&&c.querySelector('.ft').children[1].className,sent:c.querySelector('.fsent').innerText,money:[...c.querySelectorAll('.fsent b.hlv')].map(b=>b.innerText),fi:c.querySelector('.fi').childNodes[0]?c.querySelector('.fi').childNodes[0].textContent:''}))");
      const generic = new Set(['FINDING', '']);
      check('Findings headline 8: every headline starts with a highlighted problem keyword', hd.length === all.length && hd.every((h) => h.first === 'fkw' && !generic.has(h.kw.trim().toUpperCase()) && h.sent.length > 10) && new Set(hd.map((h) => h.kw)).size >= hd.length - 6,
        hd.slice(0, 4).map((h) => h.kw + ' – ' + h.sent.slice(0, 40)).join(' | '));
      // 9 — dollar values unchanged: every highlighted $ is in the engine's title; the card's $ is the engine's impact
      const moneyK = await ev("App.result.insights.map(i=>i.impact&&FMT.ok(i.impact.cost)&&i.impact.cost?FMT.moneyK(i.impact.cost):null)");
      const bad = hd.filter((h, k) => { const t = all.find((a) => a.id === h.id); const idx = all.indexOf(t); return !h.money.every((m) => t.title.includes(m)) || (moneyK[idx] && h.fi !== moneyK[idx]); });
      check('Findings headline 9: $ values match the analysis (headline $ from the engine title; card $ = engine impact)', bad.length === 0, bad.length ? bad.map((b) => b.id).join(',') : hd.reduce((a, h) => a + h.money.length, 0) + ' highlighted $ values checked');
      await shot('30-findings-headlines');
    }

    // ---- 4d. Two store drill-down modes: generic (sidebar) vs problem-specific (Explore) ----
    {
      const H2 = (v) => ev("(document.querySelector('#v-" + v + " h2')||{}).innerText||''");
      const CR = (v) => ev("(document.querySelector('#v-" + v + " .crumb')||{}).innerText||''");
      const ST = await ev("(App.result.stores.find(x=>x.name==='00221')||App.result.stores.slice().sort((a,b)=>b.grossAdd-a.grossAdd)[0]).s");
      const row = await ev("App.result.stores.find(x=>x.s===" + JSON.stringify(ST) + ")");
      const search = (host, q) => ev("(()=>{const i=document.querySelector('" + host + "').querySelector('input[type=search]');i.value=" + JSON.stringify(q) + ";i.dispatchEvent(new Event('input'))})()");
      const clickFirst = (host) => ev("document.querySelector('" + host + " tbody tr').click()");
      const fq = (q) => ev('App.query(' + JSON.stringify(Object.assign({ type: 'focus' }, q)) + ')');
      // Scenario 1 — generic store from the sidebar
      await ev("document.querySelector('#nav button[data-view=stores]').click()"); await sleep(600);
      await search('#stT', row.name); await sleep(200); await clickFirst('#stT');
      const g1 = await until("App.current==='stores' && App.params.s===" + JSON.stringify(ST) + " && document.querySelectorAll('#v-stores .kpis.k6 .kpi').length===6 && document.querySelector('#sdParts .brow') && document.querySelector('#sdRel tbody tr')", 30000, 300);
      const parts = await ev("[...document.querySelectorAll('#sdParts .brow')].map(b=>b.querySelector('.bv').childNodes[0].textContent)");
      const partSum = parts.reduce((t, x) => t + parseFloat(x.replace(/[^0-9.]/g, '')), 0);
      check('Modes 1: sidebar Stores → store opens the complete Store Overview', g1 && /Store Overview/.test(await H2('stores')) && /Organization.*Stores.*Store/s.test(await CR('stores')), (await H2('stores')) + ' · ' + (await CR('stores')).replace(/\n/g, ' '));
      check('Modes 1: store overview is dollar-first (labor $, Labor %, additional, avoidable, OT, top leakage) and covers every problem', g1 && (await ev("[...document.querySelectorAll('#v-stores .kpis.k6 .kpi .kv')].filter(x=>/\\$/.test(x.innerText)).length")) >= 4 && parts.length === 5 && (await ev("document.querySelectorAll('#sdRel tbody tr').length")) === 5,
        (await ev("[...document.querySelectorAll('#v-stores .kpis.k6 .kpi')].map(k=>k.querySelector('.dl').innerText+': '+k.querySelector('.kv').innerText).join(' | ')")));
      check('Modes 7: store cost categories are non-overlapping and add up to the additional labor cost', Math.abs(partSum - row.grossAdd) < 5 && parts.length === 5, parts.join(' + ') + ' ≈ $' + row.grossAdd.toFixed(0));
      await shot('31-store-overview');
      // Scenario 2 — Explore → Manual punches → store → employee
      await ev("App.go('manual')"); await sleep(600);
      await search('#mnS', row.name); await sleep(200); await clickFirst('#mnS');
      const m1 = await until("App.current==='focus' && App.params.x==='manual' && App.params.s===" + JSON.stringify(ST) + " && document.querySelector('#fcE tbody tr')", 120000, 400);
      const ms = m1 && await fq({ lens: 'manual', s: ST });
      check('Modes 2: Explore → Manual punches → store shows Manual Punch Analysis only', m1 && /Manual Punch Analysis — Store/.test(await H2('focus')) && /Organization.*Explore.*Manual punches.*Store/s.test(await CR('focus')) && ms.records.every((r) => r.s === ST && /manual punch/.test(r.issue)),
        (await H2('focus')) + ' · ' + (await CR('focus')).replace(/\n/g, ' '));
      check('Modes 2: manual-punch facts (frequency, clock-in vs clock-out, late entry) and $ = store manual-punch cost', m1 && /Keyed in|audit log/.test(await ev("document.querySelector('#v-focus').innerText")) && Math.abs(ms.summary.cost - row.manExtraCost) < 1 && ms.extras && ms.extras.days === ms.recordsTotal,
        ms ? '$' + ms.summary.cost.toFixed(2) + ' vs store row $' + row.manExtraCost.toFixed(2) + ' · in-only ' + ms.extras.inOnly + ', out-only ' + ms.extras.outOnly + ', both ' + ms.extras.both : '');
      await shot('32-explore-manual-store');
      const yS = await ev('window.scrollY');
      await clickFirst('#fcE');
      const m2 = await until("App.current==='focus' && App.params.x==='manual' && App.params.g && document.querySelector('#fcAll')", 60000, 300);
      const mp = await ev('App.params'), me = m2 && await fq({ lens: 'manual', s: mp.s, g: mp.g });
      check('Modes 2: employee level shows only that employee\'s manual punches (+ View all employee insights)', m2 && /Manual Punch Analysis — /.test(await H2('focus')) && me.records.length > 0 && me.records.every((r) => r.g === mp.g && r.s === mp.s) && (await ev("[...document.querySelectorAll('#fcR th')].some(t=>/Keyed in manually/.test(t.innerText))")),
        (await H2('focus')) + ' · ' + (me ? me.records.length + ' records, $' + me.summary.cost.toFixed(2) : ''));
      await shot('33-explore-manual-employee');
      // Scenario 6 — Back keeps the context at every level
      await ev('App.back()');
      check('Modes 6: Back from employee returns to Manual punches · same store', await until("App.current==='focus' && App.params.x==='manual' && App.params.s===" + JSON.stringify(ST) + " && !App.params.g && document.querySelector('#fcE tbody tr')", 20000, 200));
      await ev('App.back()'); await sleep(800);
      check('Modes 6: Back again returns to the Manual punches page with its filters', (await ev("App.current")) === 'manual' && (await ev("document.querySelector('#mnS input[type=search]').value")) === '' && (await ev("App.filter.stores===null")), await ev("App.current"));
      // Scenario 3 — Explore → Overtime → store
      await ev("App.go('overtime')"); await sleep(600);
      await search('#otS', row.name); await sleep(200); await clickFirst('#otS');
      const o1 = await until("App.current==='focus' && App.params.x==='overtime' && App.params.s===" + JSON.stringify(ST) + " && document.querySelector('#fcR')", 60000, 300);
      const os = o1 && await fq({ lens: 'ot', s: ST });
      check('Modes 3: Explore → Overtime → store shows Overtime Analysis only; $ = recorded OT premium', o1 && /Overtime Analysis — Store/.test(await H2('focus')) && Math.abs(os.summary.cost - row.otPrem) < 1 && Math.abs(os.extras.premSched + os.extras.premDrift - os.summary.cost) < 1 && !/manual punch|meal/i.test(await ev("document.querySelector('#fcR').innerText")),
        os ? (await H2('focus')) + ' · $' + os.summary.cost.toFixed(2) + ' = planned $' + os.extras.premSched.toFixed(2) + ' + past schedule $' + os.extras.premDrift.toFixed(2) : '');
      await shot('34-explore-overtime-store');
      // Scenario 4 — Explore → Schedule vs actual → store
      await ev("App.go('adherence')"); await sleep(600);
      await search('#adTbl', row.name); await sleep(200); await clickFirst('#adTbl');
      const a1 = await until("App.current==='focus' && App.params.x==='adherence' && App.params.s===" + JSON.stringify(ST) + " && document.querySelector('#fcE tbody tr')", 60000, 300);
      const as = a1 && await fq({ lens: 'overplan', s: ST });
      check('Modes 4: Explore → Schedule vs actual → store shows schedule variance and its $ only', a1 && /Schedule vs Actual — Store/.test(await H2('focus')) && Math.abs(as.summary.cost - row.overPlanCost) < 1 && as.records.every((r) => /scheduled|schedule/.test(r.issue)) && /Scheduled .* paid/.test(await ev("document.querySelector('#v-focus').innerText")),
        as ? (await H2('focus')) + ' · $' + as.summary.cost.toFixed(2) + ' vs store row $' + row.overPlanCost.toFixed(2) : '');
      // From the store overview into one problem and back to it
      await ev("App.go('stores',{s:" + JSON.stringify(ST) + "})"); await until("document.querySelector('#sdParts .brow')", 20000);
      await ev("document.querySelector('#sdParts .brow').click()");
      const sp = await until("App.current==='focus' && App.params.x==='stores' && document.querySelector('#v-focus h2')", 60000, 300);
      check('Modes: a cost category on the store overview opens that problem for the store, under Stores in the breadcrumb', sp && /Organization.*Stores.*Store/s.test(await CR('focus')) && (await ev("document.querySelector('#nav button[data-view=stores]').getAttribute('aria-selected')")) === 'true', (await CR('focus')).replace(/\n/g, ' '));
      // Sidebar resets the context
      await ev("document.querySelector('#nav button[data-view=stores]').click()"); await sleep(700);
      check('Modes: sidebar Stores after a problem drill-down opens the generic store list (no stale context)', await ev("App.current==='stores' && !App.params.s && !App.params.x && document.querySelectorAll('#stT tbody tr').length > 5"));
      // Scenario 5 — generic employee
      await ev("document.querySelector('#nav button[data-view=employees]').click()"); await sleep(600);
      await clickFirst('#emT');
      check('Modes 5: sidebar Employees → employee opens the complete Employee Profile', await until("App.current==='employees' && App.params.g && document.querySelector('#edD tbody tr')", 20000) && /Employee Profile/.test(await H2('employees')) && /Organization.*Employees/s.test(await CR('employees')) && (await ev("document.querySelectorAll('#v-employees .kpi').length")) >= 5,
        (await H2('employees')) + ' · ' + (await CR('employees')).replace(/\n/g, ' '));
      // Scenario 7 — reconciliation at organization level for the Explore lenses
      for (const [lens, fig] of [['manual', 'App.result.financials.manual.extraCost'], ['ot', 'App.result.overtime.tot.prem'], ['overplan', 'App.result.financials.overPlan.cost']]) {
        const o = await fq({ lens }); const want = await ev(fig);
        check('Modes 7: ' + lens + ' — Σ stores = organization figure (no double counting across levels)', Math.abs(o.summary.cost - want) < 1 && Math.abs(o.stores.reduce((t, x) => t + x.cost, 0) - want) < 1, '$' + o.summary.cost.toFixed(2) + ' vs $' + want.toFixed(2));
      }
    }

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
      check('Scenario 1: clicking a ranked store opens its Labor % analysis (problem context)', await until(`App.current==='focus' && App.params.x==='laborrank' && App.params.lens==='labor' && /Sales & Labor Analysis/.test(document.querySelector('#v-focus h2') ? document.querySelector('#v-focus h2').innerText : '')`, 120000, 400), await ev(`document.querySelector('#v-focus h2') && document.querySelector('#v-focus h2').innerText`));
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
      await ev("App.go('findings')"); await sleep(500);
      const fc6 = await ev("(()=>{const n=Object.fromEntries([...document.querySelectorAll('.ffilters .chip[data-g=sev]')].map(b=>[b.dataset.v,+b.querySelector('.n').textContent]));const R=App.result.insights;return {n, ok:n.All===R.length&&['Critical','High','Medium','Low'].every(v=>n[v]===R.filter(i=>i.severity===v).length), total:R.length, base:App.base.result.insights.length, txt:document.querySelector('#fCount').innerText}})()");
      check('Findings chips 6: counts refresh for the selected store and period', fc6.ok && fc6.txt.includes('of ' + fc6.total + ' findings'), fc6.txt + ' (organization, full period: ' + fc6.base + ') · ' + JSON.stringify(fc6.n));
      // Drill 4 under filters — drill-down respects the store scope and Back keeps the filter
      const fIns = await ev("(()=>{const i=App.result.insights.find(x=>x.lens);return i&&i.id})()");
      const scopeBefore = await ev("document.querySelector('#fActive').innerText");
      if (fIns) {
        await ev("App.go('findings',{open:" + JSON.stringify(fIns) + "})"); await sleep(500);
        await ev("App.drill(App.result.insights.find(x=>x.id===" + JSON.stringify(fIns) + "),{})");
        const okF = await until("App.current==='focus' && document.querySelector('#fcS tbody tr')", 60000, 300);
        const fo = okF && await ev("App.query({type:'focus',finding:" + JSON.stringify(fIns) + "})");
        check('Drill 4 (filtered): drill-down covers only the filtered store', okF && fo.stores.every((x) => x.s === pickStore), fo ? fo.stores.map((x) => x.s).join(',') : 'did not load');
        await ev('App.back()'); await sleep(700);
        check('Drill 4 (filtered): Back returns to the finding with the same filters', await ev("App.current==='findings' && App.result.meta.scope.kind==='store' && !!document.querySelector('#fd-" + fIns + " .fbody:not([hidden])')") && (await ev("document.querySelector('#fActive').innerText")) === scopeBefore, scopeBefore.replace(/\n/g, ' '));
      }
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
    check('Behaviour pattern row opens that pattern for the employee (problem context)', await until(`App.current==='focus' && App.params.x==='behavior' && document.querySelector('#fcAll') && document.querySelector('.fc-pat')`, 60000, 300), await ev(`document.querySelector('#v-focus h2') && document.querySelector('#v-focus h2').innerText`));
    await ev(`document.querySelector('#fcAll').click()`);
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
      await ev(`App.go('findings'); App.drill(App.result.insights.find(x=>x.lens==='late'),{})`);
      check('Opened from disk: finding drill-down (Finding → stores) works', await until(`App.current==='focus' && document.querySelector('#fcS tbody tr')`, 240000, 500), await ev(`document.querySelector('#v-focus h2') && document.querySelector('#v-focus h2').innerText`));
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
