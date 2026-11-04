/*
 * overtime.js — overtime cost and its cause.
 *
 * OT minutes and OT pay come straight from the punch export (the payroll engine already applied the
 * client's thresholds). Only the PREMIUM part is costed here:
 *     OT premium = OT pay − OT hours × base rate        (≈ 0.5 × rate × OT hours at 1.5×)
 *     DT premium = DT pay − DT hours × base rate
 * The base-rate part of those hours is already inside paid hours (and, where it falls outside the
 * schedule, inside the early/late/unscheduled components), so nothing is counted twice.
 *
 * Cause split per employee-week (weekly threshold inferred from the data):
 *     scheduled OT = min(OT, max(0, scheduled minutes − threshold))   → built into the schedule
 *     drift OT     = OT − scheduled OT                                 → created by working beyond the schedule
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;
  const A = (LCI.analysis = LCI.analysis || {});

  A.overtime = function (M, R, ADH) {
    // ---- per employee-week from punches ----
    const wk = new Map();
    for (const p of M.punches) {
      const w = U.weekStart(p.day);
      const k = p.g + '|' + w;
      const x = U.getOr(wk, k, () => ({ g: p.g, week: w, paid: 0, ot: 0, dt: 0, prem: 0, stores: {}, job: p.job, rate: 0, rateMin: 0 }));
      x.paid += p.tot || 0; x.ot += p.ot; x.dt += p.dt;
      const r = p.rate > 0 ? p.rate : 0;
      // Use the OT/DT pay actually exported; the 1.5× / 2× product multipliers are only a fallback
      // when the export has no OT pay column. OT paid at straight time (or $0) therefore has no premium.
      let prem = 0;
      if (p.ot > 0) prem += isFinite(p.otPay) ? Math.max(0, p.otPay - (p.ot / 60) * r) : (p.ot / 60) * r * (R.otMultiplier.value - 1);
      if (p.dt > 0) prem += isFinite(p.dtPay) ? Math.max(0, p.dtPay - (p.dt / 60) * r) : (p.dt / 60) * r;
      if (p.ot + p.dt > 0 && isFinite(p.otPay) && p.otPay + (p.dtPay || 0) < ((p.ot + p.dt) / 60) * r * 1.4) { x.noPremMin = (x.noPremMin || 0) + p.ot + p.dt; }
      x.prem += prem;
      x.stores[p.s] = (x.stores[p.s] || 0) + (p.tot || 0);
      if (r) { x.rate += r * (p.tot || 0); x.rateMin += p.tot || 0; }
    }

    // ---- infer weekly threshold: mode of (paid − OT) over weeks with OT ----
    const modes = {};
    let otWeeks = 0;
    for (const x of wk.values()) if (x.ot > 0) { otWeeks++; const b = Math.round(x.paid - x.ot - x.dt); modes[b] = (modes[b] || 0) + 1; }
    let thr = R.weeklyOtThreshold.value, thrN = 0;
    let thrConsistency = null;
    if (R.weeklyOtThreshold.overridden) {
      // Fixed by the manifest, or by the full-dataset run when analysing a filtered slice.
      thrN = Object.entries(modes).filter(([b]) => Math.abs(+b - thr) <= 1).reduce((s, [, n]) => s + n, 0);
      thrConsistency = otWeeks ? thrN / otWeeks : null;
    } else {
      for (const b in modes) if (modes[b] > thrN) { thrN = modes[b]; thr = +b; }
      thrConsistency = otWeeks ? thrN / otWeeks : null;
      if (otWeeks) R.weeklyOtThreshold.value = thr;
    }
    if (otWeeks) R.weeklyOtThreshold.inferred = { otWeeks, matching: thrN, share: thrConsistency };

    // ---- cause split and roll-ups ----
    const byStore = {}, byEmp = {}, byMonth = {}, byStoreMonth = {};
    const tot = { ot: 0, dt: 0, prem: 0, schedOt: 0, driftOt: 0, premSched: 0, premDrift: 0, weeks: 0, otWeeks: 0, over40NoOt: 0, over40NoOtMin: 0 };
    const add = (o, x, so, dr, ps, pd) => { o.ot += x.ot; o.dt += x.dt; o.prem += x.prem; o.schedOt += so; o.driftOt += dr; o.premSched += ps; o.premDrift += pd; o.otWeeks += x.ot + x.dt > 0 ? 1 : 0; };
    const mk = () => ({ ot: 0, dt: 0, prem: 0, schedOt: 0, driftOt: 0, premSched: 0, premDrift: 0, otWeeks: 0 });
    const noOtByJob = {};
    const weeks = [];
    for (const x of wk.values()) {
      tot.weeks++;
      const ew = ADH.empWeek[x.g + '|' + x.week];
      const sched = ew ? ew.sch : 0;
      x.sched = sched;
      const otAll = x.ot + x.dt;
      if (otAll <= 0) {
        if (x.paid > thr + 1) { tot.over40NoOt++; tot.over40NoOtMin += x.paid - thr; noOtByJob[x.job] = (noOtByJob[x.job] || 0) + 1; }
        continue;
      }
      const so = Math.min(otAll, Math.max(0, sched - thr));
      const dr = otAll - so;
      const ps = x.prem * (so / otAll), pd = x.prem - ps;
      x.schedOt = so; x.driftOt = dr; x.premSched = ps; x.premDrift = pd;
      const store = LCI.model.topKey(x.stores);
      x.store = store;
      x.multiStore = Object.keys(x.stores).length > 1;
      weeks.push(x);
      add(tot, x, so, dr, ps, pd);
      add(byStore[store] = byStore[store] || mk(), x, so, dr, ps, pd);
      const E = (byEmp[x.g] = byEmp[x.g] || Object.assign(mk(), { weeksSet: 0 }));
      add(E, x, so, dr, ps, pd);
      const m = U.monthKey(x.week + 3); // OT is weekly; a week belongs to the month holding its Thursday
      add(byMonth[m] = byMonth[m] || mk(), x, so, dr, ps, pd);
      add(byStoreMonth[store + '|' + m] = byStoreMonth[store + '|' + m] || mk(), x, so, dr, ps, pd);
    }
    const multiStoreOt = weeks.filter((w) => w.multiStore);
    // OT hours paid at less than ~1.4× base (straight time or $0) — exempt roles or a payroll set-up to confirm.
    const noPrem = [...wk.values()].filter((x) => x.noPremMin > 0);
    const noPremium = { min: U.sum(noPrem.map((x) => x.noPremMin)), weeks: noPrem.length, emps: new Set(noPrem.map((x) => x.g)).size };

    // Last week may be cut off by the period end — OT for it can be understated.
    const lastWeek = U.weekStart(M.period.end);
    const truncatedLastWeek = M.period.end - lastWeek < 6;

    return {
      threshold: thr, thresholdConsistency: thrConsistency, tot, byStore, byEmp, byMonth, byStoreMonth, weeks,
      multiStoreOt: { weeks: multiStoreOt.length, ot: U.sum(multiStoreOt.map((w) => w.ot + w.dt)), prem: U.sum(multiStoreOt.map((w) => w.prem)) },
      noOtByJob, truncatedLastWeek, lastWeekStart: lastWeek, noPremium,
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
