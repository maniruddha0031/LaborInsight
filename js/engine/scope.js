/*
 * scope.js — analysis scope (organisation / store(s) × date range) and the portable data model.
 *
 * filterModel(M0, filter) slices the normalised model to the selected stores and business days and
 * rebuilds everything date-dependent (period, months, sales months, previous comparable period).
 * The full analysis — including every insight — is then re-run on that slice, so a finding can only
 * come from records inside the selected scope.
 *
 * Sales are monthly: a month counts for sales KPIs only when the range covers every day of data the
 * dataset has for that month. Partial months are excluded from sales / Labor %, never prorated.
 *
 * encodeModel / decodeModel turn the model into a compact JSON-able object (columnar, dictionary-encoded
 * strings) so a pre-computed dataset can ship it and filters work without re-reading the ZIP.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;

  const LISTS = ['schedule', 'punches', 'approvals', 'breaks', 'auditManual', 'auditEdits', 'violations', 'premium', 'misc', 'excPunch'];

  function monthsFor(from, to, dataMonthDays) {
    const months = [];
    for (let d = from; d <= to; d++) {
      const mk = U.monthKey(d);
      if (!months.length || months[months.length - 1].key !== mk) months.push({ key: mk, first: d, last: d, days: 0 });
      const m = months[months.length - 1]; m.last = d; m.days++;
    }
    for (const m of months) {
      const p = U.dateParts(m.first);
      m.calDays = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
      m.dataDays = dataMonthDays[m.key] || m.calDays;
      m.partial = m.days < m.calDays;
      m.fullForData = m.days >= m.dataDays; // every day of data in this month is selected
      m.label = new Date(m.first * 86400000).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ' + p.y;
    }
    return months;
  }

  /** Pay by store × month over the whole dataset (for previous-period Labor % comparisons). */
  function storeMonthPay(M0) {
    if (M0._storeMonthPay) return M0._storeMonthPay;
    const o = {};
    for (const p of M0.punches) { const k = p.s + '|' + U.monthKey(p.day); o[k] = (o[k] || 0) + (isFinite(p.pay) ? p.pay : 0); }
    return (M0._storeMonthPay = o);
  }

  function filterModel(M0, f) {
    f = f || {};
    const stores = f.stores && f.stores.length ? new Set(f.stores) : null;
    const from = Math.max(f.from != null ? f.from : M0.period.start, M0.period.start);
    const to = Math.min(f.to != null ? f.to : M0.period.end, M0.period.end);
    if (from > to) throw new Error('The selected dates are outside the data, which covers ' + M0.period.startIso + ' to ' + M0.period.endIso + '.');
    const ok = (r) => (!stores || stores.has(r.s)) && r.day >= from && r.day <= to;
    const M = Object.assign({}, M0);
    for (const k of LISTS) M[k] = (M0[k] || []).filter(ok);
    const dataMonthDays = {};
    for (const m of M0.months) dataMonthDays[m.key] = m.days;
    M.dataMonthDays = dataMonthDays;
    M.period = { start: from, end: to, startIso: U.isoDay(from), endIso: U.isoDay(to) };
    M.months = monthsFor(from, to, dataMonthDays);
    M.salesMonths = M.months.filter((m) => m.fullForData).map((m) => m.key);
    // Previous comparable period: the same number of full months immediately before.
    const allKeys = M0.months.map((m) => m.key);
    const first = allKeys.indexOf(M.salesMonths[0]);
    M.prevSalesMonths = M.salesMonths.length && first >= M.salesMonths.length ? allKeys.slice(first - M.salesMonths.length, first) : [];
    M.allSales = Object.fromEntries(M0.sales.map((a) => [a.s + '|' + a.month, a]));
    M.storeMonthPay = storeMonthPay(M0);
    M.storeFilter = stores;
    const inS = new Set(M.schedule.map((r) => r.g)), inP = new Set(M.punches.map((r) => r.g));
    M.geidCoverage = { punch: inP.size, sched: inS.size, punchOnly: [...inP].filter((g) => !inS.has(g)).length, schedOnly: [...inS].filter((g) => !inP.has(g)).length };
    const all = !stores && from === M0.period.start && to === M0.period.end;
    const storeList = stores ? [...stores] : null;
    M.scope = {
      all, kind: !stores ? 'org' : stores.size === 1 ? 'store' : 'stores', stores: storeList,
      storeLabel: !stores ? 'Organization' : stores.size === 1 ? 'Store ' + (M0.storeName[storeList[0]] || storeList[0]) : stores.size + ' stores',
      from, to, fromIso: U.isoDay(from), toIso: U.isoDay(to), full: from === M0.period.start && to === M0.period.end,
      dataStart: M0.period.startIso, dataEnd: M0.period.endIso,
    };
    M.quality = M0.quality.slice();
    const partial = M.months.filter((m) => !m.fullForData);
    if (partial.length && !all) M.quality.push({ level: 'info', area: 'Scope', msg: `${partial.map((m) => m.label).join(', ')} ${partial.length > 1 ? 'are' : 'is'} only partly inside the selected dates. Hours, punches and costs use the selected days; sales, SPLH and Labor % use complete months only (monthly sales are not prorated).`, count: partial.length });
    if (!M.punches.length) throw new Error('No paid punches fall inside the selected stores and dates. Choose a wider range or another store.');
    return M;
  }

  // ---------------- portable model ----------------
  function encList(list) {
    if (!list || !list.length) return { c: [], t: [], d: [], r: [] };
    const keys = new Set();
    for (let i = 0; i < Math.min(list.length, 500); i++) for (const k in list[i]) keys.add(k);
    for (const x of list) for (const k in x) if (!keys.has(k)) keys.add(k);
    const c = [...keys];
    const t = c.map((k) => { for (const x of list) { const v = x[k]; if (v == null) continue; if (typeof v === 'number' && !isFinite(v)) continue; return typeof v === 'string' ? 's' : typeof v === 'boolean' ? 'b' : typeof v === 'number' ? 'n' : 'j'; } return 'n'; });
    const dicts = c.map(() => new Map());
    const d = c.map(() => []);
    const r = list.map((x) => c.map((k, i) => {
      const v = x[k];
      if (t[i] === 's') { if (v == null) return -1; let ix = dicts[i].get(v); if (ix === undefined) { ix = d[i].length; dicts[i].set(v, ix); d[i].push(v); } return ix; }
      // Full precision: the portable model must reproduce results exactly.
      if (t[i] === 'n') return typeof v === 'number' && isFinite(v) ? v : null;
      if (t[i] === 'b') return v ? 1 : 0;
      return v === undefined ? null : v;
    }));
    return { c, t, d, r };
  }
  function decList(e) {
    const { c, t, d, r } = e;
    if (!c.length) return [];
    // One compiled row builder per list: a fixed-shape object literal is far faster than assigning
    // keys one by one (decoding ~1.4 M rows).
    const body = 'return {' + c.map((k, i) => {
      const v = 'row[' + i + ']';
      const expr = t[i] === 's' ? `(${v} < 0 ? undefined : d[${i}][${v}])` : t[i] === 'n' ? `(${v} === null ? NaN : ${v})` : t[i] === 'b' ? `!!${v}` : v;
      return JSON.stringify(k) + ':' + expr;
    }).join(',') + '};';
    const build = new Function('row', 'd', body);
    const out = new Array(r.length);
    for (let i = 0; i < r.length; i++) out[i] = build(r[i], d);
    return out;
  }

  function encodeModel(M) {
    const o = { v: 1, lists: {} };
    for (const k of LISTS) o.lists[k] = encList(M[k]);
    o.sales = encList(M.sales.map((a) => ({ s: a.s, month: a.month, fs: a.fs, as: a.as, fh: a.fh, sh: a.sh, ah: a.ah, ih: a.ih, txn: a.txn, neg: a.neg, rows: a.rows,
      nDays: a.nDays != null ? a.nDays : Object.keys(a.days || {}).length, nSalesDays: a.nSalesDays != null ? a.nSalesDays : Object.keys(a.salesDays || {}).length })));
    o.period = M.period; o.months = M.months; o.storeName = M.storeName; o.excluded = M.excluded; o.excludedKeys = [...M.excludedKeys];
    o.auditMethod = [...M.auditMethod]; o.auditEmpMethod = [...M.auditEmpMethod];
    o.breakAudit = Object.assign({}, M.breakAudit, { byEditor: [...M.breakAudit.byEditor] });
    o.files = M.files; o.recordCounts = M.recordCounts; o.quality = M.quality; o.geidCoverage = M.geidCoverage; o.noSalesStores = M.noSalesStores;
    o.emps = [...M.emps.values()];
    return o;
  }
  function decodeModel(o) {
    const M = {};
    for (const k of LISTS) M[k] = decList(o.lists[k]);
    M.sales = decList(o.sales);
    M.period = o.period; M.months = o.months; M.storeName = o.storeName; M.excluded = o.excluded; M.excludedKeys = new Set(o.excludedKeys);
    M.auditMethod = new Map(o.auditMethod); M.auditEmpMethod = new Map(o.auditEmpMethod); M.auditEditor = new Map();
    M.breakAudit = Object.assign({}, o.breakAudit, { byEditor: new Map(o.breakAudit.byEditor) });
    M.files = o.files; M.recordCounts = o.recordCounts; M.quality = o.quality; M.geidCoverage = o.geidCoverage; M.noSalesStores = o.noSalesStores;
    M.emps = new Map(o.emps.map((e) => [e.geid, e]));
    return M;
  }

  /** Model → deflated base64 chunks (for snapshot script files). */
  function packModel(M, chunkChars) {
    const fl = G.fflate;
    const json = JSON.stringify(encodeModel(M));
    const z = fl.deflateSync(fl.strToU8(json), { level: 6 });
    let b64 = '';
    if (typeof Buffer !== 'undefined') b64 = Buffer.from(z).toString('base64');
    else { let s = ''; for (let i = 0; i < z.length; i += 32768) s += String.fromCharCode.apply(null, z.subarray(i, i + 32768)); b64 = btoa(s); }
    const n = chunkChars || 4 * 1024 * 1024;
    const chunks = [];
    for (let i = 0; i < b64.length; i += n) chunks.push(b64.slice(i, i + n));
    return { chunks, rawBytes: json.length, zBytes: z.length };
  }
  function unpackModel(chunks) {
    const fl = G.fflate;
    const b64 = chunks.join('');
    let u8;
    if (typeof Buffer !== 'undefined') u8 = new Uint8Array(Buffer.from(b64, 'base64'));
    else { const bin = atob(b64); u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); }
    return decodeModel(JSON.parse(fl.strFromU8(fl.inflateSync(u8))));
  }

  LCI.scope = { filterModel, encodeModel, decodeModel, packModel, unpackModel, monthsFor };
})(typeof globalThis !== 'undefined' ? globalThis : self);
