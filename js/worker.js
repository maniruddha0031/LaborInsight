/*
 * worker.js — runs the analysis engine off the UI thread.
 * The page creates a NEW worker for every dataset, so no state from a previous dataset can leak in.
 * Served over http it loads the engine with importScripts; opened from disk the page starts it from
 * js/engine.bundle.js (engine + this file as one Blob), where LCI is already defined.
 *
 * in : {cmd:'analyze', source:{kind:'urls', urls:[…], sizes:[…]} | {kind:'file', file}, cfg}
 *      {cmd:'loadModel', chunks:[base64…], cfg, baseRules}   portable model from a snapshot
 *      {cmd:'filter', filter:{stores, from, to}}               re-run the analysis for a scope
 *      {cmd:'useBase'}                                         drill-downs answer from the full analysis again
 *      {cmd:'query', qid, q}
 * out: {type:'progress', pct, msg, stage} · {type:'result', result} · {type:'filtered', result, fid}
 *      {type:'modelReady'} · {type:'error', message, files, fid} · {type:'query', qid, data}
 */
/* global importScripts, LCI */
let ctx = null;      // context of the result currently shown (drill-down queries use it)
let base = null;     // { M0, cfg, rules } — the full normalised model that filters slice
let baseCtx = null;  // context of the full-period, all-stores analysis (when computed in this worker)
let ready = null;

function load() {
  if (self.LCI && self.LCI.pipeline) return Promise.resolve();
  if (!ready) {
    ready = fetch('engine/files.json').then((r) => {
      if (!r.ok) throw new Error('Engine file list not found (js/engine/files.json).');
      return r.json();
    }).then((files) => {
      importScripts('../lib/fflate.min.js');
      importScripts(...files.map((f) => 'engine/' + f));
    });
  }
  return ready;
}

const post = (m) => self.postMessage(m);

async function* streamOf(readable) {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally { reader.releaseLock(); }
}

const STEPS = ['Normalising records and checking data quality', 'Matching punches to schedules by GEID', 'Analysing overtime',
  'Analysing punch edits, manual entries and punch methods', 'Checking breaks, minors and labor exceptions',
  'Calculating monthly sales and labor efficiency', 'Building summaries and trends', 'Detecting employee behaviour patterns', 'Generating findings and recommendations'];

async function analyze(source, cfg) {
  await load();
  const ing = new LCI.Ingestor(cfg);
  const parts = [];
  if (source.kind === 'urls') {
    for (let i = 0; i < source.urls.length; i++) parts.push({ name: source.urls[i], size: (source.sizes || [])[i] || 0, open: async () => {
      const res = await fetch(source.urls[i]);
      if (!res.ok) throw new Error(`Could not load ${source.urls[i]} (HTTP ${res.status}). Check the path in datasets/manifest.json.`);
      const len = +res.headers.get('content-length') || 0;
      if (len && !parts[i].size) parts[i].size = len;
      return res.body;
    } });
  } else {
    parts.push({ name: source.file.name, size: source.file.size, open: async () => source.file.stream() });
  }
  let total = parts.reduce((s, p) => s + (p.size || 0), 0);
  let doneBytes = 0;
  let lastPost = 0;
  for (const p of parts) {
    const body = await p.open();
    total = parts.reduce((s, x) => s + (x.size || 0), 0) || total;
    await LCI.pipeline.readZip(streamOf(body), ing, ({ bytes, file }) => {
      const now = Date.now();
      if (now - lastPost < 120) return;
      lastPost = now;
      const pct = total ? ((doneBytes + bytes) / total) : 0;
      post({ type: 'progress', stage: 'read', pct: Math.min(0.99, pct) * 0.75, msg: `Reading ${file.split('/').pop()}` });
    });
    doneBytes += p.size || 0;
  }
  post({ type: 'progress', stage: 'read', pct: 0.75, msg: `Read ${ing.files.length} files` });
  const out = LCI.pipeline.analyse(ing, cfg, ({ msg }) => {
    const i = Math.max(0, STEPS.indexOf(msg));
    post({ type: 'progress', stage: 'analyse', pct: 0.75 + 0.25 * (i / STEPS.length), msg });
  });
  ctx = baseCtx = out.ctx;
  base = { M0: ctx.M0, cfg, rules: ctx.R };
  return out.result;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.cmd === 'analyze') {
    try {
      const result = await analyze(m.source, m.cfg || {});
      post({ type: 'result', result });
    } catch (err) {
      post({ type: 'error', message: err && err.message ? err.message : String(err), files: err && err.files ? err.files.map((f) => ({ name: f.name, label: f.label, rows: f.rows, notes: f.notes })) : null });
    }
  } else if (m.cmd === 'loadModel') {
    try {
      await load();
      const M0 = LCI.scope.unpackModel(m.chunks);
      base = { M0, cfg: m.cfg || {}, rules: m.baseRules || null };
      post({ type: 'modelReady' });
    } catch (err) {
      post({ type: 'error', message: 'Could not load the data model for filtering: ' + (err && err.message ? err.message : String(err)) });
    }
  } else if (m.cmd === 'filter') {
    try {
      if (!base) throw new Error('No dataset is loaded for filtering.');
      const out = LCI.pipeline.analyseFiltered(base.M0, base.cfg, m.filter, base.rules, ({ msg }) => {
        const i = Math.max(0, STEPS.indexOf(msg));
        post({ type: 'progress', stage: 'filter', pct: i / STEPS.length, msg, fid: m.fid });
      });
      ctx = out.ctx;
      post({ type: 'filtered', result: out.result, fid: m.fid });
    } catch (err) {
      post({ type: 'error', message: err && err.message ? err.message : String(err), fid: m.fid });
    }
  } else if (m.cmd === 'useBase') {
    ctx = baseCtx;
  } else if (m.cmd === 'query') {
    try {
      post({ type: 'query', qid: m.qid, data: ctx ? LCI.present.query(ctx, m.q) : null });
    } catch (err) {
      post({ type: 'query', qid: m.qid, error: err.message });
    }
  }
};
