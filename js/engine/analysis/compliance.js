/*
 * compliance.js — breaks, minors and flagged labor exceptions.
 *
 * These are reported as compliance RISK (counts, hours, affected employees). A dollar figure is only
 * shown where the dataset contains actual premium pay; a missed break is not assumed to cost money.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;
  const A = (LCI.analysis = LCI.analysis || {});

  A.compliance = function (M, R, ADH) {
    const need = R.mealRequiredAfter.value, minMeal = R.minMealLength.value, minorAge = R.minorAge.value, late = R.minorLateHour.value;

    // ---- meal breaks against paid shift length ----
    const brk = { eligibleDays: 0, missed: 0, missedEmps: new Set(), short: 0, shortMin: 0, open: 0, total: 0, rest: 0, byStore: {}, byMonth: {}, byEmp: {} };
    const brkByDay = ADH._idx.bIdx;
    for (const d of ADH.days) {
      if (d.act <= need || !d.nP) continue;
      brk.eligibleDays++;
      const bs = (brkByDay.get(d.g + '|' + d.day) || []).filter((b) => b.kind === 'M');
      const st = (brk.byStore[d.s] = brk.byStore[d.s] || { eligible: 0, missed: 0, short: 0 });
      const mo = (brk.byMonth[d.month] = brk.byMonth[d.month] || { eligible: 0, missed: 0, short: 0 });
      st.eligible++; mo.eligible++;
      if (!bs.length) {
        brk.missed++; brk.missedEmps.add(d.g); st.missed++; mo.missed++;
        const e = (brk.byEmp[d.g] = brk.byEmp[d.g] || { missed: 0, short: 0, weeks: new Set() }); e.missed++; e.weeks.add(d.week);
      }
    }
    for (const b of M.breaks) {
      brk.total++;
      if (b.kind === 'R') { brk.rest++; continue; }
      if (b.open) { brk.open++; continue; }
      if (isFinite(b.dur) && b.dur < minMeal) {
        brk.short++; brk.shortMin += minMeal - b.dur;
        const st = (brk.byStore[b.s] = brk.byStore[b.s] || { eligible: 0, missed: 0, short: 0 }); st.short++;
        const mo = (brk.byMonth[U.monthKey(b.day)] = brk.byMonth[U.monthKey(b.day)] || { eligible: 0, missed: 0, short: 0 }); mo.short++;
        const e = (brk.byEmp[b.g] = brk.byEmp[b.g] || { missed: 0, short: 0, weeks: new Set() }); e.short++;
      }
    }
    brk.missedEmployees = brk.missedEmps.size; delete brk.missedEmps;

    // ---- minors ----
    const mn = { punches: 0, flagNo: 0, emps: new Set(), flagMismatchEmps: new Set(), lateNight: 0, lateNightEmps: new Set(), longDays: 0, over40Weeks: 0, byStore: {}, schedFlagged: 0, schedFlaggedAdult: 0 };
    const minorEmp = new Set();
    for (const p of M.punches) {
      if (!(p.age > 0 && p.age < minorAge)) continue;
      mn.punches++; mn.emps.add(p.g); minorEmp.add(p.g);
      if (!p.minor) { mn.flagNo++; mn.flagMismatchEmps.add(p.g); }
      const st = (mn.byStore[p.s] = mn.byStore[p.s] || { punches: 0, lateNight: 0, emps: new Set() });
      st.punches++; st.emps.add(p.g);
      if (isFinite(p.outA) && (U.dayOf(p.outA) > p.day || U.minOfDay(p.outA) > late)) { mn.lateNight++; mn.lateNightEmps.add(p.g); st.lateNight++; }
      if (p.tot > 8 * 60) mn.longDays++;
    }
    for (const w of Object.values(ADH.empWeek)) if (minorEmp.has(w.g) && w.act > 2400) mn.over40Weeks++;
    for (const e of M.emps.values()) {
      if (e.schedMinor) { mn.schedFlagged++; if (e.minAge != null && e.minAge >= minorAge) mn.schedFlaggedAdult++; }
    }
    mn.minorEmployees = mn.emps.size; mn.flagMismatchEmployees = mn.flagMismatchEmps.size; mn.lateNightEmployees = mn.lateNightEmps.size;
    for (const s in mn.byStore) mn.byStore[s].emps = mn.byStore[s].emps.size;
    delete mn.emps; delete mn.flagMismatchEmps; delete mn.lateNightEmps;

    // ---- labor exceptions flagged by the time clock ----
    const exc = { byType: {}, byStoreType: {}, byMonthType: {}, authPunches: 0, punches: 0, authByStore: {}, authByMgr: {} };
    for (const v of M.violations) {
      exc.byType[v.type] = (exc.byType[v.type] || 0) + 1;
      const st = (exc.byStoreType[v.s] = exc.byStoreType[v.s] || {}); st[v.type] = (st[v.type] || 0) + 1;
      const mo = (exc.byMonthType[U.monthKey(v.day)] = exc.byMonthType[U.monthKey(v.day)] || {}); mo[v.type] = (mo[v.type] || 0) + 1;
    }
    for (const p of M.excPunch) {
      exc.punches++;
      const st = (exc.authByStore[p.s] = exc.authByStore[p.s] || { n: 0, auth: 0 });
      st.n++;
      if (p.auth) { exc.authPunches++; st.auth++; }
      if (p.mgr) exc.authByMgr[p.mgr] = (exc.authByMgr[p.mgr] || 0) + 1;
    }
    exc.breakTypesFlagged = Object.keys(exc.byType).filter((t) => /BRK|BREAK|MEAL|REST/.test(t));

    // ---- premium / misc pay ----
    const prem = { rows: M.premium.length, amount: U.sum(M.premium.map((p) => p.amount || 0)), misc: M.misc.length, miscAmount: U.sum(M.misc.map((p) => p.amount || 0)) };

    return { breaks: brk, minors: mn, exceptions: exc, premium: prem };
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
