/*
 * present.js — shapes the analysis context into the JSON the UI renders, and answers drill-down queries.
 * The full context (every employee-day) stays inside the worker; the UI asks for details on demand.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;

  // Which part of the organisation owns each recommendation, and how fast it can move.
  const PLAN = {
    'over-plan': { group: 'Process & review', owner: 'Store managers / area coaches', horizon: 'Next payroll cycle' },
    unscheduled: { group: 'Clock settings', owner: 'Timekeeping admin', horizon: 'This week' },
    'late-out': { group: 'Clock settings', owner: 'Timekeeping admin + store managers', horizon: 'This week' },
    'early-in': { group: 'Clock settings', owner: 'Timekeeping admin + store managers', horizon: 'This week' },
    'meal-skip': { group: 'Clock settings', owner: 'Timekeeping admin / HR compliance', horizon: '2–4 weeks' },
    overtime: { group: 'Scheduling', owner: 'Schedulers / store managers', horizon: 'Next schedule publish' },
    'manual-time': { group: 'Process & review', owner: 'Operations', horizon: '2–4 weeks' },
    'edits-add': { group: 'Process & review', owner: 'Payroll / area coaches', horizon: 'Next payroll cycle' },
    'self-edits': { group: 'Clock settings', owner: 'Timekeeping admin', horizon: 'This week' },
    'shared-accounts': { group: 'Clock settings', owner: 'IT / timekeeping admin', horizon: '2–4 weeks' },
    'forgotten-out': { group: 'Clock settings', owner: 'Timekeeping admin', horizon: 'This week' },
    biometric: { group: 'Technology', owner: 'Operations / IT', horizon: 'Pilot in 1 quarter' },
    minors: { group: 'Data fixes', owner: 'HR', horizon: 'Immediately' },
    'pay-anomaly': { group: 'Data fixes', owner: 'Payroll', horizon: 'Before next payroll' },
    'payroll-id': { group: 'Data fixes', owner: 'HR / payroll', horizon: 'Before next payroll' },
    'sales-flex': { group: 'Scheduling', owner: 'Operations / finance', horizon: 'Monthly' },
    'forecast-anomaly': { group: 'Data fixes', owner: 'Forecasting owner', horizon: 'Before next schedule build' },
    'peer-splh': { group: 'Scheduling', owner: 'Operations', horizon: '1 quarter' },
    'edit-spike': { group: 'Data fixes', owner: 'Timekeeping provider', horizon: 'Investigate now' },
    concentration: { group: 'Process & review', owner: 'Store managers', horizon: 'Monthly' },
    persistent: { group: 'Process & review', owner: 'Area / district managers', horizon: 'Next 30 days' },
    'labor-rank': { group: 'Scheduling', owner: 'Operations / area managers', horizon: 'Monthly' },
    'leak-stores': { group: 'Process & review', owner: 'Area / district managers', horizon: 'Next 30 days' },
    'store-trend': { group: 'Process & review', owner: 'Area / district managers', horizon: 'Next 30 days' },
    'beh-manual': { group: 'Process & review', owner: 'Store managers / timekeeping admin', horizon: 'Next 2 weeks' },
    'beh-late': { group: 'Process & review', owner: 'Store managers', horizon: 'Next 2 weeks' },
    'beh-early': { group: 'Clock settings', owner: 'Store managers / timekeeping admin', horizon: 'This week' },
    'beh-overtime': { group: 'Scheduling', owner: 'Schedulers / store managers', horizon: 'Next schedule publish' },
    'beh-edits': { group: 'Process & review', owner: 'Payroll / area coaches', horizon: 'Next payroll cycle' },
    'beh-combined': { group: 'Process & review', owner: 'Store managers', horizon: 'Next 2 weeks' },
    'beh-store': { group: 'Process & review', owner: 'Area / district managers', horizon: 'Next 30 days' },
    'repeat-devs': { group: 'Process & review', owner: 'Store managers', horizon: 'Next 2 weeks' },
  };

  function accOut(a) {
    if (!a) return null;
    const o = {};
    for (const f of LCI.analysis.ACC_FIELDS) o[f] = a[f] || 0;
    return o;
  }

  LCI.present = {
    result(ctx) {
      const { M, R, ADH, OT, INT, CMP, SAL, F, stores, employees, TR, quality, insights, cfg } = ctx;
      for (const i of insights) i.plan = PLAN[i.id] || { group: 'Process & review', owner: 'Operations', horizon: '—' };
      const actions = insights.filter((i) => i.action).map((i) => ({ id: i.id, title: i.title, action: i.action, severity: i.severity, confidence: i.confidence, kind: i.kind,
        impact: i.impact, plan: i.plan }));
      return {
        meta: {
          name: cfg.name || 'Dataset', label: cfg.label || cfg.name || 'Dataset', generatedAt: new Date().toISOString(),
          period: M.period, months: M.months, storeCount: stores.length, employeeCount: employees.length,
          storeNames: M.storeName, excludedStores: M.excluded, scope: M.scope,
          dataPeriod: ctx.M0 ? ctx.M0.period : M.period, dataMonths: ctx.M0 ? ctx.M0.months.map((m) => ({ key: m.key, label: m.label, first: m.first, last: m.last })) : M.months,
          allStores: ctx.M0 ? [...new Set(ctx.M0.punches.map((p) => p.s))].sort() : stores.map((x) => x.s),
        },
        rules: Object.fromEntries(Object.entries(R).map(([k, v]) => [k, Object.assign({}, v)])),
        financials: F,
        quality,
        insights, actions,
        behavior: ctx.BEH ? { patterns: ctx.BEH.patterns, storeConc: ctx.BEH.storeConc, summary: ctx.BEH.summary, rules: ctx.BEH.rules, cats: Object.fromEntries(Object.entries(ctx.BEH.cats).map(([k, v]) => [k, v.label])), minOcc: ctx.BEH.minOcc } : null,
        stores, employees,
        trends: TR,
        adherence: {
          tot: accOut(ADH.tot), byDow: Object.fromEntries(Object.entries(ADH.byDow).map(([k, v]) => [k, accOut(v)])),
          byShift: Object.fromEntries(Object.entries(ADH.byShift).map(([k, v]) => [k, accOut(v)])),
          byMonth: Object.fromEntries(Object.entries(ADH.byMonth).map(([k, v]) => [k, accOut(v)])),
          bySource: ADH.bySource, recon: ADH.recon, schedCheck: ADH.schedCheck, longPunches: ADH.longPunches, openPunches: ADH.openPunches,
          coverage: ADH.coverage,
          storeMonth: Object.fromEntries(Object.entries(ADH.byStoreMonth).map(([k, v]) => [k, { act: v.act, sch: v.sch, overPlan: v.overPlan, cOverPlan: v.cOverPlan, cAvoid: v.cAvoid, early: v.early, late: v.late, unsch: v.unsch, cAct: v.cAct }])),
        },
        overtime: {
          threshold: OT.threshold, consistency: OT.thresholdConsistency, tot: OT.tot, byMonth: OT.byMonth, multiStore: OT.multiStoreOt, noOtByJob: OT.noOtByJob,
          truncatedLastWeek: OT.truncatedLastWeek, noPremium: OT.noPremium,
          storeMonth: OT.byStoreMonth,
          topWeeks: OT.weeks.slice().sort((a, b) => b.prem - a.prem).slice(0, 200).map((w) => ({ g: w.g, week: U.isoDay(w.week), store: w.store, paid: w.paid, sched: w.sched, ot: w.ot + w.dt, prem: w.prem, schedOt: w.schedOt, driftOt: w.driftOt, multi: w.multiStore })),
        },
        integrity: {
          tot: INT.tot, quarter: INT.quarter, bySrc: INT.bySrc, byMonth: INT.byMonth,
          manual: INT.manual, methods: INT.methods, methodByMonth: INT.methodByMonth, biometric: INT.biometric,
          approvals: INT.approvals, editors: INT.editors.slice(0, 300), editorCount: INT.editors.length, editorConc: INT.editorConc,
          spikes: INT.spikes.map((s) => ({ day: U.isoDay(s.day), n: s.n })), editMedianPerDay: INT.editMedianPerDay,
          storeSpikes: INT.storeSpikes.map((s) => ({ s: s.s, day: U.isoDay(s.day), n: s.n })),
          hasAudit: M.files.some((f) => f.type === 'punchAudit'), hasApproval: M.files.some((f) => f.type === 'approval'),
        },
        compliance: {
          breaks: CMP.breaks, minors: CMP.minors, premium: CMP.premium,
          exceptions: { byType: CMP.exceptions.byType, byMonthType: CMP.exceptions.byMonthType, authPunches: CMP.exceptions.authPunches, punches: CMP.exceptions.punches,
            breakTypesFlagged: CMP.exceptions.breakTypesFlagged, topMgr: Object.entries(CMP.exceptions.authByMgr).sort((a, b) => b[1] - a[1]).slice(0, 15) },
        },
        sales: SAL.available ? { available: true, granularity: 'monthly', byMonth: SAL.byMonth, perStore: SAL.perStore, table: SAL.table, tierMed: SAL.tierMed, tierCuts: SAL.tierCuts, recon: SAL.recon, tot: SAL.tot, laborRank: SAL.laborRank, partialMonths: SAL.partialMonths, salesMonths: SAL.salesMonths } : SAL,
      };
    },

    /** Lazily built lookup tables so each drill-down is O(rows of that employee/store). */
    index(ctx) {
      if (ctx._index) return ctx._index;
      const by = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(x); } return m; };
      ctx._index = {
        daysByG: by(ctx.ADH.days, (d) => d.g), daysByS: by(ctx.ADH.days, (d) => d.s),
        editsByG: by(ctx.INT.editedList, (e) => e.g), weeksByG: by(ctx.OT.weeks, (w) => w.g),
        empByG: new Map(ctx.employees.map((e) => [e.g, e])), empsByS: by(ctx.employees, (e) => e.store),
      };
      return ctx._index;
    },

    /**
     * Pre-computed analysis for instant display (tools/build-snapshot.js).
     * Returns the UI payload plus every drill-down answer, split into shards so the page only
     * loads the slice it needs: employees by GEID hash, stores in one shard, records inline.
     */
    snapshot(ctx, result, empShards) {
      const shardOf = LCI.present.shardOf;
      const n = empShards || 64;
      const shards = { stores: {} };
      for (let i = 0; i < n; i++) shards['emp' + i] = {};
      // Day rows are packed as {c: column names, r: value rows} — field names repeated per row were most of the size.
      const pack = (rows) => { if (!rows.length) return { c: [], r: [] }; const c = Object.keys(rows[0]).filter((k) => k !== 'rate'); return { c, r: rows.map((x) => c.map((k) => (x[k] === '' ? 0 : x[k]))) }; };
      for (const e of ctx.employees) {
        const d = LCI.present.query(ctx, { type: 'employee', g: e.g });
        d.days = pack(d.days);
        shards['emp' + shardOf(e.g, n)][e.g] = d;
      }
      for (const s of ctx.stores) shards.stores[s.s] = LCI.present.query(ctx, { type: 'store', s: s.s });
      const inline = {
        longPunches: LCI.present.query(ctx, { type: 'records', key: 'longPunches' }),
        rateOutliers: LCI.present.query(ctx, { type: 'records', key: 'rateOutliers' }),
        spikes: LCI.present.query(ctx, { type: 'records', key: 'spikes' }),
      };
      return { result, inline, shards, empShards: n };
    },
    /** Stable shard number for a GEID (same function used by the page to find it). */
    shardOf(key, n) { let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0; return h % n; },

    /** Drill-down queries answered from the full context. */
    query(ctx, q) {
      const { M, ADH, OT, INT, SAL, stores, employees, R } = ctx;
      const X = LCI.present.index(ctx);
      if (q.type === 'employee') {
        const g = q.g;
        const emp = X.empByG.get(g);
        const m = M.emps.get(g) || {};
        const a = ADH.byEmp[g];
        const days = (X.daysByG.get(g) || []).slice().sort((x, y) => x.day - y.day).map((d) => ({
          date: U.isoDay(d.day), dow: U.DOW[d.dow], store: M.storeName[d.s] || d.s,
          sched: isFinite(d.bS) ? U.isoTs(d.bS).slice(11) + '–' + U.isoTs(d.bE).slice(11) : '', schMin: d.sch,
          actual: isFinite(d.firstIn) ? U.isoTs(d.firstIn).slice(11) + '–' + U.isoTs(d.lastOut).slice(11) : '', actMin: d.act,
          early: d.early, late: d.late, unsch: d.unsch, mealSkip: d.mealSkip, lateIn: d.lateIn, earlyOut: d.earlyOut, noShow: d.noShow, avoid: d.cAvoid, rate: d.rate,
        }));
        const edits = (X.editsByG.get(g) || []).map((e) => ({ date: U.isoDay(e.day), store: M.storeName[e.s] || e.s, orig: U.isoTs(e.inO).slice(11) + '–' + (isFinite(e.outO) ? U.isoTs(e.outO).slice(5) : '—'), adj: U.isoTs(e.inA).slice(11) + '–' + U.isoTs(e.outA).slice(5), net: e.net, snap: e.snap, forgot: e.forgot, src: e.src }));
        const weeks = (X.weeksByG.get(g) || []).map((w) => ({ week: U.isoDay(w.week), paid: w.paid, sched: w.sched, ot: w.ot + w.dt, prem: w.prem, schedOt: w.schedOt, driftOt: w.driftOt }));
        const months = M.months.map((mm) => { const x = a && a.months[mm.key]; return { month: mm.key, label: mm.label, act: x ? x.act : 0, sch: x ? x.sch : 0, early: x ? x.early : 0, late: x ? x.late : 0, unsch: x ? x.unsch : 0, mealSkip: x ? x.mealSkip : 0, avoid: x ? x.cAvoid : 0 }; });
        return { emp, master: { geid: g, name: m.name, altNames: m.altNames, stores: (m.stores || []).map((s) => M.storeName[s] || s), job: m.job, age: m.minAge, timecardMismatch: m.timecardMismatch }, days, edits, weeks, months, manual: INT.manual.byEmp[g] || null, patterns: ctx.BEH ? ctx.BEH.patterns.filter((p) => p.g === g) : [] };
      }
      if (q.type === 'store') {
        const s = q.s;
        const row = stores.find((x) => x.s === s);
        const months = M.months.map((mm) => {
          const a = ADH.byStoreMonth[s + '|' + mm.key] || {}, o = OT.byStoreMonth[s + '|' + mm.key] || {};
          const sl = SAL.available ? SAL.table.find((x) => x.s === s && x.month === mm.key) : null;
          return { month: mm.key, label: mm.label, act: a.act || 0, sch: a.sch || 0, overPlan: a.overPlan || 0, cOverPlan: a.cOverPlan || 0, early: a.early || 0, late: a.late || 0, unsch: a.unsch || 0, mealSkip: a.mealSkip || 0,
            avoid: (a.cAvoid || 0) + (o.premDrift || 0), otPrem: o.prem || 0, sales: sl ? sl.as : NaN, fcst: sl ? sl.fs : NaN, splh: sl ? sl.splh : NaN, laborPct: sl ? sl.laborPct : NaN };
        });
        const dow = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dow: U.DOW[d], act: 0, sch: 0, early: 0, late: 0, unsch: 0 }));
        const shift = {};
        for (const d of X.daysByS.get(s) || []) {
          const w = dow[d.dow]; w.act += d.act; w.sch += d.sch; w.early += d.early; w.late += d.late; w.unsch += d.unsch;
          const t = (shift[d.shiftType] = shift[d.shiftType] || { act: 0, early: 0, late: 0 }); t.act += d.act; t.early += d.early; t.late += d.late;
        }
        const emps = (X.empsByS.get(s) || []).slice().sort((a, b) => b.avoid - a.avoid).slice(0, 60);
        const editors = INT.editors.filter((e) => e.topStore === s).slice(0, 15);
        return { row, months, dow, shift, emps, editors, sales: SAL.available ? SAL.perStore.find((x) => x.s === s) : null };
      }
      if (q.type === 'records' && q.key === 'longPunches') {
        return M.punches.filter((p) => p.tot >= R.autoClosePunch.value).sort((a, b) => b.tot - a.tot).slice(0, 500)
          .map((p) => ({ g: p.g, name: (M.emps.get(p.g) || {}).name, store: M.storeName[p.s] || p.s, date: U.isoDay(p.day), in: U.isoTs(p.inA), out: U.isoTs(p.outA), hours: p.tot / 60, pay: p.pay, src: p.src }));
      }
      if (q.type === 'records' && q.key === 'rateOutliers') {
        return ADH.rateOutliers.slice().sort((a, b) => b.rate - a.rate).map((p) => ({ g: p.g, name: (M.emps.get(p.g) || {}).name, store: M.storeName[p.s] || p.s, date: U.isoDay(p.day),
          job: p.job, rate: p.rate, normal: ADH.empRate.get(p.g), hours: p.tot / 60, pay: p.pay, src: p.src }));
      }
      if (q.type === 'records' && q.key === 'spikes') {
        const days = new Set(INT.spikes.map((x) => x.day));
        const by = {};
        for (const a of M.approvals) if (days.has(a.day)) { const k = U.isoDay(a.day) + '|' + a.s; by[k] = (by[k] || 0) + 1; }
        return Object.entries(by).map(([k, n]) => { const [d, s] = k.split('|'); return { date: d, store: M.storeName[s] || s, edits: n }; }).sort((a, b) => b.edits - a.edits).slice(0, 300);
      }
      if (q.type === 'storeMonths') {
        const set = new Set(q.rows);
        return SAL.available ? SAL.table.filter((x) => set.has(x.s + '|' + x.month)).map((x) => Object.assign({ name: M.storeName[x.s] || x.s }, x)) : [];
      }
      return null;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
