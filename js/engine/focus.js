/*
 * focus.js — finding-specific ("contextual") drill-downs.
 *
 * Each finding has a lens: the exact records that make up that finding. A drill-down from a finding to a
 * store, and from there to an employee, shows only that lens's records — never the store's or employee's
 * other issues. Totals are summed from the same records the finding uses, so they reconcile:
 *   Σ employees in a store = the store's figure, Σ stores = the organization figure
 * (exceptions are labelled: "paid above schedule" is netted per store-day, so employee contributions are
 * shown before netting; overtime follows the week's main store, as in the overtime finding).
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;

  // Finding id → lens. Findings not listed fall back to 'avoid' (estimated avoidable cost).
  const BY_FINDING = {
    'over-plan': 'overplan', persistent: 'overplan', 'store-trend': 'overplan',
    unscheduled: 'unsch',
    'late-out': 'late', 'beh-late': 'late',
    'early-in': 'early', 'beh-early': 'early',
    'meal-skip': 'meal',
    overtime: 'ot', 'beh-overtime': 'ot',
    'manual-time': 'manual', 'beh-manual': 'manual', biometric: 'manual',
    'edits-add': 'edits', 'beh-edits': 'edits', 'self-edits': 'edits', 'shared-accounts': 'edits', 'edit-spike': 'edits',
    'forgotten-out': 'long', minors: 'minor', 'payroll-id': 'payrollid', 'pay-anomaly': 'rate',
    concentration: 'avoid', 'leak-stores': 'avoid', 'repeat-devs': 'avoid', 'beh-combined': 'avoid', 'beh-store': 'avoid',
    'labor-rank': 'labor', 'sales-flex': 'labor', 'peer-splh': 'labor', 'forecast-anomaly': 'labor',
  };

  const LENS = {
    overplan: { label: 'Paid hours above schedule', unit: 'days', metric: 'Hours above schedule', cat: 'combined' },
    unsch: { label: 'Unscheduled shifts', unit: 'days', metric: 'Unscheduled hours' },
    early: { label: 'Early clock-ins', unit: 'days', metric: 'Early clock-in', cat: 'early' },
    late: { label: 'Late clock-outs', unit: 'days', metric: 'Late clock-out', cat: 'late' },
    meal: { label: 'Meal breaks', unit: 'days', metric: 'Planned meal worked' },
    ot: { label: 'Overtime', unit: 'weeks', metric: 'Overtime hours', cat: 'overtime' },
    manual: { label: 'Manual punches', unit: 'days', metric: 'Manual punch hours', cat: 'manual' },
    edits: { label: 'Punch edits', unit: 'edits', metric: 'Paid time changed', cat: 'edits' },
    long: { label: 'Forgotten clock-outs (14 h+ punches)', unit: 'punches', metric: 'Paid hours' },
    minor: { label: 'Minors not flagged as minors', unit: 'punches', metric: 'Paid hours' },
    payrollid: { label: 'Punches without Payroll ID', unit: 'punches', metric: 'Paid hours' },
    rate: { label: 'Pay-rate anomalies', unit: 'punches', metric: 'Paid hours' },
    avoid: { label: 'Estimated avoidable cost', unit: 'days', metric: 'Avoidable time', cat: 'combined' },
    labor: { label: 'Labor cost and Labor %', unit: 'days', metric: 'Paid hours' },
  };

  const hm = (t) => (isFinite(t) ? U.isoTs(t).slice(11) : '');
  const ts = (t) => (isFinite(t) ? U.isoTs(t) : '');
  const r2 = (v) => v; // full precision; the UI rounds for display so totals reconcile exactly

  /** Manual punch audit entries per employee-day: which side (clock-in / clock-out) was keyed in, and how long after. */
  function manualIO(ctx) {
    if (ctx._manIO) return ctx._manIO;
    const m = new Map();
    for (const a of ctx.M.auditManual || []) { const k = a.g + '|' + a.day; let x = m.get(k); if (!x) m.set(k, (x = { in: 0, out: 0, lagMax: NaN, editor: '' })); if (a.isIn) x.in++; else x.out++; if (isFinite(a.lag) && !(a.lag <= x.lagMax)) x.lagMax = a.lag; if (a.editor && !x.editor) x.editor = a.editor; }
    return (ctx._manIO = m);
  }
  const ioLabel = (x) => (!x ? '' : x.in && x.out ? 'Clock-in & clock-out' : x.in ? 'Clock-in' : x.out ? 'Clock-out' : '');

  /** All records of a lens, optionally limited to a store and/or employee. */
  function records(ctx, lens, s, g) {
    const { M, R, ADH, OT, INT } = ctx;
    const tol = R.punchTolerance.value, viol = R.punchViolation.value;
    const keep = (x) => (!s || x.s === s) && (!g || x.g === g);
    const out = [];
    const dayRow = (d, min, cost, issue) => ({
      g: d.g, s: d.s, day: d.day, date: U.isoDay(d.day), dow: U.DOW[d.dow],
      schedStart: hm(d.bS), schedEnd: hm(d.bE), clockIn: hm(d.firstIn), clockOut: hm(d.lastOut),
      schMin: d.sch, actMin: d.act, min, cost: r2(cost), issue,
    });
    if (['overplan', 'unsch', 'early', 'late', 'meal', 'manual', 'avoid', 'labor'].includes(lens)) {
      const bIdx = ADH._idx.bIdx, need = R.mealRequiredAfter.value;
      for (const d of ADH.days) {
        if (!keep(d) || !d.nP && lens !== 'overplan') continue;
        const rate = isFinite(d.rate) ? d.rate : 0;
        if (lens === 'overplan') {
          const x = d.act - d.sch;
          if (x > 0) out.push(dayRow(d, x, (x / 60) * rate, d.sch ? `Paid ${(d.act / 60).toFixed(2)} h vs ${(d.sch / 60).toFixed(2)} h scheduled` : 'Worked with no scheduled shift'));
        } else if (lens === 'unsch' && d.unsch > 0) out.push(dayRow(d, d.unsch, d.cUnsch, d.nBlocks ? 'Shift outside the scheduled block' : 'Worked with no scheduled shift that day'));
        else if (lens === 'early' && d.early > 0) out.push(dayRow(d, d.early, d.cEarly, `Clocked in ${Math.round(d.early)} min before the scheduled start${d.early > viol ? ` — beyond the ${viol}-min violation threshold` : d.early > tol ? ` — beyond the ${tol}-min tolerance` : ' — within tolerance'}`));
        else if (lens === 'late' && d.late > 0) out.push(dayRow(d, d.late, d.cLate, `Clocked out ${Math.round(d.late)} min after the scheduled end${d.late > viol ? ` — beyond the ${viol}-min violation threshold` : d.late > tol ? ` — beyond the ${tol}-min tolerance` : ' — within tolerance'}`));
        else if (lens === 'meal') {
          const meals = (bIdx.get(d.g + '|' + d.day) || []).filter((b) => b.kind === 'M');
          const missed = d.act > need && !meals.length;
          if (d.mealSkip > 0 || missed) out.push(Object.assign(dayRow(d, d.mealSkip, d.cMealSkip, [d.mealSkip > 0 ? `Worked through ${Math.round(d.mealSkip)} min of a planned unpaid meal` : '', missed ? `No meal break recorded on a ${(d.act / 60).toFixed(1)} h shift` : ''].filter(Boolean).join(' · ')), { worked: d.mealSkip > 0, missed }));
        } else if (lens === 'manual' && d.manN > 0) out.push(Object.assign(dayRow(d, d.manMin, d.cManExtra || 0, `${d.manN} manual punch${d.manN > 1 ? 'es' : ''}${(d.manEarly || 0) + (d.manLate || 0) + (d.manUnsch || 0) > 0 ? ` · keyed-in time outside schedule: ${[['early', d.manEarly], ['late', d.manLate], ['unscheduled', d.manUnsch]].filter((x) => Math.round(x[1] || 0) > 0).map((x) => `${x[0]} ${Math.round(x[1])} min`).join(', ')}` : ' · within the scheduled shift'}${(() => { const io = manualIO(ctx).get(d.g + '|' + d.day); return io && isFinite(io.lagMax) && io.lagMax > R.retroLag.value ? ` · entered ${(io.lagMax / 60).toFixed(1)} h after the punch time` : ''; })()}`), { keyed: ioLabel(manualIO(ctx).get(d.g + '|' + d.day)) }));
        else if (lens === 'avoid' && d.cAvoid > 0) out.push(dayRow(d, d.avoidMin, d.cAvoid, [d.avoidEarlyMin > 0.5 ? `early ${Math.round(d.avoidEarlyMin)} min` : '', d.avoidLateMin > 0.5 ? `late ${Math.round(d.avoidLateMin)} min` : '', d.avoidMealMin > 0.5 ? `meal worked ${Math.round(d.avoidMealMin)} min` : ''].filter(Boolean).join(' · ') + ' beyond tolerance (netted)'));
        else if (lens === 'labor' && d.act > 0) out.push(dayRow(d, d.act, d.cAct, ''));
      }
      // Overtime premium from working past the schedule is part of the avoidable estimate.
      if (lens === 'avoid') for (const w of OT.weeks) if ((!s || w.store === s) && (!g || w.g === g) && w.premDrift > 0.005) out.push({ g: w.g, s: w.store, day: w.week, date: U.isoDay(w.week), dow: 'Week', schedStart: '', schedEnd: '', clockIn: '', clockOut: '', schMin: w.sched, actMin: w.paid, min: w.driftOt, cost: r2(w.premDrift), issue: 'OT premium from working past the schedule (week)' });
    } else if (lens === 'ot') {
      for (const w of OT.weeks) {
        if ((s && w.store !== s) || (g && w.g !== g)) continue;
        out.push({ g: w.g, s: w.store, day: w.week, date: U.isoDay(w.week), dow: 'Week of', schedStart: '', schedEnd: '', clockIn: '', clockOut: '', schMin: w.sched, actMin: w.paid, min: w.ot + w.dt, cost: r2(w.prem), premSched: w.premSched || 0, premDrift: w.premDrift || 0, multi: !!w.multiStore,
          issue: `${((w.ot + w.dt) / 60).toFixed(2)} h OT${w.schedOt > 0 ? `; ${(w.schedOt / 60).toFixed(2)} h already in the schedule` : ''}${w.multiStore ? '; worked at more than one store' : ''}` });
      }
    } else if (lens === 'edits') {
      for (const e of INT.editedList) {
        if (!keep(e)) continue;
        const parts = [];
        if (isFinite(e.inO) && e.inO !== e.inA) parts.push(`clock-in ${hm(e.inO)} → ${hm(e.inA)}`);
        if (isFinite(e.outO) && e.outO !== e.outA) parts.push(`clock-out ${hm(e.outO)} → ${hm(e.outA)}`);
        out.push({ g: e.g, s: e.s, day: e.day, date: U.isoDay(e.day), dow: U.DOW[U.dateParts(e.day).dow], schedStart: '', schedEnd: '', clockIn: ts(e.inO), clockOut: ts(e.outO),
          adjIn: ts(e.inA), adjOut: ts(e.outA), schMin: NaN, actMin: isFinite(e.outA) ? e.outA - e.inA : NaN, min: e.net, cost: e.forgot ? 0 : r2((e.net / 60) * (e.rate || 0)),
          issue: (parts.join(' · ') || 'edited') + (e.forgot ? ' · forgotten clock-out corrected (not counted)' : e.snap ? ' · moved exactly onto the scheduled time' : '') });
      }
    } else {
      const pred = { long: (p) => p.tot >= R.autoClosePunch.value, minor: (p) => p.age > 0 && p.age < R.minorAge.value, payrollid: (p) => p.noPayrollId, rate: (p) => ADH.rateOutliers.includes(p) }[lens];
      for (const p of M.punches) {
        if (!keep(p) || !pred(p)) continue;
        const late = isFinite(p.outA) && (U.dayOf(p.outA) > p.day || U.minOfDay(p.outA) > R.minorLateHour.value);
        const issue = lens === 'long' ? `Paid punch of ${(p.tot / 60).toFixed(1)} h` : lens === 'minor' ? `Age ${p.age}, Minor flag "No"${late ? ' · ended after ' + R.minorLateHour.value / 60 + ':00' : ''}${p.tot > 480 ? ' · longer than 8 h' : ''}`
          : lens === 'payrollid' ? 'No Payroll ID on this paid punch' : `Rate $${p.rate.toFixed(2)}/h vs usual $${(ADH.empRate.get(p.g) || 0).toFixed(2)}/h`;
        const cost = lens === 'rate' ? (p.pay || 0) - ((p.tot || 0) / 60) * (ADH.empRate.get(p.g) || 0) : lens === 'payrollid' ? p.pay || 0 : 0;
        out.push({ g: p.g, s: p.s, day: p.day, date: U.isoDay(p.day), dow: U.DOW[U.dateParts(p.day).dow], schedStart: '', schedEnd: '', clockIn: ts(p.inA), clockOut: ts(p.outA), schMin: NaN, actMin: p.tot, min: p.tot, cost: r2(cost), pay: p.pay, issue });
      }
    }
    return out;
  }

  /** Store-level summary figures for a lens (the store's figure in the finding). */
  function storeFigure(ctx, lens, s, recs) {
    const { ADH, OT } = ctx;
    const a = ADH.byStore[s] || {};
    if (lens === 'overplan') return { cost: a.cOverPlan || 0, min: a.overPlan || 0, note: 'Store figure is netted per store-day (cover for absent colleagues cancels out); employee rows show each person\'s paid time above their own schedule, before netting.', pct: a.sch ? a.overPlan / a.sch : null };
    if (lens === 'ot') { const o = OT.byStore[s] || {}; return { cost: o.prem || 0, min: (o.ot || 0) + (o.dt || 0), note: 'Overtime weeks are counted at the store where the employee worked most that week, as in the overtime finding.' }; }
    return { cost: U.sum(recs.map((r) => r.cost)), min: U.sum(recs.map((r) => (isFinite(r.min) ? Math.max(0, r.min) : 0))) };
  }

  /** Lens-specific supporting figures for a store or an employee (all summed from the same records). */
  function extras(ctx, lens, s, g, recs) {
    const { ADH } = ctx;
    const a = s && !g ? ADH.byStore[s] || {} : null;
    if (lens === 'manual') {
      const io = manualIO(ctx); let inOnly = 0, outOnly = 0, both = 0, late = 0, punches = 0;
      for (const r of recs) { const x = io.get(r.g + '|' + r.day); if (x) { if (x.in && x.out) both++; else if (x.in) inOnly++; else if (x.out) outOnly++; if (isFinite(x.lagMax) && x.lagMax > ctx.R.retroLag.value) late++; } }
      for (const d of ADH.days) if ((!s || d.s === s) && (!g || d.g === g) && d.manN > 0) punches += d.manN;
      let workDays = 0; for (const d of ADH.days) if ((!s || d.s === s) && (!g || d.g === g) && d.nP) workDays++;
      return { inOnly, outOnly, both, enteredLate: late, punches, days: recs.length, workDays, retroLag: ctx.R.retroLag.value };
    }
    if (lens === 'ot') { let ps = 0, pd = 0, multi = 0; for (const r of recs) { ps += r.premSched || 0; pd += r.premDrift || 0; if (r.multi) multi++; } return { premSched: ps, premDrift: pd, weeks: recs.length, multiWeeks: multi }; }
    if (lens === 'overplan') { let sch = 0, act = 0; for (const d of ADH.days) if ((!s || d.s === s) && (!g || d.g === g)) { sch += d.sch; act += d.act; } return { sch, act, daysOver: recs.length, overDays: a ? a.nOverDays : null, storeDays: a ? a.nStoreDays : null }; }
    if (lens === 'meal') { let worked = 0, missed = 0; for (const r of recs) { if (r.worked) worked++; if (r.missed) missed++; } return { worked, missed }; }
    if (lens === 'edits') { let added = 0, removed = 0, forgot = 0; for (const r of recs) { if (/forgotten/.test(r.issue)) forgot++; else if (r.min > 0) added++; else if (r.min < 0) removed++; } return { added, removed, forgot }; }
    if (lens === 'labor') { let sch = 0, act = 0, cost = 0; for (const d of ADH.days) if ((!s || d.s === s) && (!g || d.g === g)) { sch += d.sch; act += d.act; cost += d.cAct || 0; } return { sch, act, cost }; }
    return null;
  }

  function summarize(recs) {
    let lo = Infinity, hi = -Infinity, cost = 0, min = 0; // loop, not Math.min(...): org level has ~10^5 records
    const emps = new Set();
    for (const r of recs) { if (r.day < lo) lo = r.day; if (r.day > hi) hi = r.day; cost += r.cost; if (isFinite(r.min) && r.min > 0) min += r.min; emps.add(r.g); }
    return { n: recs.length, cost, min, emps: emps.size, first: recs.length ? U.isoDay(lo) : '', last: recs.length ? U.isoDay(hi) : '' };
  }

  /**
   * q = { type:'focus', finding, lens?, s?, g? }
   *   s only  → store level: summary, employees contributing (this lens only), records
   *   g       → employee level (inside s when given): summary, recurring pattern, records
   *   neither → organization level: stores contributing
   */
  function query(ctx, q) {
    const lens = q.lens || BY_FINDING[q.finding] || 'avoid';
    const L = LENS[lens];
    const { M, BEH } = ctx;
    const emp = (g) => M.emps.get(g) || {};
    const base = { lens, label: L.label, unit: L.unit, metric: L.metric, finding: q.finding || null, s: q.s || null, g: q.g || null, storeName: q.s ? M.storeName[q.s] || q.s : null };
    if (q.g) {
      const recs = records(ctx, lens, q.s, q.g).sort((a, b) => a.day - b.day);
      const e = emp(q.g);
      const pats = BEH ? BEH.patterns.filter((p) => p.g === q.g && (p.cat === L.cat || (L.cat === 'combined' && p.cat === 'combined')) && (!q.s || p.store === q.s || !p.store)) : [];
      return Object.assign(base, { level: 'employee', name: e.name || q.g, homeStore: M.storeName[e.store] || e.store, job: e.job, summary: summarize(recs), patterns: pats, records: recs, extras: extras(ctx, lens, q.s, q.g, recs) });
    }
    if (q.s) {
      const recs = records(ctx, lens, q.s, null).sort((a, b) => a.day - b.day);
      const by = new Map();
      for (const r of recs) { let x = by.get(r.g); if (!x) by.set(r.g, (x = [])); x.push(r); }
      const employees = [...by].map(([g, rs]) => {
        const e = emp(g); const sm = summarize(rs);
        const pat = BEH ? BEH.patterns.find((p) => p.g === g && p.cat === L.cat) : null;
        return { g, name: e.name || g, job: e.job || '', n: sm.n, cost: sm.cost, min: sm.min, first: sm.first, last: sm.last, pattern: pat ? pat.description : '', patternSev: pat ? pat.severity : '' };
      }).sort((a, b) => b.cost - a.cost || b.min - a.min);
      const sm = summarize(recs), fig = storeFigure(ctx, lens, q.s, recs);
      const storeDays = lens === 'overplan' ? ctx.ADH.storeDays.filter((x) => x.s === q.s && x.overPlan > 0).sort((a, b) => b.cOverPlan - a.cOverPlan).map((x) => ({ date: U.isoDay(x.day), dow: U.DOW[x.dow], min: x.overPlan, cost: r2(x.cOverPlan) })) : null;
      return Object.assign(base, { level: 'store', summary: Object.assign(sm, { cost: fig.cost, min: fig.min, pct: fig.pct, recordCost: sm.cost }), note: fig.note || '', employees, records: recs.slice(0, 5000), recordsTotal: recs.length, storeDays, extras: extras(ctx, lens, q.s, null, recs),
        patterns: BEH && L.cat ? BEH.patterns.filter((p) => p.store === q.s && p.cat === L.cat).length : 0 });
    }
    // organization level: stores contributing to this lens
    const recs = records(ctx, lens, null, null);
    const by = new Map();
    for (const r of recs) { let x = by.get(r.s); if (!x) by.set(r.s, (x = [])); x.push(r); }
    let note = '';
    const stores = [...by].map(([s, rs]) => { const sm = summarize(rs), fig = storeFigure(ctx, lens, s, rs); if (fig.note) note = fig.note; return { s, name: M.storeName[s] || s, n: sm.n, emps: sm.emps, cost: fig.cost, min: fig.min }; }).sort((a, b) => b.cost - a.cost);
    const sm = summarize(recs); let c = 0, mn = 0; for (const x of stores) { c += x.cost; mn += x.min; }
    return Object.assign(base, { level: 'org', summary: Object.assign(sm, { cost: c, min: mn, recordCost: sm.cost }), note, stores });
  }

  LCI.focus = { query, records, BY_FINDING, LENS, lensFor: (id) => BY_FINDING[id] || 'avoid' };
})(typeof globalThis !== 'undefined' ? globalThis : self);
