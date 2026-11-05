/*
 * app.js — page controller: dataset selection, analysis lifecycle, navigation, drill-down queries.
 *
 * Dataset isolation: every Analyze creates a brand-new Web Worker and clears all previous results,
 * charts and rendered views before anything new is shown.
 */
(function (G) {
  const { esc } = G.FMT;
  const { $, $$ } = G.UI;
  const VIEWS = (G.VIEWS = G.VIEWS || {});

  const App = (G.App = {
    manifest: null, selected: null, file: null, result: null, worker: null, rendered: new Set(), current: 'dataset', params: {}, qid: 0, pending: new Map(), runId: 0,
  });

  // ---------- theme ----------
  function getTheme() { try { return localStorage.getItem('lci-theme'); } catch (e) { return null; } }
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    // The button offers the other theme: a sun to go light, a moon to go dark.
    const btn = $('#themeBtn'), next = dark ? 'light' : 'dark';
    btn.querySelector('.ti').textContent = dark ? '☀' : '☾';
    btn.querySelector('.tl').textContent = dark ? 'Light' : 'Dark';
    btn.setAttribute('aria-label', `Switch to ${next} theme`);
    btn.title = `Switch to ${next} theme`;
  }
  applyTheme(getTheme());
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') ? document.documentElement.getAttribute('data-theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const t = dark ? 'light' : 'dark';
    try { localStorage.setItem('lci-theme', t); } catch (e) { /* storage unavailable */ }
    applyTheme(t);
    if (App.result && App.current !== 'dataset') { App.rendered.delete(App.current); show(App.current, App.params, true); }
  });

  // ---------- manifest ----------
  const msg = (html, cls) => { $('#dsMsg').innerHTML = html ? `<div class="msg ${cls || ''}">${html}</div>` : ''; };
  const FILE_MODE = location.protocol === 'file:';
  const SERVE_HINT = 'Re-analysing a ZIP or uploading a new one needs the page served over http — use VS Code <b>Live Server</b>, or run <code>node tools/serve.js 8080</code> in the project folder and open <code>http://localhost:8080</code>.';

  async function loadManifest() {
    const sel = $('#dsSelect');
    try {
      // manifest.js (a <script>) works even when the page is opened straight from disk; fetch is the fallback.
      if (G.LCI_MANIFEST) App.manifest = G.LCI_MANIFEST;
      else {
        const r = await fetch('datasets/manifest.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        App.manifest = await r.json();
      }
      const ds = (App.manifest.datasets || []).filter((d) => d && d.id && d.files && d.files.length);
      sel.innerHTML = '<option value="">Select a dataset…</option>' + ds.map((d) => `<option value="${esc(d.id)}">${esc(d.label || d.id)}${d.snapshot ? ' · ready' : ''}</option>`).join('');
      if (!ds.length) sel.innerHTML = '<option value="">No datasets registered</option>';
      if (ds.length === 1 || App.manifest.default) {
        sel.value = App.manifest.default || ds[0].id;
        onSelect();
        // Open straight onto the default dataset's pre-computed analysis — no upload, no waiting.
        if (App.selected && App.selected.snapshot) openSnapshot(App.selected);
      }
    } catch (e) {
      sel.innerHTML = '<option value="">Could not read the dataset list</option>';
      msg('Could not load <code>datasets/manifest.json</code> (' + esc(e.message) + '). ' + (FILE_MODE ? SERVE_HINT : 'You can still upload a ZIP.'), 'warn');
    }
  }

  // ---------- pre-computed snapshots (tools/build-snapshot.js) ----------
  // Snapshot parts are <script> files that call LCI_SNAPSHOT_LOAD(id, part, data); loaded on demand.
  const partWaiters = new Map(), partCache = new Map();
  G.LCI_SNAPSHOT_LOAD = (id, part, data) => {
    const k = id + '/' + part;
    partCache.set(k, data);
    const w = partWaiters.get(k);
    if (w) { partWaiters.delete(k); w.resolve(data); }
  };
  function loadPart(ds, part) {
    const k = ds.id + '/' + part;
    if (partCache.has(k)) return Promise.resolve(partCache.get(k));
    return new Promise((resolve, reject) => {
      partWaiters.set(k, { resolve, reject });
      const s = document.createElement('script');
      s.src = `datasets/${ds.snapshot.dir}/${part}.js?v=${encodeURIComponent(ds.snapshot.generatedAt || '')}`;
      s.onerror = () => { partWaiters.delete(k); reject(new Error(`Pre-computed file ${ds.snapshot.dir}/${part}.js is missing. Re-run tools/build-snapshot.js ${ds.id}.`)); };
      document.head.appendChild(s);
    });
  }
  const shardOf = (key, n) => { let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0; return h % n; };
  const unpack = (t) => (t && t.c ? t.r.map((row) => Object.fromEntries(t.c.map((c, i) => [c, row[i]]))) : t || []);

  async function openSnapshot(ds) {
    if (App.worker) { App.worker.terminate(); App.worker = null; }
    App.runId++;
    clearResults();
    msg('');
    $('#progress').hidden = false;
    $('#progBar').style.width = '60%';
    $('#progMsg').textContent = 'Opening the pre-computed analysis…';
    $('#steps').innerHTML = '';
    try {
      const snap = await loadPart(ds, 'result');
      App.snap = { ds, inline: snap.inline, empShards: snap.empShards };
      $('#progBar').style.width = '100%';
      $('#progMsg').textContent = `Pre-computed on ${G.FMT.date(String(ds.snapshot.generatedAt).slice(0, 10))} from ${ds.files.join(', ')}. Analyze re-runs it from the ZIP.`;
      onResult(snap.result, ds.label || ds.id);
    } catch (e) {
      $('#progress').hidden = true;
      msg(esc(e.message) + (FILE_MODE ? ' ' + SERVE_HINT : ' Click Analyze to process the ZIP instead.'), 'warn');
    }
  }
  function datasetById(id) { return ((App.manifest && App.manifest.datasets) || []).find((d) => d.id === id); }

  function info(rows) { $('#dsInfo').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join(''); }
  function onSelect() {
    const d = datasetById($('#dsSelect').value);
    App.selected = d || null;
    if (d) { App.file = null; $('#fileInput').value = ''; msg(''); }
    refreshSelection();
  }
  function refreshSelection() {
    const d = App.selected, f = App.file;
    if (d) {
      const size = (d.sizeBytes || 0) ? G.FMT.bytes(d.sizeBytes) : '';
      info([['Dataset', esc(d.label || d.id)], ['Source', 'Registered in manifest'], ['Files', d.files.map((x) => `<code>${esc(x)}</code>`).join('<br>')],
        ['Size', size || '—'], ['Period', esc(d.period || 'Detected after analysis')],
        ['Analysis', d.snapshot ? `Pre-computed ${G.FMT.date(String(d.snapshot.generatedAt).slice(0, 10))} — opens instantly` : 'Computed when you click Analyze'], ['Notes', esc(d.description || '—')]]);
      $('#dsHint').textContent = d.snapshot ? 'Analyze re-runs the analysis from the ZIP (about 1–2 minutes).' : '';
    } else if (f) {
      info([['Dataset', esc(f.name)], ['Source', 'Uploaded from this computer'], ['Size', G.FMT.bytes(f.size)], ['Period', 'Detected after analysis']]);
      $('#dsHint').textContent = '';
    } else info([['Dataset', '—']]);
    $('#openSnapBtn').hidden = !(d && d.snapshot);
    $('#analyzeBtn').textContent = d && d.snapshot ? 'Re-analyze from ZIP' : 'Analyze';
    $('#analyzeBtn').className = d && d.snapshot ? 'btn' : 'btn primary';
    $('#analyzeBtn').disabled = !(d || f);
  }
  $('#dsSelect').addEventListener('change', onSelect);
  $('#openSnapBtn').addEventListener('click', () => { if (App.selected && App.selected.snapshot) openSnapshot(App.selected); });

  // ---------- upload ----------
  function takeFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { msg(`“${esc(file.name)}” is not a .zip file. Upload one ZIP that contains the CSV exports.`, 'err'); return; }
    App.file = file; App.selected = null; $('#dsSelect').value = '';
    msg('');
    refreshSelection();
  }
  $('#fileInput').addEventListener('change', (e) => takeFile(e.target.files[0]));
  const drop = $('#drop');
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => takeFile(e.dataTransfer.files[0]));

  // ---------- analysis lifecycle ----------
  const STEPS = ['Reading files', 'Normalising records and checking data quality', 'Matching punches to schedules by GEID', 'Analysing overtime',
    'Analysing punch edits, manual entries and punch methods', 'Checking breaks, minors and labor exceptions', 'Calculating monthly sales and labor efficiency',
    'Building summaries and trends', 'Detecting employee behaviour patterns', 'Generating findings and recommendations'];

  function clearResults() {
    App.result = null;
    App.snap = null;
    App.base = null;
    App.filter = { stores: null, from: null, to: null };
    App.engineReady = null;
    App.fid++;
    $('#fbar').hidden = true; $('#busy').hidden = true; $('#main').classList.remove('recalc');
    App.rendered.clear();
    G.UI.destroyCharts();
    for (const v of $$('section.view')) if (v.id !== 'v-dataset') { v.innerHTML = ''; v.hidden = true; }
    for (const b of $$('#nav button')) if (b.dataset.view !== 'dataset') b.disabled = true;
    $('#navFindings').textContent = '';
    $('#srcName').textContent = 'No dataset loaded'; $('#srcMeta').textContent = ''; $('#changeData').hidden = true;
    $('#valSummary').innerHTML = '';
    for (const [, p] of App.pending) p.reject(new Error('Dataset changed'));
    App.pending.clear();
  }

  function setProgress(pct, text, stage) {
    $('#progress').hidden = false;
    $('#progBar').style.width = Math.round(pct * 100) + '%';
    $('#progMsg').textContent = text || '';
    const idx = stage === 'read' ? 0 : Math.max(1, STEPS.indexOf(text));
    $('#steps').innerHTML = STEPS.map((s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'cur' : ''}">${esc(s)}</li>`).join('');
  }

  function analyze() {
    const d = App.selected, f = App.file;
    if (!d && !f) return;
    if (FILE_MODE) {
      // Workers and fetch are blocked on file://. A registered dataset can still be opened from its snapshot.
      if (d && d.snapshot) { openSnapshot(d); return; }
      msg(SERVE_HINT, 'err');
      return;
    }
    if (App.worker) App.worker.terminate();
    clearResults();
    const runId = ++App.runId;
    msg('');
    $('#analyzeBtn').disabled = true; $('#cancelBtn').hidden = false; $('#dsSelect').disabled = true;
    const t0 = performance.now();
    setProgress(0, 'Starting…', 'read');
    let worker;
    try { worker = new Worker('js/worker.js'); } catch (e) { finish(); msg('Background processing is not available: ' + esc(e.message), 'err'); return; }
    App.worker = worker;
    const cfg = d ? { name: d.id, label: d.label || d.id, excludeStores: d.excludeStores || [], rules: d.rules || {} } : { name: f.name, label: f.name, excludeStores: [], rules: {} };
    const source = d ? { kind: 'urls', urls: d.files.map((x) => new URL('datasets/' + x, location.href).href), sizes: d.fileSizes || [] } : { kind: 'file', file: f };
    worker.onmessage = (e) => {
      if (runId !== App.runId) return;
      const m = e.data;
      if (filterMessage(m)) return;
      if (m.type === 'progress') setProgress(m.pct, m.msg, m.stage);
      else if (m.type === 'result') {
        finish();
        setProgress(1, `Done in ${((performance.now() - t0) / 1000).toFixed(0)} s`, 'analyse');
        $$('#steps li').forEach((li) => (li.className = 'done'));
        onResult(m.result, d ? (d.label || d.id) : f.name);
      } else if (m.type === 'error') {
        finish();
        $('#progress').hidden = true;
        let extra = '';
        if (m.files && m.files.length) extra = '<ul style="margin:6px 0 0;padding-left:18px">' + m.files.map((x) => `<li>${esc(x.name)} — ${esc(x.label)}${x.notes && x.notes.length ? ': ' + esc(x.notes.join(' ')) : ''}</li>`).join('') + '</ul>';
        msg('<b>The dataset could not be analysed.</b> ' + esc(m.message) + extra, 'err');
      } else if (m.type === 'query') {
        const p = App.pending.get(m.qid);
        if (p) { App.pending.delete(m.qid); m.error ? p.reject(new Error(m.error)) : p.resolve(m.data); }
      }
    };
    worker.onerror = (e) => { if (runId !== App.runId) return; finish(); $('#progress').hidden = true; msg('Processing failed: ' + esc(e.message || 'worker error') + '. Large datasets need a 64-bit browser with enough free memory.', 'err'); };
    worker.postMessage({ cmd: 'analyze', source, cfg });
  }
  function finish() { $('#analyzeBtn').disabled = !(App.selected || App.file); $('#cancelBtn').hidden = true; $('#dsSelect').disabled = false; }
  $('#analyzeBtn').addEventListener('click', analyze);
  $('#cancelBtn').addEventListener('click', () => { if (App.worker) App.worker.terminate(); App.worker = null; App.runId++; finish(); $('#progress').hidden = true; msg('Analysis cancelled.', 'warn'); });
  $('#changeData').addEventListener('click', () => show('dataset'));

  async function snapQuery(q) {
    const S = App.snap, R = App.result;
    if (q.type === 'employee') {
      const shard = await loadPart(S.ds, 'emp' + shardOf(q.g, S.empShards));
      const d = shard[q.g];
      return d ? Object.assign({}, d, { days: unpack(d.days) }) : null;
    }
    if (q.type === 'store') return (await loadPart(S.ds, 'stores'))[q.s] || null;
    if (q.type === 'records') return S.inline[q.key] || [];
    if (q.type === 'storeMonths') {
      const set = new Set(q.rows);
      return R.sales.available ? R.sales.table.filter((x) => set.has(x.s + '|' + x.month)).map((x) => Object.assign({ name: R.meta.storeNames[x.s] || x.s }, x)) : [];
    }
    return null;
  }

  App.query = (q) => new Promise((resolve, reject) => {
    if (App.snap && App.result) return snapQuery(q).then(resolve, reject);
    if (!App.worker || !App.result) return reject(new Error('No dataset loaded'));
    const qid = ++App.qid;
    App.pending.set(qid, { resolve, reject });
    App.worker.postMessage({ cmd: 'query', qid, q });
  });

  function onResult(R, label) {
    App.result = R;
    App.base = { result: R, snap: App.snap, label };
    App.filter = { stores: null, from: null, to: null };
    const p = R.meta.period;
    $('#srcName').textContent = label;
    $('#changeData').hidden = false;
    for (const b of $$('#nav button')) b.disabled = false;
    syncChrome();
    buildFilterBar();
    const q = R.quality.summary;
    const cls = q.status === 'error' ? 'err' : q.status === 'warn' ? 'warn' : 'ok';
    $('#valSummary').innerHTML = `<div class="msg ${cls}"><b>Validation:</b> ${q.recognised} of ${q.files} files recognised · ${G.FMT.n(q.rowsRead)} rows read · ${q.errors} error(s), ${q.warnings} warning(s). <button class="lnk" id="openQuality">Review data quality</button></div>
      <div class="note" style="margin-top:8px">Analysis period ${G.FMT.date(p.startIso)} – ${G.FMT.date(p.endIso)} (${R.meta.months.length} months${R.meta.months.some((m) => m.partial) ? ', some partial' : ''}).${R.meta.excludedStores.length ? ' Excluded test stores: ' + esc(R.meta.excludedStores.join(', ')) + '.' : ''}</div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="openOverview">Open executive overview</button></div>`;
    $('#openQuality').addEventListener('click', () => show('quality'));
    $('#openOverview').addEventListener('click', () => show('overview'));
    show('overview');
  }

  // ---------- global filters: scope (organization / stores) × period ----------
  App.fid = 0;
  const dayOf = (iso) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
  const isoOf = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
  const fmtRange = (a, b) => `${G.FMT.date(isoOf(a))} – ${G.FMT.date(isoOf(b))}`;

  /** Quick periods, anchored to the last day in the data (not today's date). */
  function presets() {
    const R = App.base.result, dp = R.meta.dataPeriod, s = dp.start, e = dp.end;
    const clamp = (a, b) => [Math.max(s, a), Math.min(e, b)];
    const endIso = isoOf(e), y = +endIso.slice(0, 4), m = +endIso.slice(5, 7);
    const mStart = (yy, mm) => Math.floor(Date.UTC(yy, mm - 1, 1) / 86400000), mEnd = (yy, mm) => Math.floor(Date.UTC(yy, mm, 0) / 86400000);
    const pm = m === 1 ? [y - 1, 12] : [y, m - 1];
    const list = [
      { k: 'all', label: `Full period (${fmtRange(s, e)})`, r: [s, e] },
      { k: 'last7', label: 'Last 7 days of data', r: clamp(e - 6, e) },
      { k: 'last30', label: 'Last 30 days of data', r: clamp(e - 29, e) },
      { k: 'this', label: `Latest month (${G.FMT.monthLabel(endIso.slice(0, 7))})`, r: clamp(mStart(y, m), mEnd(y, m)) },
      { k: 'prev', label: `Previous month (${G.FMT.monthLabel(`${pm[0]}-${String(pm[1]).padStart(2, '0')}`)})`, r: clamp(mStart(pm[0], pm[1]), mEnd(pm[0], pm[1])) },
      { k: 'ytd', label: `Year to date (${y})`, r: clamp(mStart(y, 1), e) },
    ];
    for (const mo of R.meta.dataMonths) list.push({ k: 'm:' + mo.key, label: mo.label, r: [mo.first, mo.last], group: 'Month' });
    list.push({ k: 'custom', label: 'Custom dates…', r: null });
    return list.filter((p) => !p.r || p.r[0] <= p.r[1]);
  }

  function currentRange() {
    const dp = App.base.result.meta.dataPeriod;
    return [App.filter.from != null ? App.filter.from : dp.start, App.filter.to != null ? App.filter.to : dp.end];
  }

  function buildFilterBar() {
    const R = App.base.result, dp = R.meta.dataPeriod;
    $('#fbar').hidden = false;
    const ps = presets();
    const [a, b] = currentRange();
    const match = ps.find((p) => p.r && p.r[0] === a && p.r[1] === b);
    $('#fPreset').innerHTML = ps.filter((p) => !p.group).map((p) => `<option value="${p.k}">${esc(p.label)}</option>`).join('') +
      `<optgroup label="Month">${ps.filter((p) => p.group).map((p) => `<option value="${p.k}">${esc(p.label)}</option>`).join('')}</optgroup>`;
    $('#fPreset').value = match ? match.k : 'custom';
    for (const id of ['#fFrom', '#fTo']) { $(id).min = dp.startIso; $(id).max = dp.endIso; }
    $('#fFrom').value = isoOf(a); $('#fTo').value = isoOf(b);
    $('#fApply').hidden = true;
    const st = App.filter.stores;
    $('#fOrg').setAttribute('aria-pressed', String(!st));
    $('#fStoreBtn').setAttribute('aria-pressed', String(!!st));
    $('#fStoreBtn').textContent = !st ? 'Store ▾' : st.length === 1 ? `Store ${R.meta.storeNames[st[0]] || st[0]} ▾` : `${st.length} stores ▾`;
    syncChrome();
  }

  /** Active-filter summary, sidebar and nav counters for the result currently shown. */
  function syncChrome() {
    const R = App.result;
    if (!R) return;
    const sc = R.meta.scope || {}, p = R.meta.period;
    const full = R.meta.months.filter((m) => m.fullForData !== false && !(sc && !sc.all && m.fullForData === false)).length;
    const salesTxt = R.sales.available ? `Sales &amp; Labor %: ${R.sales.salesMonths ? R.sales.salesMonths.length : full} complete month${(R.sales.salesMonths || []).length === 1 ? '' : 's'}${R.sales.partialMonths && R.sales.partialMonths.length ? ` (partial ${R.sales.partialMonths.map((k) => G.FMT.monthShort(k)).join(', ')} excluded)` : ''}` : '<span style="color:var(--high)">Sales &amp; Labor %: not available for this range (no complete month)</span>';
    $('#fActive').innerHTML = `<span class="tok">${esc(sc.storeLabel || 'Organization')}</span><b>${G.FMT.n(R.meta.storeCount)} store${R.meta.storeCount === 1 ? '' : 's'}</b> · <b>${G.FMT.n(R.meta.employeeCount)} employees</b> · <b>${G.FMT.date(p.startIso)} – ${G.FMT.date(p.endIso)}</b> (${R.meta.months.length} month${R.meta.months.length === 1 ? '' : 's'}) · ${salesTxt}`;
    $('#srcMeta').textContent = `${sc.storeLabel || 'Organization'} · ${G.FMT.date(p.startIso)} – ${G.FMT.date(p.endIso)} · ${R.meta.storeCount} stores · ${G.FMT.n(R.meta.employeeCount)} employees`;
    $('#navFindings').textContent = R.insights.length;
  }

  // Store picker
  function openStorePicker() {
    const R = App.base.result;
    const chosen = new Set(App.filter.stores || []);
    const hrs = Object.fromEntries(R.stores.map((s) => [s.s, s.paidHrs]));
    const all = R.meta.allStores.slice().sort((x, y) => String(R.meta.storeNames[x] || x).localeCompare(String(R.meta.storeNames[y] || y)));
    const draw = () => {
      const q = $('#storeQ').value.trim().toLowerCase();
      const shown = all.filter((s) => !q || String(R.meta.storeNames[s] || s).toLowerCase().includes(q));
      $('#storeList').innerHTML = shown.map((s) => `<label><input type="checkbox" value="${esc(s)}" ${chosen.has(s) ? 'checked' : ''}>Store ${esc(R.meta.storeNames[s] || s)}<span class="n">${hrs[s] ? G.FMT.hrsK(hrs[s]) : ''}</span></label>`).join('') || '<div class="empty">No store matches</div>';
      $('#storeCount').textContent = `${chosen.size} selected`;
      $$('#storeList input').forEach((cb) => cb.addEventListener('change', () => { cb.checked ? chosen.add(cb.value) : chosen.delete(cb.value); $('#storeCount').textContent = `${chosen.size} selected`; }));
      App._pickShown = shown;
    };
    App._pick = chosen;
    $('#storeQ').value = '';
    $('#storeQ').oninput = draw;
    $('#storeAll').onclick = () => { for (const s of App._pickShown) chosen.add(s); draw(); };
    $('#storeNone').onclick = () => { chosen.clear(); draw(); };
    draw();
    $('#storePop').hidden = false;
    $('#storeQ').focus();
  }
  $('#fStoreBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#storePop').hidden ? openStorePicker() : ($('#storePop').hidden = true); });
  $('#storeCancel').addEventListener('click', () => { $('#storePop').hidden = true; });
  $('#storeApply').addEventListener('click', () => {
    $('#storePop').hidden = true;
    const st = [...(App._pick || [])];
    applyFilter(Object.assign({}, App.filter, { stores: st.length ? st : null }));
  });
  document.addEventListener('click', (e) => { if (!$('#storePop').hidden && !e.target.closest('#storePop') && e.target !== $('#fStoreBtn')) $('#storePop').hidden = true; });
  $('#fOrg').addEventListener('click', () => applyFilter(Object.assign({}, App.filter, { stores: null })));
  $('#fPreset').addEventListener('change', () => {
    const p = presets().find((x) => x.k === $('#fPreset').value);
    if (!p || !p.r) { $('#fApply').hidden = false; $('#fFrom').focus(); return; }
    applyFilter(Object.assign({}, App.filter, { from: p.r[0], to: p.r[1] }));
  });
  for (const id of ['#fFrom', '#fTo']) $(id).addEventListener('change', () => { $('#fPreset').value = 'custom'; $('#fApply').hidden = false; });
  $('#fApply').addEventListener('click', () => {
    const a = $('#fFrom').value, b = $('#fTo').value;
    if (!a || !b) return busy('Choose both a start and an end date.', 'err');
    if (a > b) return busy('The start date must be on or before the end date.', 'err');
    applyFilter(Object.assign({}, App.filter, { from: dayOf(a), to: dayOf(b) }));
  });
  $('#fReset').addEventListener('click', () => applyFilter({ stores: null, from: null, to: null }));

  function busy(text, kind) {
    const b = $('#busy');
    if (!text) { b.hidden = true; $('#main').classList.remove('recalc'); return; }
    b.hidden = false;
    b.style.borderColor = kind === 'err' ? 'var(--crit)' : '';
    b.querySelector('.spin').style.display = kind === 'err' ? 'none' : '';
    $('#busyMsg').innerHTML = text + (kind === 'err' ? ' <button class="lnk" id="busyX" type="button">Dismiss</button>' : '');
    if (kind === 'err') { $('#main').classList.remove('recalc'); $('#busyX').addEventListener('click', () => busy(null)); } else $('#main').classList.add('recalc');
  }

  function isDefault(f) {
    const dp = App.base.result.meta.dataPeriod;
    return !f.stores && (f.from == null || f.from <= dp.start) && (f.to == null || f.to >= dp.end);
  }

  /** Start (once) the engine that re-runs the analysis for a scope. */
  function ensureFilterEngine() {
    if (App.engineReady) return App.engineReady;
    App.engineReady = new Promise(async (resolve, reject) => {
      try {
        if (App.worker && !App.base.snap) { resolve(); return; } // ZIP analysed in this worker: base model is already there
        const ds = App.base.snap.ds;
        if (!ds.snapshot.modelParts) throw new Error('This pre-computed dataset has no data model for filtering. Re-run tools/build-snapshot.js ' + ds.id + ', or use Re-analyze from ZIP.');
        busy('Preparing filters — loading the data model (first time only)…');
        let worker;
        if (FILE_MODE) {
          // Opened from disk: start the worker from the engine bundle (a Blob URL works on file://).
          if (!G.LCI_ENGINE_BUNDLE) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'js/engine.bundle.js'; s.onload = ok; s.onerror = () => no(new Error('js/engine.bundle.js is missing. Re-run tools/build-snapshot.js.')); document.head.appendChild(s); });
          worker = new Worker(URL.createObjectURL(new Blob([G.LCI_ENGINE_BUNDLE.src], { type: 'text/javascript' })));
        } else worker = new Worker('js/worker.js');
        if (App.worker) App.worker.terminate();
        App.worker = worker;
        const runId = App.runId;
        worker.onmessage = (e) => { if (runId !== App.runId) return; const m = e.data; if (filterMessage(m)) return; if (m.type === 'query') { const p = App.pending.get(m.qid); if (p) { App.pending.delete(m.qid); m.error ? p.reject(new Error(m.error)) : p.resolve(m.data); } } };
        worker.onerror = (e) => reject(new Error(e.message || 'The filter engine stopped unexpectedly.'));
        const chunks = [];
        for (let i = 0; i < ds.snapshot.modelParts; i++) chunks.push(await loadPart(ds, 'model' + i));
        App._modelReady = resolve; App._modelFail = reject;
        const R = App.base.result;
        worker.postMessage({ cmd: 'loadModel', chunks, cfg: { name: ds.id, label: ds.label || ds.id, excludeStores: ds.excludeStores || [], rules: ds.rules || {} }, baseRules: { weeklyOtThreshold: { value: R.rules.weeklyOtThreshold.value } } });
      } catch (e) { reject(e); }
    });
    App.engineReady.catch(() => { App.engineReady = null; });
    return App.engineReady;
  }

  /** Worker messages that belong to filtering. Returns true when handled. */
  function filterMessage(m) {
    if (m.type === 'modelReady') { if (App._modelReady) App._modelReady(); return true; }
    if (m.type === 'filtered') {
      if (m.fid !== App.fid) return true;
      App.snap = null;
      showFiltered(m.result);
      return true;
    }
    if (m.type === 'progress' && m.stage === 'filter') { if (m.fid === App.fid) busy(`Recalculating for ${esc(App._fLabel || '')} — ${esc(m.msg)}…`); return true; }
    if (m.type === 'error' && (m.fid != null || /data model/.test(m.message || ''))) {
      if (m.fid == null && App._modelFail) App._modelFail(new Error(m.message));
      else if (m.fid === App.fid) busy(esc(m.message), 'err');
      return true;
    }
    return false;
  }

  function showFiltered(R) {
    App.result = R;
    busy(null);
    rerender();
  }

  async function applyFilter(f) {
    if (!App.base) return;
    const dp = App.base.result.meta.dataPeriod;
    f = { stores: f.stores && f.stores.length ? f.stores.slice().sort() : null, from: f.from != null ? Math.max(f.from, dp.start) : null, to: f.to != null ? Math.min(f.to, dp.end) : null };
    if (f.from != null && f.from <= dp.start) f.from = null;
    if (f.to != null && f.to >= dp.end) f.to = null;
    App.filter = f;
    const fid = ++App.fid;
    buildFilterBar();
    if (isDefault(f)) {
      App.snap = App.base.snap;
      if (App.worker && !App.base.snap) App.worker.postMessage({ cmd: 'useBase' });
      showFiltered(App.base.result);
      return;
    }
    const R = App.base.result;
    App._fLabel = (f.stores ? (f.stores.length === 1 ? 'Store ' + (R.meta.storeNames[f.stores[0]] || f.stores[0]) : f.stores.length + ' stores') : 'Organization') + ', ' + fmtRange(f.from != null ? f.from : dp.start, f.to != null ? f.to : dp.end);
    busy(`Recalculating for ${esc(App._fLabel)}…`);
    try {
      await ensureFilterEngine();
      if (fid !== App.fid) return;
      busy(`Recalculating for ${esc(App._fLabel)}…`);
      App.worker.postMessage({ cmd: 'filter', filter: { stores: f.stores, from: f.from, to: f.to }, fid });
    } catch (e) {
      if (fid === App.fid) busy(esc(e.message), 'err');
    }
  }
  App.applyFilter = applyFilter;
  App.isFiltered = () => !!(App.base && App.result && App.result !== App.base.result);

  function rerender() {
    syncChrome();
    App.rendered.clear();
    G.UI.destroyCharts();
    for (const v of $$('section.view')) if (v.id !== 'v-dataset') v.innerHTML = '';
    const R = App.result;
    let view = App.current === 'dataset' ? 'overview' : App.current, params = App.params || {};
    // Keep a store drill-down only if that store is still in scope; employee drill-downs re-query in scope.
    if (params.s && !R.stores.some((x) => x.s === params.s)) params = {};
    if (params.g && !R.employees.some((x) => x.g === params.g)) params = {};
    if (params.open) params = {};
    show(view, params, true);
  }

  // ---------- navigation ----------
  function show(view, params, force) {
    if (view !== 'dataset' && !App.result) view = 'dataset';
    App.current = view;
    App.params = params || {};
    $('#fbar').hidden = view === 'dataset' || !App.base;
    for (const b of $$('#nav button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
    for (const s of $$('section.view')) s.hidden = s.id !== 'v-' + view;
    const el = $('#v-' + view);
    if (view !== 'dataset') {
      const key = view + JSON.stringify(App.params);
      if (force || !App.rendered.has(key) || Object.keys(App.params).length) {
        G.UI.destroyCharts(el);
        el.innerHTML = '';
        try { VIEWS[view](el, App.result, App.params); } catch (e) { console.error(e); el.innerHTML = `<div class="msg err">This view could not be rendered: ${esc(e.message)}</div>`; }
        App.rendered.add(key);
      }
    }
    window.scrollTo({ top: 0 });
  }
  App.go = show;
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) show(b.dataset.view); });

  loadManifest();
  refreshSelection();
})(window);
