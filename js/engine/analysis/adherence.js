/*
 * adherence.js — schedule vs actual, at employee-day level (GEID × business date).
 *
 * For each employee-day:
 *   scheduled blocks  = union of SHIFT segments (duplicates already removed at ingest)
 *   scheduled paid    = blocks − scheduled MEAL segments inside them (meal unpaid, rest paid: product rule)
 *   actual paid       = Σ Total Punch Hours of the day's punches (already net of unpaid breaks)
 *
 * Each punch is assigned to the scheduled block it overlaps most. Per block:
 *   early clock-in   = max(0, block start − first clock-in)
 *   late clock-out   = max(0, last clock-out − block end)
 *   late clock-in    = max(0, first clock-in − block start)      (offset: time not worked)
 *   early clock-out  = max(0, block end − last clock-out)        (offset)
 *   skipped meal     = max(0, scheduled meal − meal break taken)  (paid time that was planned unpaid)
 *   longer break     = max(0, meal taken − scheduled meal)        (offset)
 * Punches overlapping no block are "unscheduled"; blocks with no punch are "no-show".
 *
 * These components are clock-minute based and do not overlap one another, so their costs can be
 * added. Overtime premium is handled separately (overtime.js) and only the premium half is counted
 * there, so nothing is double-counted.
 *
 * Store-day netting (why avoidable is smaller than gross):
 *   labor above plan (store-day) = max(0, Σ actual paid − Σ scheduled paid) over everyone at the store that day.
 *   behavioural minutes          = early/late minutes beyond the on-schedule tolerance (10 min) + skipped meals.
 *   avoidable minutes            = behavioural minutes × min(1, labor above plan / behavioural minutes)
 * So extra time is only called avoidable up to the amount the store actually ran over its own plan that
 * day; time that filled a gap left by a no-show, late arrival or early leave is not claimed as savings.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;
  const A = (LCI.analysis = LCI.analysis || {});

  const FIELDS = ['sch', 'act', 'early', 'late', 'lateIn', 'earlyOut', 'unsch', 'noShow', 'mealSkip', 'extraBrk', 'avEarly', 'avLate',
    'cEarly', 'cLate', 'cUnsch', 'cMealSkip', 'cAvEarly', 'cAvLate', 'cAct', 'nDays', 'nBlocks', 'nEarlyEv', 'nLateEv', 'nEarlyViol', 'nLateViol',
    'nUnschDays', 'nNoShow', 'nMealPlanned', 'nMealSkipped', 'noRateMin',
    // manual-punch lens (Source Id = MANUAL) — overlaps the parts above, never added to them
    'manN', 'manMin', 'cMan', 'manEarly', 'manLate', 'manUnsch', 'manBehav', 'cManBehav', 'manAvoidMin', 'cManAvoid', 'nManDays', 'cManExtra',
    'behavMin', 'cBehav', 'avoidMin', 'cAvoid', 'avoidEarlyMin', 'avoidLateMin', 'avoidMealMin', 'cAvoidEarly', 'cAvoidLate', 'cAvoidMeal', 'overPlan', 'cOverPlan', 'underPlan', 'unschUncovered', 'nStoreDays', 'nOverDays'];
  A.newAcc = () => { const a = {}; for (const f of FIELDS) a[f] = 0; return a; };
  A.addAcc = (a, d) => { for (const f of FIELDS) a[f] += d[f] || 0; return a; };
  A.ACC_FIELDS = FIELDS;

  const isQuarter = (t) => isFinite(t) && (U.minOfDay(t) % 15 === 0);

  function shiftType(startMinOfDay) {
    if (startMinOfDay < 10 * 60) return 'Opening (before 10:00)';
    if (startMinOfDay < 16 * 60) return 'Mid-day (10:00–15:59)';
    return 'Closing (16:00 or later)';
  }

  /**
   * Schedule segments of one employee-day as absolute minute intervals.
   * Overnight shifts are exported split at midnight on the same business date (e.g. 17:30–00:00 and
   * 00:00–01:30). When a segment ends at midnight, the chain of segments starting at 00:00 — and any
   * meal inside it — is the continuation after midnight and is moved to the next calendar day.
   */
  A.schedIntervals = function (sr, base) {
    const shifts = sr.filter((r) => r.kind === 'S').map((r) => [base + r.st, base + r.en]);
    const meals = sr.filter((r) => r.kind === 'M').map((r) => [base + r.st, base + r.en]);
    if (shifts.some((s) => s[1] === base + 1440) && shifts.some((s) => s[0] === base)) {
      let edge = base, moved = true, maxEnd = base;
      const done = new Set();
      while (moved) {
        moved = false;
        shifts.forEach((s, i) => {
          if (!done.has(i) && s[0] === edge && s[1] < base + 1440 && s[0] < base + 12 * 60) { done.add(i); edge = s[1]; maxEnd = Math.max(maxEnd, s[1]); moved = true; }
        });
      }
      for (const i of done) { shifts[i][0] += 1440; shifts[i][1] += 1440; }
      for (const m of meals) if (m[0] >= base && m[1] <= maxEnd) { m[0] += 1440; m[1] += 1440; }
    }
    return { shifts, meals };
  };

  A.adherence = function (M, R) {
    const tol = R.punchTolerance.value, viol = R.punchViolation.value;
    const key = (g, d) => g + '|' + d;
    const sIdx = new Map(), pIdx = new Map(), bIdx = new Map();
    for (const r of M.schedule) U.getOr(sIdx, key(r.g, r.day), () => []).push(r);
    for (const p of M.punches) U.getOr(pIdx, key(p.g, p.day), () => []).push(p);
    for (const b of M.breaks) U.getOr(bIdx, key(b.g, b.day), () => []).push(b);

    // Employee fallback pay rate (median of their punch rates) for minutes on rows with no rate.
    const rates = new Map();
    for (const p of M.punches) if (p.rate > 0) U.getOr(rates, p.g, () => []).push(p.rate);
    const empRate = new Map();
    for (const [g, a] of rates) empRate.set(g, U.median(a));
    // Pay-rate outliers (rate > 3× the employee's own median and > $30/h) look like keyed salary or bonus
    // amounts. Leakage minutes on those rows are costed at the employee's median rate instead; the actual
    // pay is still reported as labor expenditure and the rows are listed for review.
    const rateOutliers = [];
    const rateFor = (p) => {
      if (!(p.rate > 0)) return empRate.get(p.g) || NaN;
      const med = empRate.get(p.g);
      if (med && p.rate > 3 * med && p.rate > 30) return med;
      return p.rate;
    };
    for (const p of M.punches) { const med = empRate.get(p.g); if (p.rate > 0 && med && p.rate > 3 * med && p.rate > 30) rateOutliers.push(p); }

    const days = [];
    const bySource = {};
    const schedCheck = { days: 0, match: 0 };
    let openPunches = 0, longPunches = 0;
    const keys = new Set([...sIdx.keys(), ...pIdx.keys()]);

    for (const k of keys) {
      const sr = sIdx.get(k) || [], ps = (pIdx.get(k) || []).slice().sort((a, b) => a.inA - b.inA), br = bIdx.get(k) || [];
      const ref = sr[0] || ps[0];
      const g = ref.g, day = ref.day;
      const base = day * 1440;
      const sch = A.schedIntervals(sr, base);
      const blocks = U.union(sch.shifts).map((iv) => ({ s: iv[0], e: iv[1], ps: [] }));
      const meals = U.union(sch.meals);
      const takenMeals = br.filter((b) => b.kind === 'M' && isFinite(b.bi) && isFinite(b.bo)).map((b) => [b.bi, b.bo]);

      const d = { g, day, s: '', sch: 0, act: 0, early: 0, late: 0, lateIn: 0, earlyOut: 0, unsch: 0, noShow: 0, mealSkip: 0, extraBrk: 0,
        avEarly: 0, avLate: 0, nDays: 1, nBlocks: blocks.length, nEarlyEv: 0, nLateEv: 0, nEarlyViol: 0, nLateViol: 0, nUnschDays: 0, nNoShow: 0,
        nMealPlanned: 0, nMealSkipped: 0, firstIn: NaN, lastOut: NaN, bS: blocks.length ? blocks[0].s : NaN, bE: blocks.length ? blocks[blocks.length - 1].e : NaN, nP: ps.length };

      // Scheduled paid minutes, checked against the export's own Schedule Hours where present.
      for (const b of blocks) { b.meal = U.overlapAll([[b.s, b.e]], meals); b.paid = b.e - b.s - b.meal; d.sch += b.paid; }
      const hrsField = sr.find((r) => r.kind === 'S' && isFinite(r.hrs));
      if (hrsField && blocks.length) { schedCheck.days++; if (Math.abs(hrsField.hrs * 60 - d.sch) <= 1) schedCheck.match++; }

      // Rate for this day: hour-weighted punch rate, else employee median.
      let rw = 0, rt = 0;
      for (const p of ps) { const r = rateFor(p); if (r > 0 && p.tot > 0) { rw += r * p.tot; rt += p.tot; } }
      const rate = rt ? rw / rt : (empRate.get(g) || NaN);
      d.rate = rate;

      const unassigned = [];
      for (const p of ps) {
        if (!isFinite(p.outA)) { openPunches++; continue; }
        if (p.tot >= R.autoClosePunch.value) longPunches++;
        d.act += p.tot || 0;
        if (p.src === 'MANUAL') { d.manN = (d.manN || 0) + 1; d.manMin = (d.manMin || 0) + (p.tot || 0); d.cMan = (d.cMan || 0) + (isFinite(p.pay) ? p.pay : 0); d.nManDays = 1; }
        let best = null, bo = 0;
        for (const b of blocks) { const o = U.overlap([p.inA, p.outA], [b.s, b.e]); if (o > bo) { bo = o; best = b; } }
        if (best) best.ps.push(p); else unassigned.push(p);
        const sk = p.src || '(none)';
        const S = (bySource[sk] = bySource[sk] || { n: 0, min: 0, earlyEv: 0, lateEv: 0, earlyMin: 0, lateMin: 0, unschN: 0, qIn: 0, qOut: 0, edited: 0 });
        S.n++; S.min += p.tot || 0;
        if (isQuarter(p.inA)) S.qIn++;
        if (isQuarter(p.outA)) S.qOut++;
        if ((isFinite(p.inO) && p.inO !== p.inA) || (isFinite(p.outO) && p.outO !== p.outA)) S.edited++;
        if (!best) S.unschN++;
      }
      if (ps.length) { d.firstIn = ps[0].inA; d.lastOut = Math.max(...ps.map((p) => p.outA).filter(isFinite)); }
      d.s = ps.length ? ps[0].s : sr[0].s;

      for (const b of blocks) {
        if (!b.ps.length) { d.noShow += b.paid; d.nNoShow++; continue; }
        const first = b.ps[0], last = b.ps.reduce((a, p) => (p.outA > a.outA ? p : a), b.ps[0]);
        const e = Math.max(0, b.s - first.inA), l = Math.max(0, last.outA - b.e);
        d.early += e; d.late += l;
        d.lateIn += Math.max(0, Math.min(first.inA, b.e) - b.s);
        d.earlyOut += Math.max(0, b.e - Math.max(last.outA, b.s));
        if (e > tol) { d.nEarlyEv++; d.avEarly += e - tol; }
        if (l > tol) { d.nLateEv++; d.avLate += l - tol; }
        if (first.src === 'MANUAL') { d.manEarly = (d.manEarly || 0) + e; if (e > tol) d.manBehav = (d.manBehav || 0) + e - tol; }
        if (last.src === 'MANUAL') { d.manLate = (d.manLate || 0) + l; if (l > tol) d.manBehav = (d.manBehav || 0) + l - tol; }
        if (e > viol) d.nEarlyViol++;
        if (l > viol) d.nLateViol++;
        const fs = bySource[first.src || '(none)'], ls = bySource[last.src || '(none)'];
        if (e > tol) { fs.earlyEv++; fs.earlyMin += e; }
        if (l > tol) { ls.lateEv++; ls.lateMin += l; }
        // Meal comparison inside the worked window of this block.
        const win = [[first.inA, last.outA]];
        const taken = U.overlapAll(win, U.union(takenMeals));
        if (b.meal > 0) {
          d.nMealPlanned++;
          const skip = Math.max(0, b.meal - taken);
          // Only count as skipped if the employee was actually on the clock through the planned meal.
          const onClock = U.overlapAll(win, meals.filter((m) => m[0] >= b.s && m[1] <= b.e));
          const sk = Math.min(skip, onClock);
          if (sk > 0) { d.mealSkip += sk; d.nMealSkipped++; }
          d.extraBrk += Math.max(0, taken - b.meal);
        } else d.extraBrk += taken;
      }
      for (const p of unassigned) { d.unsch += p.tot || 0; if (p.src === 'MANUAL') d.manUnsch = (d.manUnsch || 0) + (p.tot || 0); }
      if (ps.length && !blocks.length) d.nUnschDays = 1;

      const c = (m) => (isFinite(rate) ? (m / 60) * rate : 0);
      d.cEarly = c(d.early); d.cLate = c(d.late); d.cUnsch = c(d.unsch); d.cMealSkip = c(d.mealSkip);
      d.cAvEarly = c(d.avEarly); d.cAvLate = c(d.avLate);
      d.cManBehav = c(d.manBehav || 0);
      // $ of the time outside the schedule that was recorded through manual punches (lens — overlaps early/late/unscheduled).
      d.cManExtra = c((d.manEarly || 0) + (d.manLate || 0) + (d.manUnsch || 0));
      d.cAct = ps.reduce((s, p) => s + (isFinite(p.pay) ? p.pay : 0), 0);
      d.cCap = ps.reduce((s, p) => s + (p.tot > 0 ? (p.tot / 60) * (rateFor(p) || 0) : 0), 0); // pay at outlier-capped rates
      d.behavMin = d.avEarly + d.avLate + d.mealSkip;
      d.cBehav = d.cAvEarly + d.cAvLate + d.cMealSkip;
      if (!isFinite(rate)) d.noRateMin = d.early + d.late + d.unsch + d.mealSkip;
      d.week = U.weekStart(day);
      d.month = U.monthKey(day);
      d.dow = U.dateParts(day).dow;
      d.shiftType = blocks.length ? shiftType(U.minOfDay(blocks[0].s)) : 'Unscheduled';
      days.push(d);
    }

    // ---- store-day netting ----
    const storeDay = {};
    for (const d of days) {
      const k = d.s + '|' + d.day;
      const x = (storeDay[k] = storeDay[k] || { s: d.s, day: d.day, act: 0, sch: 0, pay: 0, behav: 0, unsch: 0, gap: 0, extra: 0, days: [] });
      x.act += d.act; x.sch += d.sch; x.pay += d.cCap; x.behav += d.behavMin; x.unsch += d.unsch;
      x.gap += d.noShow + d.lateIn + d.earlyOut; x.extra += d.early + d.late; x.days.push(d);
    }
    const sdList = [];
    for (const k in storeDay) {
      const x = storeDay[k];
      const over = Math.max(0, x.act - x.sch);
      const f = x.behav > 0 ? Math.min(1, over / x.behav) : 0;
      for (const d of x.days) {
        d.avoidMin = d.behavMin * f; d.cAvoid = d.cBehav * f;
        d.avoidEarlyMin = d.avEarly * f; d.avoidLateMin = d.avLate * f; d.avoidMealMin = d.mealSkip * f;
        d.cAvoidEarly = d.cAvEarly * f; d.cAvoidLate = d.cAvLate * f; d.cAvoidMeal = d.cMealSkip * f;
        d.manAvoidMin = (d.manBehav || 0) * f; d.cManAvoid = (d.cManBehav || 0) * f;
      }
      const rate = x.act ? x.pay / x.act : 0; // $ per paid minute that store-day
      const sd = { s: x.s, day: x.day, month: U.monthKey(x.day), dow: U.dateParts(x.day).dow, nStoreDays: 1, nOverDays: over > 0 ? 1 : 0,
        overPlan: over, cOverPlan: over * rate, underPlan: Math.max(0, x.sch - x.act), unschUncovered: Math.max(0, x.unsch - x.gap) };
      sdList.push(sd);
      delete x.days;
    }

    // ---- roll-ups ----
    const tot = A.newAcc(), byStore = {}, byEmp = {}, byMonth = {}, byStoreMonth = {}, byDow = {}, byShift = {}, byWeek = {}, empWeek = {};
    for (const sd of sdList) {
      A.addAcc(tot, sd);
      A.addAcc(byStore[sd.s] = byStore[sd.s] || A.newAcc(), sd);
      A.addAcc(byMonth[sd.month] = byMonth[sd.month] || A.newAcc(), sd);
      A.addAcc(byStoreMonth[sd.s + '|' + sd.month] = byStoreMonth[sd.s + '|' + sd.month] || A.newAcc(), sd);
      A.addAcc(byDow[sd.dow] = byDow[sd.dow] || A.newAcc(), sd);
    }
    for (const d of days) {
      A.addAcc(tot, d);
      A.addAcc(byStore[d.s] = byStore[d.s] || A.newAcc(), d);
      const E = (byEmp[d.g] = byEmp[d.g] || Object.assign(A.newAcc(), { earlyWeeks: new Set(), lateWeeks: new Set(), unschWeeks: new Set(), skipWeeks: new Set(), manWeeks: new Set(), months: {} }));
      A.addAcc(E, d);
      if (d.nEarlyEv) E.earlyWeeks.add(d.week);
      if (d.nLateEv) E.lateWeeks.add(d.week);
      if (d.unsch > 0) E.unschWeeks.add(d.week);
      if (d.mealSkip > 0) E.skipWeeks.add(d.week);
      if (d.manN) E.manWeeks.add(d.week);
      A.addAcc(E.months[d.month] = E.months[d.month] || A.newAcc(), d);
      A.addAcc(byMonth[d.month] = byMonth[d.month] || A.newAcc(), d);
      A.addAcc(byStoreMonth[d.s + '|' + d.month] = byStoreMonth[d.s + '|' + d.month] || A.newAcc(), d);
      A.addAcc(byDow[d.dow] = byDow[d.dow] || A.newAcc(), d);
      A.addAcc(byShift[d.shiftType] = byShift[d.shiftType] || A.newAcc(), d);
      A.addAcc(byWeek[d.week] = byWeek[d.week] || A.newAcc(), d);
      const ew = (empWeek[d.g + '|' + d.week] = empWeek[d.g + '|' + d.week] || { g: d.g, week: d.week, sch: 0, act: 0, stores: {} });
      ew.sch += d.sch; ew.act += d.act; ew.stores[d.s] = (ew.stores[d.s] || 0) + d.act;
    }

    // How much of the extra individual time was absorbed by gaps at the same store-day (coverage),
    // i.e. the difference between gross additional minutes and the store-day net over plan.
    let gapCovered = 0;
    for (const k in storeDay) { const x = storeDay[k]; gapCovered += Math.min(x.extra + x.unsch, x.gap); }

    // Reconciliation: Δ(actual − scheduled) explained by the components; the residual is mid-shift gaps,
    // overlapping punches, and blocks the employee worked only partially.
    const explained = tot.early + tot.late + tot.unsch + tot.mealSkip - tot.lateIn - tot.earlyOut - tot.noShow - tot.extraBrk;
    const recon = { delta: tot.act - tot.sch, explained, residual: tot.act - tot.sch - explained };

    return {
      days, tot, byStore, byEmp, byMonth, byStoreMonth, byDow, byShift, byWeek, empWeek, bySource, empRate, rateFor, rateOutliers,
      openPunches, longPunches, schedCheck, recon, coverage: { gapCovered, storeDays: sdList.length }, storeDays: sdList,
      _idx: { sIdx, pIdx, bIdx },
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
