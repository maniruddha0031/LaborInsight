/*
 * insights.js — turns analysis results into business findings.
 *
 * Every generator reads computed evidence and only emits a finding when the dataset supports it.
 * Nothing is hard-coded: stores, employees, months and amounts all come from the analysis context.
 *
 * Finding fields:
 *   what / where / why / evidence[] / action / impact{hours,cost,label,basis}
 *   kind:       'confirmed' (direct record counts), 'estimate' ($ derived with stated assumptions),
 *               'risk' (compliance/control exposure without a $ claim), 'validate' (needs business review)
 *   severity:   scaled to the dataset's own labor cost (Critical ≥0.75%, High ≥0.3%, Medium ≥0.1%) or to
 *               the share of records affected for risk findings
 *   confidence: High (direct records) / Medium (records + a stated rule or assumption) / Low (benchmark or inference)
 *   drill:      table of affected stores / employees (GEID) / months for the UI
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;

  const $ = (v) => (v < 0 ? '−' : '') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
  const H = (min) => Math.round(min / 60).toLocaleString('en-US') + ' h';
  const N = (v) => Math.round(v).toLocaleString('en-US');
  const P = (v, d) => (v * 100).toFixed(d == null ? 1 : d) + '%';
  const list = (a, n) => { a = a.slice(0, n || 3); return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; };

  function sevCost(cost, labor) {
    const s = labor ? cost / labor : 0;
    return s >= 0.0075 ? 'Critical' : s >= 0.003 ? 'High' : s >= 0.001 ? 'Medium' : 'Low';
  }
  function sevShare(share, hi, mid) { return share >= hi ? 'High' : share >= mid ? 'Medium' : 'Low'; }

  function trendText(dir, key, goodDown, unit) {
    const d = dir && dir[key];
    if (!d || !isFinite(d.change)) return '';
    const ch = d.change;
    if (Math.abs(ch) < 0.05) return 'Stable across the period (last 3 vs first 3 months within ±5%).';
    const worse = goodDown ? ch > 0 : ch < 0;
    return `${worse ? 'Worsening' : 'Improving'}: last 3 months ${ch > 0 ? 'up' : 'down'} ${P(Math.abs(ch), 0)} vs the first 3 months${unit ? ' (' + unit + ')' : ''}.`;
  }

  LCI.insights = {
    generate(ctx) {
      const { M, R, ADH, OT, INT, CMP, SAL, F, stores, employees, TR } = ctx;
      const out = [];
      const labor = F.laborCost;
      const sname = (s) => M.storeName[s] || s;
      const ename = (g) => { const e = M.emps.get(g); return e ? e.name : g; };
      const byStore = Object.fromEntries(stores.map((s) => [s.s, s]));
      const monthsN = M.months.length;
      const hasAudit = M.files.some((f) => f.type === 'punchAudit');
      const hasApproval = M.files.some((f) => f.type === 'approval');
      const hasSched = M.schedule.length > 0;
      const add = (o) => { o.id = o.id || 'f' + out.length; out.push(o); };
      const topStores = (key, n, filter) => stores.filter(filter || (() => true)).sort((a, b) => b[key] - a[key]).slice(0, n || 10);
      const topEmps = (key, n, filter) => employees.filter(filter || (() => true)).sort((a, b) => b[key] - a[key]).slice(0, n || 15);
      const persistSet = new Set(TR.persistent.map((p) => p.s));
      const scopeNoun = M.scope && M.scope.kind === 'store' ? M.scope.storeLabel : M.scope && M.scope.kind === 'stores' ? 'The selected stores' : 'Stores';
      // Stores whose paid hours exceeded scheduled hours in every month of the selection.
      const consistent = M.months.length >= 2 ? stores.filter((s) => M.months.every((m) => { const a = ADH.byStoreMonth[s.s + '|' + m.key]; return a && a.act > a.sch; })) : [];

      // 1 ── Labor above plan (store-day net) ─────────────────────────────────────────────
      if (hasSched && F.overPlan.min > 0) {
        const op = F.overPlan;
        const top = topStores('overPlanCost', 10);
        const share5 = U.sum(top.slice(0, Math.max(1, Math.round(stores.length * 0.1))).map((s) => s.overPlanCost)) / Math.max(1, op.cost);
        add({
          id: 'over-plan', category: 'Schedule vs actual', kind: 'confirmed', confidence: 'High',
          title: `${$(op.cost)} paid for ${H(op.min)} worked above ${M.scope && M.scope.kind === 'store' ? 'the store\'s own schedule' : 'stores\' own schedules'}`,
          severity: sevCost(op.cost, labor),
          what: `On ${P(op.days / Math.max(1, op.storeDays), 0)} of store-days, total paid hours exceeded the hours each store had scheduled. Netted store by store and day by day (so covering for an absent colleague cancels out), the excess is ${H(op.min)}, ${P(op.min / Math.max(1, F.schedHours * 60))} of scheduled hours.`,
          where: `Highest: ${list(top.slice(0, 3).map((s) => `${s.name} (${H(s.overPlanHrs * 60)}, ${P(s.overPlanPct)} over plan)`))}. The top 10% of stores account for ${P(share5, 0)} of the excess.`,
          why: 'Hours above plan are paid at full rate and are not backed by the schedule (and therefore not by the sales forecast that built it). They are the pool from which avoidable cost is drawn.',
          evidence: [
            `Store-days over plan: ${N(op.days)} of ${N(op.storeDays)}.`,
            consistent.length ? `${N(consistent.length)} store${consistent.length > 1 ? 's' : ''} paid more hours than scheduled in every one of the ${M.months.length} months: ${list(consistent.slice().sort((a, b) => b.varPct - a.varPct).slice(0, 5).map((s) => `${s.name} (+${(s.varPct * 100).toFixed(1)}%)`), 5)}.` : '',
            `Gross individual extra time ${H(F.grossAddMin)}; ${H(F.gapCovered)} of it filled gaps left by no-shows, late arrivals or early leaves and is not counted here.`,
            TR.persistent.length ? `${TR.persistent.length} store(s) were in the top quartile for over-plan cost per paid hour in at least ${R.persistentMonths.value} of ${monthsN} months.` : '',
            trendText(TR.dir, 'varPct', true, 'actual vs scheduled hours'),
          ].filter(Boolean),
          action: 'Give each store manager a daily "scheduled vs paid" view and set a weekly tolerance (for example 2% over schedule). Stores above it review clock-outs and unscheduled shifts before payroll closes.',
          impact: { hours: op.min / 60, cost: op.cost, label: `${$(op.cost)} at actual pay rates`, basis: 'Σ store-day max(0, paid − scheduled) × that store-day’s average paid rate' },
          recurrence: TR.persistent.length ? 'Recurring' : 'Mixed',
          drill: { type: 'stores', key: 'overPlanCost', rows: topStores('overPlanCost', 25).map((s) => s.s) },
        });
      }

      // 2 ── Unscheduled work ─────────────────────────────────────────────────────────────
      if (hasSched && ADH.tot.unsch > 0) {
        const t = ADH.tot;
        const ew = Object.values(ADH.empWeek).filter((w) => w.act > 0);
        const zeroWeeks = ew.filter((w) => w.sch === 0);
        const unschDays = t.nUnschDays;
        const dowRate = Object.entries(ADH.byDow).map(([d, a]) => ({ d: +d, r: a.act ? a.unsch / a.act : 0 })).sort((a, b) => b.r - a.r);
        const top = topStores('unschUncovered', 10);
        const recurring = employees.filter((e) => e.unschWeeks >= R.recurringWeeks.value).length;
        add({
          id: 'unscheduled', category: 'Schedule vs actual', kind: 'validate', confidence: 'Medium',
          title: `Unscheduled shifts: ${$(t.cUnsch)} of pay on ${H(t.unsch)} worked with no shift on the schedule (${P(t.unsch / Math.max(1, t.act))} of paid hours)`,
          severity: sevCost(t.cUnsch, labor),
          what: `${H(t.unsch)} were paid on shifts that do not overlap any scheduled shift for that GEID — mostly whole days (${N(unschDays)} employee-days) where the employee was not on the schedule at all. ${N(zeroWeeks.length)} employee-weeks had paid hours but zero scheduled hours.`,
          where: `Most unscheduled time not explained by same-day gaps: ${list(top.slice(0, 3).map((s) => `${s.name} (${H(s.unschUncovered)})`))}. Highest on ${U.DOW[dowRate[0].d]} and ${U.DOW[dowRate[1].d]} (${P(dowRate[0].r)} and ${P(dowRate[1].r)} of paid hours) vs ${P(dowRate[dowRate.length - 1].r)} on ${U.DOW[dowRate[dowRate.length - 1].d]}.`,
          why: 'Unscheduled shifts bypass the forecast-based schedule. Some are legitimate call-ins replacing absent staff, but when the schedule is not updated the store loses visibility of what it is actually deploying, and overtime and over-plan hours follow.',
          evidence: [
            `Unscheduled paid time: ${H(t.unsch)} (${$(t.cUnsch)} at actual rates).`,
            `Of it, ${H(t.unschUncovered)} exceeds the same store-day's no-show / late / early-leave gaps (not replacement cover).`,
            `${N(recurring)} employees worked unscheduled shifts in ${R.recurringWeeks.value}+ different weeks.`,
            trendText(TR.dir, 'unschPer100', true, 'unscheduled hours per 100 paid hours'),
          ].filter(Boolean),
          action: 'Require a schedule change (or a manager authorisation at the clock) before an unscheduled employee can clock in. The clock supports this: enable "manager authorization when no shift is scheduled" (SOS_VOIL / mgrSOS). Review recurring unscheduled employees with store managers.',
          impact: { hours: t.unschUncovered / 60, cost: t.cUnsch * (t.unschUncovered / Math.max(1, t.unsch)), label: `${H(t.unschUncovered)} not explained by coverage gaps — needs review`, basis: 'Not counted as avoidable: requires validation of call-in reasons.' },
          recurrence: 'Recurring',
          drill: { type: 'employees', key: 'unsch', rows: topEmps('unsch', 30).map((e) => e.g) },
        });
      }

      // 3 / 4 ── Late clock-out and early clock-in ────────────────────────────────────────
      const shiftRows = Object.entries(ADH.byShift).filter(([k]) => k !== 'Unscheduled');
      const mkPunchInsight = (kind) => {
        const late = kind === 'late';
        const t = ADH.tot;
        const gross = late ? t.late : t.early, cost = late ? t.cLate : t.cEarly;
        const beyond = late ? t.avLate : t.avEarly, ev = late ? t.nLateEv : t.nEarlyEv, viol = late ? t.nLateViol : t.nEarlyViol;
        const av = late ? F.avoid.late : F.avoid.early;
        if (gross <= 0) return;
        const key = late ? 'late' : 'early';
        const conc = U.topShare(employees.map((e) => e[key]), 0.1);
        const recurring = employees.filter((e) => (late ? e.recurringLate : e.recurringEarly));
        const sh = shiftRows.map(([k, a]) => ({ k, v: late ? a.late : a.early, act: a.act })).sort((a, b) => b.v - a.v);
        const topS = topStores(late ? 'late' : 'early', 10);
        const label = late ? 'Late clock-outs' : 'Early clock-ins';
        add({
          id: late ? 'late-out' : 'early-in', category: 'Punch adherence', kind: 'estimate', confidence: 'Medium',
          title: `${label} cost ${$(cost)} in additional pay — ${$(av.cost)} estimated avoidable (${H(gross)})`,
          severity: sevCost(av.cost, labor),
          what: `${N(ev)} shifts ${late ? 'ended' : 'started'} more than ${R.punchTolerance.value} minutes ${late ? 'after' : 'before'} the scheduled ${late ? 'end' : 'start'} (${N(viol)} by more than ${R.punchViolation.value} minutes — the clock's violation threshold). Minutes beyond the ${R.punchTolerance.value}-minute tolerance total ${H(beyond)}.`,
          where: `${P(sh[0].v / Math.max(1, gross), 0)} of the time comes from ${sh[0].k.toLowerCase()} shifts. Top stores: ${list(topS.slice(0, 3).map((s) => `${s.name} (${H(late ? s.late : s.early)})`))}. The top 10% of employees account for ${P(conc, 0)}; ${N(recurring.length)} employees repeat it in ${R.recurringWeeks.value}+ weeks.`,
          why: late
            ? 'Staying on the clock after the scheduled end is paid time the schedule did not plan for. Repeated late clock-outs on the same shift usually mean a handover or closing task that is not scheduled, or no one checking clock-outs.'
            : 'Clocking in before the scheduled start is paid time the schedule did not plan for. Early clock-ins rarely add sales capacity and often reflect employees arriving early and clocking straight in.',
          evidence: [
            `Gross ${label.toLowerCase()} ${H(gross)} = ${$(cost)} at each employee's actual rate (${$(cost / Math.max(1e-9, gross / 60))} per hour on average) across ${N(employees.filter((e) => e[key] > 0).length)} employees at ${N(stores.filter((x) => x[key] > 0).length)} stores.`,
            `Highest cost: ${list(stores.slice().sort((a, b) => (late ? b.cLate - a.cLate : b.cEarly - a.cEarly)).slice(0, 3).map((x) => `${x.name} ${$(late ? x.cLate : x.cEarly)}`))}; top employees ${list(employees.slice().sort((a, b) => (late ? b.cLate - a.cLate : b.cEarly - a.cEarly)).slice(0, 3).map((e) => `${e.name} (GEID ${e.g}) ${$(late ? e.cLate : e.cEarly)}`))}.`,
            `Beyond tolerance (before netting): ${H(beyond)}. After capping at each store-day's labor above plan: ${H(av.min)} = ${$(av.cost)}.`,
            ...sh.map((s) => `${s.k}: ${H(s.v)} (${P(s.act ? s.v / s.act : 0, 2)} of that shift type's paid time).`),
            trendText(TR.dir, late ? 'latePer100' : 'earlyPer100', true, 'per 100 paid hours'),
          ].filter(Boolean),
          action: late
            ? `Turn on manager authorization for clock-outs more than ${R.punchTolerance.value} minutes after shift end (mgrClkOutAfterEndShift). Add the recurring end-of-shift tasks to the schedule where they are real, and coach the recurring employees listed here.`
            : `Turn on manager authorization for clock-ins more than ${R.punchTolerance.value} minutes before shift start (mgrSOS, early window ${R.punchTolerance.value} min). Ask employees who arrive early to wait to clock in; review the recurring employees listed here.`,
          impact: { hours: av.min / 60, cost: av.cost, label: `${$(av.cost)} estimated avoidable`, basis: `Minutes beyond ${R.punchTolerance.value}-min tolerance × actual rate, capped at store-day labor above plan` },
          recurrence: recurring.length ? 'Recurring' : 'Isolated',
          drill: { type: 'employees', key: late ? 'late' : 'early', rows: topEmps(late ? 'late' : 'early', 30).map((e) => e.g) },
        });
      };
      if (hasSched) { mkPunchInsight('late'); mkPunchInsight('early'); }

      // 5 ── Skipped scheduled meals + missing meal records ───────────────────────────────
      if (hasSched && ADH.tot.nMealPlanned > 0) {
        const t = ADH.tot, b = CMP.breaks;
        const noRec = Object.entries(b.byStore).filter(([, x]) => x.eligible >= 50 && x.missed / x.eligible >= 0.99).map(([s]) => s);
        add({
          id: 'meal-skip', category: 'Breaks', kind: 'estimate', confidence: 'Medium',
          title: `Skipped planned meals cost ${$(t.cMealSkip)} — worked through on ${P(t.nMealSkipped / Math.max(1, t.nMealPlanned), 0)} of shifts that had one`,
          severity: sevCost(F.avoid.mealSkip.cost, labor),
          what: `The schedule planned an unpaid meal break on ${N(t.nMealPlanned)} shifts. On ${N(t.nMealSkipped)} of them the employee stayed on the clock and no (or a shorter) meal break was recorded, turning ${H(t.mealSkip)} of planned unpaid time into paid time.`,
          where: noRec.length ? `${noRec.length} stores record almost no meal breaks at all (≥99% of 6h+ shifts without one): ${list(noRec.slice(0, 6).map(sname), 6)}.` : `Spread across stores; see the store list.`,
          why: 'A scheduled meal that is not taken is paid at full rate and, depending on state law, can also be a meal-break violation. Where stores do not punch breaks at all, neither cost nor compliance can be verified.',
          evidence: [
            `Paid shifts longer than ${R.mealRequiredAfter.value / 60} h: ${N(b.eligibleDays)}; with no meal break recorded: ${N(b.missed)} (${P(b.missed / Math.max(1, b.eligibleDays), 0)}), ${N(b.missedEmployees)} employees.`,
            `Meal breaks shorter than ${R.minMealLength.value} min: ${N(b.short)}.`,
            CMP.exceptions.breakTypesFlagged.length === 0 && M.files.some((f) => f.type === 'exception') ? 'The clock\'s exception report flags no break violations for production stores, so break rules appear not to be enforced on the clock.' : '',
            CMP.premium.rows === 0 ? 'No meal-break premium pay was recorded for production stores.' : `Premium pay recorded: ${$(CMP.premium.amount)}.`,
          ].filter(Boolean),
          action: 'Require meal-break punches (Start/End Meal) on every shift that has a scheduled meal, and enable the clock\'s meal-break rules and warnings for the applicable state. Stores with no break records should start punching breaks immediately.',
          impact: { hours: F.avoid.mealSkip.min / 60, cost: F.avoid.mealSkip.cost, label: `${$(F.avoid.mealSkip.cost)} estimated avoidable + compliance risk`, basis: 'Skipped planned meal minutes × actual rate, capped at store-day labor above plan' },
          recurrence: 'Recurring',
          drill: { type: 'stores', key: 'missedMealPct', rows: stores.filter((s) => isFinite(s.missedMealPct)).sort((a, b) => b.missedMealPct - a.missedMealPct).slice(0, 30).map((s) => s.s) },
        });
      }

      // 6 ── Overtime premium ────────────────────────────────────────────────────────────
      if (OT.tot.prem > 0) {
        const o = OT.tot;
        const recurring = employees.filter((e) => e.recurringOt);
        const conc = U.topShare(employees.map((e) => e.otHrs), 0.1);
        const topS = Object.entries(OT.byStore).sort((a, b) => b[1].prem - a[1].prem).slice(0, 3);
        const schedShare = o.schedOt / Math.max(1, o.ot + o.dt);
        add({
          id: 'overtime', category: 'Overtime', kind: 'confirmed', confidence: 'High',
          title: `Overtime premium cost ${$(o.prem)}; ${P(schedShare, 0)} of OT hours were already in the schedule`,
          severity: sevCost(o.prem, labor),
          what: `${H(o.ot + o.dt)} of overtime across ${N(o.otWeeks)} employee-weeks (threshold ${R.weeklyOtThreshold.value / 60} h/week, inferred from paid OT). ${H(o.schedOt)} of it would have happened even if everyone had worked exactly to schedule — the schedule itself put them over ${R.weeklyOtThreshold.value / 60} hours. The other ${H(o.driftOt)} came from working beyond the schedule.`,
          where: `Top stores by OT premium: ${list(topS.map(([s, x]) => `${sname(s)} (${$(x.prem)})`))}. The top 10% of employees generate ${P(conc, 0)} of OT hours; ${N(recurring.length)} employees had OT in ${R.recurringWeeks.value}+ weeks.`,
          why: 'Only the premium (the extra half-time) is counted here, so it never double-counts the base pay already in paid hours. Scheduled OT is avoidable by spreading hours to employees under 40; drift OT is avoidable by controlling extra time on the clock.',
          evidence: [
            `Premium from schedule-driven OT: ${$(o.premSched)}; from drift beyond schedule: ${$(o.premDrift)}.`,
            OT.multiStoreOt.weeks ? `${N(OT.multiStoreOt.weeks)} OT weeks involved employees working at more than one store (${$(OT.multiStoreOt.prem)} premium) — hard for a single store manager to see.` : '',
            OT.tot.over40NoOt ? `${N(OT.tot.over40NoOt)} employee-weeks exceeded ${R.weeklyOtThreshold.value / 60} h with no OT paid, mainly ${list(Object.entries(OT.noOtByJob).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([j]) => j))} — consistent with OT-exempt roles; not treated as leakage.` : '',
            OT.noPremium.min > 0 ? `${H(OT.noPremium.min)} of OT (${N(OT.noPremium.emps)} employees) was paid at straight time or $0 — no premium is counted for it; confirm exemption or pay set-up.` : '',
            OT.truncatedLastWeek ? 'The last week of the period is cut off at the period end, so its OT may be understated.' : '',
            trendText(TR.dir, 'otPer100', true, 'OT hours per 100 paid hours'),
          ].filter(Boolean),
          action: `Stop publishing schedules that put hourly employees over ${R.weeklyOtThreshold.value / 60} h: add a pre-publish OT check and move the hours to employees with capacity. For drift OT, alert managers mid-week when an employee is within 4 hours of the threshold.`,
          impact: { hours: (o.ot + o.dt) / 60, cost: o.prem, label: `${$(o.premDrift)} drift premium counted as avoidable; ${$(o.premSched)} avoidable by re-scheduling`, basis: 'OT pay − OT hours × base rate, from the payroll export' },
          recurrence: recurring.length ? 'Recurring' : 'Isolated',
          drill: { type: 'employees', key: 'otPrem', rows: topEmps('otPrem', 30).map((e) => e.g) },
        });
      }

      // 7 ── Manual punches (main leakage category) ──────────────────────────────────────
      // Identified by the paid punch's Source Id = MANUAL (product: device MANUAL = 0, a manager-entered
      // punch). PIN ("Password") and other device punches are NOT treated as manual.
      const MP = F.manual;
      if (MP && MP.n > 0) {
        const mn = INT.manual;
        const topS = stores.filter((s) => s.manN > 0).sort((a, b) => b.manMin - a.manMin);
        const topE = employees.filter((e) => e.manN > 0).sort((a, b) => b.manMin - a.manMin);
        const recurringE = employees.filter((e) => e.recurringManual);
        const months = TR.series.filter((x) => isFinite(x.manualPct));
        const peak = months.slice().sort((a, b) => b.manualPct - a.manualPct)[0];
        const qMan = ADH.bySource.MANUAL ? ADH.bySource.MANUAL.qIn / Math.max(1, ADH.bySource.MANUAL.n) : NaN;
        const extra = MP.early + MP.late + MP.unsch;
        const topEShare = U.sum(topE.slice(0, Math.max(1, Math.round(topE.length * 0.1))).map((e) => e.manMin)) / Math.max(1, MP.min);
        add({
          id: 'manual-time', category: 'Punch adherence', kind: 'estimate', confidence: 'Medium',
          title: `Manual punches: ${$(MP.extraCost)} of additional pay was recorded through ${N(MP.n)} keyed-in punches (${P(MP.share)} of paid hours)`,
          severity: MP.share >= 0.08 ? 'Critical' : MP.share >= 0.03 ? 'High' : sevCost(MP.avoidCost, labor),
          what: `${N(MP.n)} paid punches by ${N(MP.emps)} employees at ${N(MP.stores)} store${MP.stores === 1 ? '' : 's'} were entered manually by a manager (punch source "MANUAL"), carrying ${$(MP.pay)} of pay. ${H(extra)} of the time outside the schedule (early starts ${H(MP.early)}, late finishes ${H(MP.late)}, unscheduled ${H(MP.unsch)}) was recorded through these manual punches.${hasAudit && mn.withLag ? ` ${P(mn.retro / mn.withLag, 0)} of manual entries were keyed more than ${R.retroLag.value} minutes after the time they record (median delay ${(mn.medianLag / 60).toFixed(1)} h).` : ''}`,
          where: `${topS.length > 1 ? `Most manual hours: ${list(topS.slice(0, 3).map((s) => `${s.name} (${H(s.manMin)}, ${P(s.manShare)} of its paid hours)`))}. ` : ''}Top employees: ${list(topE.slice(0, 3).map((e) => `${e.name} · GEID ${e.g} (${N(e.manN)} punches)`))}; the top 10% of these employees hold ${P(topEShare, 0)} of manual hours.${peak && months.length > 1 ? ` Peak month ${peak.label} (${P(peak.manualPct)} of punch events).` : ''}`,
          why: 'A manual punch is an estimate of when someone worked, not a record of it. Most are legitimate (forgotten punch, clock down), but they bypass the clock\'s schedule controls, so early starts and late finishes entered this way cannot be verified. Not every manual punch is a violation — the review targets the patterns below.',
          evidence: [
            `Additional pay recorded through manual punches: ${$(MP.extraCost)} (early starts, late finishes and unscheduled shifts keyed in by hand). Pay on all manual time: ${$(MP.pay)} — exposure, not loss.`,
            `Minutes beyond the ${R.punchTolerance.value}-min tolerance on manual punches: ${H(MP.beyondTolMin)}; after store-day netting ${H(MP.avoidMin)} (${$(MP.avoidCost)}) — part of the avoidable total, not in addition to it.`,
            MP.edited ? `${N(MP.edited)} manual punches were edited afterwards (+${H(MP.editAddMin)} / −${H(MP.editRemMin)} paid time).` : '',
            isFinite(qMan) ? `${P(qMan, 0)} of manual clock-in times fall exactly on :00/:15/:30/:45, vs ${P(INT.quarter.origShare, 0)} for device-captured punches.` : '',
            `${N(recurringE.length)} employees have manual punches in ${R.recurringWeeks.value}+ different weeks.`,
            trendText(TR.dir, 'manualPct', true, 'share of punch events entered manually'),
          ].filter(Boolean),
          action: 'Review the listed stores and recurring employees weekly: require a reason code and same-shift entry for every manual punch, flag manual punches that start before or end after the scheduled shift, and fix clock availability where manual entry is persistent.',
          impact: { hours: MP.min / 60, cost: MP.extraCost, label: `${$(MP.extraCost)} additional pay via manual punches · ${$(MP.avoidCost)} avoidable (review) — overlaps early/late/unscheduled, not additive`, basis: 'Avoidable = beyond-tolerance early/late minutes on manual punches × rate, capped at store-day labor above plan; already inside the avoidable total' },
          recurrence: recurringE.length ? 'Recurring' : 'Isolated',
          drill: topS.length > 1 ? { type: 'stores', key: 'manual', rows: topS.slice(0, 30).map((s) => s.s) } : { type: 'employees', key: 'manual', rows: topE.slice(0, 40).map((e) => e.g) },
        });
      }

      // 8 ── Edits that add paid time ────────────────────────────────────────────────────
      if (INT.tot.edited > 0) {
        const t = INT.tot;
        const remNonForgot = t.remMin - t.forgotMin;
        const net = t.addMin - remNonForgot;
        const topE = topEmps('editAddMin', 30);
        const topS = Object.entries(INT.byStore).sort((a, b) => b[1].addCost - a[1].addCost).slice(0, 3);
        add({
          id: 'edits-add', category: 'Punch integrity', kind: 'validate', confidence: 'Medium',
          title: `Punch edits added a net ${$(F.edits.netCost)} of paid time — ${(t.addMin / Math.max(1, remNonForgot)).toFixed(1)}× more added than removed, outside forgotten clock-outs`,
          severity: sevCost(t.addCost, labor),
          what: `${N(t.edited)} paid punches (${P(t.edited / Math.max(1, t.punches))}) have an adjusted time different from the original. Edits added ${H(t.addMin)} (${$(t.addCost)}) and removed ${H(t.remMin)}, but ${H(t.forgotMin)} of the removals were corrections of forgotten clock-outs on ${N(t.forgotOut)} punches ≥ ${R.autoClosePunch.value / 60} h. Excluding those, edits are a net +${H(net)}.`,
          where: `Most time added: ${list(topS.map(([s, x]) => `${sname(s)} (${H(x.addMin)})`))}.`,
          why: 'Most edits are legitimate corrections, but edits that consistently move clock-ins earlier or clock-outs later raise payable time without a device record. The pattern is a review signal, not proof of intent.',
          evidence: [
            `${N(t.snap)} edits moved a punch exactly onto the scheduled start or end time (adding ${H(t.snapMin)}).`,
            INT.quarter.editedShare != null ? `${P(INT.quarter.editedShare, 0)} of edited times land on :00/:15/:30/:45, vs ${P(INT.quarter.origShare, 0)} of device-captured punches (${P(INT.quarter.naturalShare, 0)} expected by chance) — edited times are mostly estimates.` : '',
            `Clock-ins moved earlier: ${N(t.inEarlier)}; clock-outs moved later: ${N(t.outLater)}.`,
          ].filter(Boolean),
          action: 'Require a reason code and a second approver for any edit that increases paid time by more than 15 minutes, and flag edits that set a punch exactly to the scheduled time. Review the employees listed here with their store managers.',
          impact: { hours: net / 60, cost: F.edits.netCost, label: `net ${$(F.edits.netCost)} (+${H(net)}) paid time from edits — overlaps the adherence categories, not additive`, basis: 'Adjusted − original punch length on paid punches, at that punch’s rate' },
          recurrence: 'Recurring',
          drill: { type: 'employees', key: 'editAddMin', rows: topE.map((e) => e.g) },
        });
      }

      // 9 ── Self-edits & shared logins ──────────────────────────────────────────────────
      if (hasApproval && INT.approvals.edits) {
        const a = INT.approvals;
        const selfEds = INT.editors.filter((e) => e.self > 0).sort((x, y) => y.self - x.self);
        if (a.selfEdits > 0) {
          add({
            id: 'self-edits', category: 'Edit controls', kind: 'validate', confidence: 'Medium',
            title: `${N(selfEds.length)} managers changed their own punches ${N(a.selfEdits)} times`,
            severity: sevShare(a.selfEdits / Math.max(1, a.edits), 0.05, 0.01),
            what: `${N(a.selfEdits)} punch changes (${P(a.selfEdits / Math.max(1, a.edits))} of all edits) were made by a user whose name matches the employee whose punch was changed.`,
            where: `Most frequent: ${list(selfEds.slice(0, 4).map((e) => `${e.display} (${N(e.self)} of ${N(e.rows)} edits)`), 4)}.`,
            why: 'Changing one\'s own time record without a second approver is a basic segregation-of-duties gap, whatever the reason for the change.',
            evidence: ['Editors carry no GEID in the export, so this match is on name only and must be confirmed before any action concerning a person.'],
            action: 'Block users from editing their own punches (route them to their supervisor) and review the listed users\' self-edits for the period.',
            impact: { hours: null, cost: null, label: 'Control risk — needs validation', basis: 'Name match between editor and employee' },
            recurrence: 'Recurring',
            drill: { type: 'editors', key: 'self', rows: selfEds.slice(0, 30).map((e) => e.key) },
          });
        }
        if (a.viaStoreAccount > 0) {
          const share = a.viaStoreAccount / Math.max(1, a.viaStoreAccount + a.viaNamedUser);
          add({
            id: 'shared-accounts', category: 'Edit controls', kind: 'risk', confidence: 'High',
            title: `${P(share, 0)} of punch changes were made through shared store logins, not named users`,
            severity: sevShare(share, 0.4, 0.15),
            what: `${N(a.viaStoreAccount)} edits were made from generic store-level manager accounts. The audit trail shows which store, but not which person, made the change.`,
            where: `Busiest store accounts: ${list(INT.editors.filter((e) => e.kind === 'storeAccount').slice(0, 3).map((e) => `${e.display} (${N(e.rows)})`))}.`,
            why: 'Without a named editor, edit reviews and coaching cannot be targeted and accountability for added time is lost.',
            evidence: [`Named-user edits: ${N(a.viaNamedUser)}; system adjustments: ${N(a.system)}.`, `Human editors in total: ${N(INT.editorConc.editors)}; the top 10% of them made ${P(INT.editorConc.top10share, 0)} of edits.`],
            action: 'Issue named manager logins and retire shared store accounts for timekeeping changes.',
            impact: { hours: null, cost: null, label: 'Control risk', basis: 'Editor field of the punch-change report' },
            recurrence: 'Recurring',
            drill: { type: 'editors', key: 'rows', rows: INT.editors.filter((e) => e.kind !== 'system').slice(0, 30).map((e) => e.key) },
          });
        }
      }

      // 10 ── Forgotten clock-outs ───────────────────────────────────────────────────────
      if (ADH.longPunches > 0 || INT.tot.forgotOut > 0) {
        const sys = INT.editors.find((e) => e.kind === 'system');
        add({
          id: 'forgotten-out', category: 'Punch integrity', kind: 'confirmed', confidence: 'High',
          title: `${N(INT.tot.forgotOut + ADH.longPunches)} punches ran ${R.autoClosePunch.value / 60}+ hours — forgotten clock-outs`,
          severity: sevShare((INT.tot.forgotOut + ADH.longPunches) / Math.max(1, M.punches.length), 0.01, 0.002),
          what: `${N(INT.tot.forgotOut)} punches originally ran ${R.autoClosePunch.value / 60} hours or more and were later shortened by ${H(INT.tot.forgotMin)}; ${N(ADH.longPunches)} punches are still paid at ${R.autoClosePunch.value / 60}+ hours.`,
          where: `Paid long punches by store are in the store table (column "≥14h punches" in the punch integrity view).`,
          why: 'Each forgotten clock-out has to be reconstructed by hand. When it is not caught, the employee is paid until someone notices; when it is, the corrected time is an estimate.',
          evidence: [sys ? `System auto-adjustments: ${N(sys.rows)} records changing ${H(sys.remMin)} of time.` : '', `The clock can auto-close open punches after ${R.autoClosePunch.value / 60} h (closePunIfEmpClockExceedsXMins).`].filter(Boolean),
          action: `Review every paid punch longer than 12 hours before payroll closes, and set the clock to auto-close open punches at a shorter limit with a manager follow-up.`,
          impact: { hours: null, cost: null, label: `${N(ADH.longPunches)} paid punches ≥ ${R.autoClosePunch.value / 60} h to verify`, basis: 'Punch length' },
          recurrence: 'Recurring',
          drill: { type: 'records', key: 'longPunches' },
        });
      }

      // 11 ── Biometric adoption ─────────────────────────────────────────────────────────
      if (hasAudit && INT.biometric.total) {
        const b = INT.biometric;
        const pin = INT.methods.PASSWORD || INT.methods.PIN || 0;
        add({
          id: 'biometric', category: 'Punch integrity', kind: b.comparable ? 'confirmed' : 'risk', confidence: 'High',
          title: b.comparable ? `Biometric punches cover ${P(b.share)} of punch events` : `Biometric punching is effectively unused (${P(b.share, 3)} of punch events)`,
          severity: b.comparable ? 'Low' : 'High',
          what: `Of ${N(b.total)} clock-in/out events, ${N(b.events)} were biometric. ${P(pin / b.total, 0)} were PIN/password punches and ${P((INT.methods.MANUAL || 0) / b.total, 0)} were keyed in manually.${b.comparable ? '' : ' There are too few biometric punches to compare violation or edit rates against PIN punches, so no claim is made that biometric punching would be more accurate here.'}`,
          where: `Biometric events appear at ${N(b.storesUsing)} store(s), in tiny numbers.`,
          why: 'PIN punches can be made by anyone who knows the PIN (buddy punching), and manual entries bypass the clock entirely. Identity-verified punching is the main control that would make clock time trustworthy without after-the-fact review.',
          evidence: [Object.entries(INT.methods).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}: ${N(v)}`).join(' · ')],
          action: 'Pilot biometric (face or fingerprint) punching at the stores with the highest manual-entry and edit rates, then compare their edit and adherence rates with comparable stores before rolling out.',
          impact: { hours: null, cost: null, label: 'Control gap — measure in a pilot', basis: 'Punch method in the audit log' },
          recurrence: 'Recurring',
          drill: { type: 'stores', key: 'manualPct', rows: stores.slice().sort((x, y) => y.manualPct + y.editPct - (x.manualPct + x.editPct)).slice(0, 20).map((s) => s.s) },
        });
      }

      // 12 ── Minors not flagged ─────────────────────────────────────────────────────────
      if (CMP.minors.punches > 0) {
        const mn = CMP.minors;
        const topS = Object.entries(mn.byStore).sort((a, b) => b[1].lateNight - a[1].lateNight).slice(0, 3);
        add({
          id: 'minors', category: 'Compliance', kind: 'risk', confidence: 'High',
          title: `${N(mn.flagMismatchEmployees)} employees under ${R.minorAge.value} are not flagged as minors on their punches`,
          severity: mn.flagNo / mn.punches > 0.5 ? 'Critical' : 'High',
          what: `${N(mn.flagNo)} of ${N(mn.punches)} punches by employees younger than ${R.minorAge.value} (by the Age field) carry Minor = "No"${mn.schedFlagged ? `, although ${N(mn.schedFlagged)} employees are flagged as minors in the schedule` : ''}. ${N(mn.lateNight)} of their punches ended after ${R.minorLateHour.value / 60}:00, by ${N(mn.lateNightEmployees)} employees; ${N(mn.longDays)} were longer than 8 hours.`,
          where: `Most late-night minor punches: ${list(topS.map(([s, x]) => `${sname(s)} (${N(x.lateNight)})`))}.`,
          why: 'The clock applies minor labor-law rules (earliest start, latest end, daily/weekly maximums) only to employees flagged as minors. Unflagged minors bypass those controls — a regulatory exposure, not a payroll cost.',
          evidence: [`Minor employee-weeks over ${R.weeklyOtThreshold.value / 60} h: ${N(mn.over40Weeks)}.`, 'Late-night and maximum-hour limits vary by state and school week; the 22:00 marker is a review threshold, not a legal finding.'],
          action: 'Correct the minor flag in the timekeeping employee record for every employee under 18, enable minor rules on the clock (earliest start / latest end / max hours), and review the late-night shifts listed.',
          impact: { hours: null, cost: null, label: 'Compliance risk', basis: 'Age vs Minor flag on punch records' },
          recurrence: 'Recurring',
          drill: { type: 'stores', key: 'minorLate', rows: topS.map(([s]) => s).concat(Object.keys(mn.byStore).sort((a, b) => mn.byStore[b].lateNight - mn.byStore[a].lateNight).slice(3, 25)) },
        });
      }

      // 13 ── Missing Payroll IDs ────────────────────────────────────────────────────────
      const noPid = M.punches.filter((p) => p.noPayrollId);
      if (noPid.length) {
        const pay = U.sum(noPid.map((p) => p.pay || 0)), mins = U.sum(noPid.map((p) => p.tot || 0));
        const emps = new Set(noPid.map((p) => p.g));
        add({
          id: 'payroll-id', category: 'Data integrity', kind: 'risk', confidence: 'High',
          title: `${$(pay)} of paid time sits on punches with no Payroll ID`,
          severity: sevCost(pay * 0.05, labor),
          what: `${N(noPid.length)} paid punches (${H(mins)}) for ${N(emps.size)} employees have no Payroll ID, although they carry a GEID and pay.`,
          where: 'Affects employees across stores; see the employee list.',
          why: 'If timekeeping and payroll are linked by Payroll ID, these hours either fail to transfer or are matched manually — both are reconciliation risks.',
          evidence: ['GEID is present on all of these punches, so the analysis still attributes them correctly.'],
          action: 'Complete the Payroll ID for every active employee in the timekeeping record and reconcile these hours against payroll for the period.',
          impact: { hours: mins / 60, cost: pay, label: `${$(pay)} to reconcile`, basis: 'Exposure, not loss' },
          recurrence: 'Recurring',
          drill: { type: 'employees', key: 'paidHrs', rows: [...emps].sort((a, b) => (ADH.byEmp[b] ? ADH.byEmp[b].act : 0) - (ADH.byEmp[a] ? ADH.byEmp[a].act : 0)).slice(0, 30) },
        });
      }

      // 13b ── Pay-rate anomalies ───────────────────────────────────────────────────────
      if (ADH.rateOutliers.length) {
        const ro = ADH.rateOutliers;
        const pay = U.sum(ro.map((p) => p.pay || 0));
        const atNormal = U.sum(ro.map((p) => ((p.tot || 0) / 60) * (ADH.empRate.get(p.g) || 0)));
        const emps = new Set(ro.map((p) => p.g));
        const ex = ro.slice().sort((a, b) => b.rate - a.rate)[0];
        add({
          id: 'pay-anomaly', category: 'Data integrity', kind: 'validate', confidence: 'High',
          title: `${N(ro.length)} punches were paid at more than 3× the employee's usual rate (${$(pay)})`,
          severity: sevCost(pay - atNormal, labor),
          what: `${N(ro.length)} paid punches for ${N(emps.size)} employees carry an hourly rate over three times that employee's median rate — for example ${ex.job || 'an employee'} at ${$(ex.rate)}/h on ${U.isoDay(ex.day)}. Pay on these rows is ${$(pay)}; at each employee's normal rate it would be about ${$(atNormal)}.`,
          where: list([...new Set(ro.map((p) => sname(p.s)))].slice(0, 6), 6),
          why: 'A salary, bonus or correction keyed as an hourly rate inflates labor cost and distorts every per-hour KPI. Leakage estimates in this report cost those rows at the employee\'s normal rate so they are not inflated.',
          evidence: ['Rows are kept in actual labor expenditure (they were paid); only the costing of extra minutes uses the normal rate.'],
          action: 'Confirm each listed punch with payroll; move bonuses and salary adjustments to the correct pay code instead of an hourly rate.',
          impact: { hours: null, cost: pay - atNormal, label: `${$(pay - atNormal)} above normal rates — verify`, basis: 'Pay − hours × employee median rate' },
          recurrence: 'Isolated',
          drill: { type: 'records', key: 'rateOutliers' },
        });
      }

      // 14 ── Monthly sales vs labor ─────────────────────────────────────────────────────
      if (SAL.available) {
        const ps = SAL.perStore;
        const nf = ps.filter((x) => x.nonFlex.length);
        const nfHrs = U.sum(nf.map((x) => x.nonFlexExcessHrs)), nfCost = U.sum(nf.map((x) => x.nonFlexExcessCost));
        if (nf.length) {
          const top = nf.slice().sort((a, b) => b.nonFlexExcessHrs - a.nonFlexExcessHrs).slice(0, 3);
          const ev = U.sum(nf.map((x) => x.nonFlex.length));
          add({
            id: 'sales-flex', category: 'Sales & labor', kind: 'estimate', confidence: 'Medium',
            title: `≈${$(nfCost)} of labor in ${N(ev)} store-months where sales fell but paid hours rose`,
            severity: sevCost(nfCost, labor),
            what: `${N(nf.length)} of ${N(ps.length)} stores had at least one month where actual sales dropped more than 3% from the previous month while paid hours increased. Holding the previous month's sales per labor hour, those months used ${N(nfHrs)} more hours than the lower sales justified.`,
            where: `Largest: ${list(top.map((x) => `${sname(x.s)} (${N(x.nonFlexExcessHrs)} h over ${x.nonFlex.length} month${x.nonFlex.length > 1 ? 's' : ''})`))}.`,
            why: 'When labor does not come down with demand, labor % rises and SPLH falls. Monthly data shows the mismatch exists; it cannot show which days or hours caused it.',
            evidence: [`Company SPLH ${SAL.tot.splh.toFixed(1)}, labor ${P(SAL.tot.laborPct)} of sales, sales achievement ${P(SAL.tot.ach)} of forecast over the period.`, 'Sales data are monthly; no daily or hourly sales relationship is inferred.'],
            action: 'Set monthly labor-hour budgets from the sales forecast and review stores whose hours rise while sales fall at the first weekly payroll review of the month.',
            impact: { hours: nfHrs, cost: nfCost, label: `≈${$(nfCost)} (estimate, not additive)`, basis: 'Hours above previous-month SPLH × store average rate' },
            recurrence: nf.some((x) => x.nonFlex.length >= 2) ? 'Recurring' : 'Isolated',
            drill: { type: 'stores', key: 'nonFlex', rows: nf.sort((a, b) => b.nonFlexExcessHrs - a.nonFlexExcessHrs).slice(0, 30).map((x) => x.s) },
          });
        }
        // Forecast anomalies (store-months where forecast is > 2× or < 0.5× actual)
        const anom = SAL.table.filter((x) => x.as > 0 && x.fs > 0 && (x.fs / x.as > 2 || x.fs / x.as < 0.5));
        if (anom.length) {
          add({
            id: 'forecast-anomaly', category: 'Data integrity', kind: 'validate', confidence: 'High',
            title: `${N(anom.length)} store-month forecast(s) are more than double (or under half) actual sales`,
            severity: 'Medium',
            what: `Forecast sales were far from actual in: ${list(anom.slice(0, 5).map((x) => `${sname(x.s)} ${x.month} (forecast ${$(x.fs)} vs actual ${$(x.as)})`), 5)}.`,
            where: list([...new Set(anom.map((x) => sname(x.s)))], 6),
            why: 'Schedules are built from the forecast. A forecast several times too high would justify far more labor than needed; it also distorts forecast-accuracy and scheduled-SPLH figures.',
            evidence: ['These store-months are kept in totals but flagged; check the forecast inputs (events, manual overrides) for those months.'],
            action: 'Correct or exclude the anomalous forecasts and add a sanity check that blocks a monthly forecast more than 50% away from the trailing average without approval.',
            impact: { hours: null, cost: null, label: 'Forecast data issue', basis: 'forecast / actual monthly' },
            recurrence: 'Isolated',
            drill: { type: 'storeMonths', rows: anom.map((x) => x.s + '|' + x.month) },
          });
        }
        // Peer benchmark (low confidence, not additive)
        const gap = ps.filter((x) => x.peerGapHrs > 0);
        if (gap.length && ps.length >= 6) {
          const top = gap.slice().sort((a, b) => b.peerGapHrs - a.peerGapHrs).slice(0, 3);
          add({
            id: 'peer-splh', category: 'Sales & labor', kind: 'estimate', confidence: 'Low',
            title: `${N(gap.length)} stores run below the SPLH of similar-volume peers`,
            severity: 'Low',
            what: `Compared with the median SPLH of stores in the same sales-volume band (${Object.entries(SAL.tierMed).map(([k, v]) => `${k.toLowerCase()} ${v.toFixed(1)}`).join(', ')}), these stores used ${N(U.sum(gap.map((x) => x.peerGapHrs)))} more hours than a peer-median store would for the same sales.`,
            where: list(top.map((x) => `${sname(x.s)} (SPLH ${x.splh.toFixed(1)} vs ${x.peerSplh.toFixed(1)})`)),
            why: 'A persistent SPLH gap to similar stores points to staffing levels or layout, not to individual punch behaviour. It is a benchmark, not a calculated loss.',
            evidence: ['Not added to avoidable totals. Store format, drive-thru share and hours of operation are not in the dataset and can explain part of the gap.'],
            action: 'Use the gap list to prioritise labor-model reviews (minimum staffing, position charts) at the largest-gap stores.',
            impact: { hours: U.sum(gap.map((x) => x.peerGapHrs)), cost: U.sum(gap.map((x) => x.peerGapCost)), label: 'Benchmark gap (not additive)', basis: 'hours − sales / peer median SPLH' },
            recurrence: 'Recurring',
            drill: { type: 'stores', key: 'peerGapHrs', rows: gap.sort((a, b) => b.peerGapHrs - a.peerGapHrs).slice(0, 30).map((x) => x.s) },
          });
        }
      }

      // 15 ── Edit-volume spike ──────────────────────────────────────────────────────────
      if (INT.spikes.length) {
        const sp = INT.spikes;
        add({
          id: 'edit-spike', category: 'Data integrity', kind: 'validate', confidence: 'Medium',
          title: `Punch edits spiked to ${N(sp[0].n)} on ${U.isoDay(sp[0].day)} (typical day: ${N(INT.editMedianPerDay)})`,
          severity: 'Medium',
          what: `${sp.length} day(s) had abnormal punch-change volume: ${list(sp.slice(0, 5).map((x) => `${U.isoDay(x.day)} (${N(x.n)})`), 5)}.`,
          where: 'Company-wide — affects many stores on the same days, which points to a system or clock event rather than store behaviour.',
          why: 'A burst of edits across stores usually follows a clock outage or sync failure. The time recorded on those days was reconstructed manually and is less reliable.',
          evidence: TR.series.filter((x) => x.manualPct > 0).length ? [`Monthly manual-entry share peaks in ${TR.series.slice().sort((a, b) => b.manualPct - a.manualPct)[0].label}.`] : [],
          action: 'Confirm the cause with the timekeeping provider and, for those days, compare the reconstructed hours with the schedule before treating them as normal.',
          impact: { hours: null, cost: null, label: 'Data reliability', basis: 'Edits per day' },
          recurrence: 'Isolated',
          drill: { type: 'records', key: 'spikes' },
        });
      }

      // 16 ── Concentration: few employees drive most avoidable cost ─────────────────────
      if (employees.length > 20 && F.avoidCost > 0) {
        const sorted = employees.slice().sort((a, b) => b.avoid - a.avoid);
        const k = Math.max(1, Math.round(employees.length * 0.1));
        const share = U.sum(sorted.slice(0, k).map((e) => e.avoid)) / Math.max(1, U.sum(sorted.map((e) => e.avoid)));
        add({
          id: 'concentration', category: 'Employee behaviour', kind: 'estimate', confidence: 'Medium',
          title: `${N(k)} employees (10%) account for ${P(share, 0)} of estimated avoidable cost`,
          severity: share > 0.4 ? 'High' : 'Medium',
          what: `Avoidable cost is not spread evenly: the top ${N(k)} GEIDs carry ${P(share, 0)} of it. Most of them repeat the same pattern (early clock-in, late clock-out, skipped meal) week after week.`,
          where: `Top: ${list(sorted.slice(0, 3).map((e) => `${e.name} · ${e.g} · ${e.storeName} (${$(e.avoid)})`))}.`,
          why: 'Concentrated behaviour is the cheapest leakage to fix: a short list of coaching conversations and clock settings addresses a large share of the cost.',
          evidence: [`Recurring early clock-in employees: ${N(employees.filter((e) => e.recurringEarly).length)}; recurring late clock-out: ${N(employees.filter((e) => e.recurringLate).length)}; recurring OT: ${N(employees.filter((e) => e.recurringOt).length)}.`],
          action: 'Give each store manager their top-10 list monthly (by GEID) with the specific pattern, and track it the following month.',
          impact: { hours: null, cost: U.sum(sorted.slice(0, k).map((e) => e.avoid)), label: `${$(U.sum(sorted.slice(0, k).map((e) => e.avoid)))} concentrated in ${N(k)} employees`, basis: 'Subset of total avoidable estimate' },
          recurrence: 'Recurring',
          drill: { type: 'employees', key: 'avoid', rows: sorted.slice(0, 40).map((e) => e.g) },
        });
      }

      // 17 ── Persistent stores ──────────────────────────────────────────────────────────
      if (TR.persistent.length) {
        const ps = TR.persistent.map((p) => byStore[p.s]).filter(Boolean);
        add({
          id: 'persistent', category: 'Store performance', kind: 'confirmed', confidence: 'High',
          title: `${N(ps.length)} stores were in the top quartile for over-plan cost in at least ${R.persistentMonths.value} of ${monthsN} months`,
          severity: ps.length >= 5 ? 'High' : 'Medium',
          what: `These stores are not having a bad month — their labor above plan plus OT premium per paid hour ranked in the worst quarter month after month.`,
          where: list(TR.persistent.slice(0, 6).map((p) => `${sname(p.s)} (${p.months} months)`), 6),
          why: 'Persistent problems are process problems (how the schedule is written, how clock-outs are handled) and need a store-level intervention rather than one-off coaching.',
          evidence: ps.slice(0, 5).map((s) => `${s.name}: ${P(s.overPlanPct)} over plan, ${$(s.overPlanCost)} above plan, OT premium ${$(s.otPrem)}.`),
          action: 'Run a store visit / labor review at each persistent store, starting with the schedule build and the closing process.',
          impact: { hours: U.sum(ps.map((s) => s.overPlanHrs)), cost: U.sum(ps.map((s) => s.overPlanCost)), label: `${$(U.sum(ps.map((s) => s.overPlanCost)))} above plan at these stores`, basis: 'Subset of labor above plan' },
          recurrence: 'Persistent',
          drill: { type: 'stores', key: 'overPlanCost', rows: TR.persistent.map((p) => p.s) },
        });
      }

      // 18 ── Labor % ranking (highest → lowest) ─────────────────────────────────────────
      const LR = SAL.available ? SAL.laborRank : null;
      if (LR && LR.rows.length >= 3) {
        const hi = LR.rows.filter((r) => r.status === 'Unusually high');
        const above = LR.rows.filter((r) => r.laborPct > LR.orgPct);
        const excess = U.sum(above.map((r) => (r.laborPct - LR.orgPct) * r.sales));
        const salesAll = U.sum(LR.rows.map((r) => r.sales));
        const inc = LR.biggestIncrease.filter((r) => r.change > 0);
        const monthName = (k) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5) - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
        add({
          id: 'labor-rank', category: 'Sales & labor', kind: 'confirmed', confidence: 'High',
          title: `Labor % ranges from ${P(LR.lowest.laborPct)} to ${P(LR.highest.laborPct)} across ${N(LR.rows.length)} stores — ${N(LR.aboveAvg)} are above the ${P(LR.orgPct)} average`,
          severity: hi.length ? 'High' : 'Medium',
          what: `Stores ranked on actual Labor % (punch pay ÷ actual sales) for ${LR.months.length === 1 ? monthName(LR.months[0]) : monthName(LR.months[0]) + ' – ' + monthName(LR.months[LR.months.length - 1])}. Highest is ${sname(LR.highest.s)} at ${P(LR.highest.laborPct)} (${(LR.highest.diff * 100).toFixed(1)} points above average); lowest is ${sname(LR.lowest.s)} at ${P(LR.lowest.laborPct)}.`,
          where: `Top of the ranking: ${list(LR.rows.slice(0, 3).map((r) => `${sname(r.s)} ${P(r.laborPct)}`))}.${hi.length ? ` ${N(hi.length)} store${hi.length > 1 ? 's are' : ' is'} unusually high (5+ points above average or 1.5 standard deviations).` : ''}`,
          why: `Each Labor % point across these stores is worth ${$(salesAll * 0.01)} of labor over the period. High Labor % combines staffing above demand with the punch leakage shown in the other findings.`,
          evidence: [
            inc.length ? `Largest increase vs the previous ${LR.prevMonths.length} month${LR.prevMonths.length > 1 ? 's' : ''}: ${list(inc.slice(0, 3).map((r) => `${sname(r.s)} +${(r.change * 100).toFixed(1)} pts`))}.` : LR.prevMonths.length ? 'No store increased vs the previous comparable period.' : 'No previous comparable period in the data, so change is not shown.',
            LR.notRanked.length ? `${N(LR.notRanked.length)} store(s) not ranked because their sales data is incomplete for the selected months.` : '',
            LR.partialMonths.length ? `${LR.partialMonths.map(monthName).join(', ')} excluded from Labor %: only part of the month is selected and monthly sales are not prorated.` : '',
          ].filter(Boolean),
          action: 'Start labor reviews at the top of the ranking: compare their scheduled hours with the forecast, then work through their over-plan, overtime and manual-punch findings.',
          impact: { hours: null, cost: excess, label: `≈${$(excess)} above the average Labor % at the ${N(above.length)} stores above it (benchmark, not additive)`, basis: 'Σ (store Labor % − org average) × store sales, stores above average' },
          recurrence: 'Recurring',
          drill: { type: 'laborRank' },
        });
      }

      // 19 ── Stores with the highest leakage ────────────────────────────────────────────
      if (stores.length >= 5 && F.avoidCost > 0) {
        const s2 = stores.slice().sort((a, b) => b.avoid - a.avoid);
        const k = Math.max(1, Math.round(stores.length * 0.1));
        const top = U.sum(s2.slice(0, k).map((s) => s.avoid));
        const share = top / Math.max(1, U.sum(s2.map((s) => s.avoid)));
        add({
          id: 'leak-stores', category: 'Store performance', kind: 'estimate', confidence: 'Medium',
          title: `${N(k)} store${k > 1 ? 's' : ''} (10%) account for ${P(share, 0)} of estimated avoidable labor cost`,
          severity: share > 0.3 ? 'High' : 'Medium',
          what: 'Stores ranked by estimated avoidable cost: beyond-tolerance early/late time and skipped meals (capped at labor above plan) plus overtime premium from working past the schedule.',
          where: `Highest: ${list(s2.slice(0, 3).map((s) => `${s.name} (${$(s.avoid)}, $${s.avoidPerHr.toFixed(2)} per paid hour)`))}.`,
          why: 'Concentrated leakage means a few store-level interventions recover most of the money.',
          evidence: s2.slice(0, 5).map((s) => `${s.name}: ${$(s.avoid)} avoidable · ${P(s.overPlanPct)} above plan · OT premium ${$(s.otPrem)} · manual punches ${P(s.manShare)} of paid hours.`),
          action: 'Open each listed store, work through its findings in order, and agree a monthly target for its avoidable $ per paid hour.',
          impact: { hours: null, cost: top, label: `${$(top)} in the top ${N(k)} store${k > 1 ? 's' : ''}`, basis: 'Subset of total avoidable estimate' },
          recurrence: 'Recurring',
          drill: { type: 'stores', key: 'avoid', rows: s2.slice(0, 30).map((s) => s.s) },
        });
      }

      // 20 ── Stores improving vs deteriorating ──────────────────────────────────────────
      if (stores.length >= 4 && M.months.length >= 4) {
        const ms = M.months.map((m) => m.key);
        const half = Math.floor(ms.length / 2), A1 = ms.slice(0, half), A2 = ms.slice(ms.length - half);
        const rate = (s, keys) => {
          let act = 0, c = 0;
          for (const mk of keys) { const a = ADH.byStoreMonth[s + '|' + mk], o = OT.byStoreMonth[s + '|' + mk]; if (a) { act += a.act; c += a.cOverPlan + (o ? o.prem : 0); } }
          return act >= 100 * 60 ? c / (act / 60) : NaN;
        };
        const ch = stores.map((s) => ({ s: s.s, name: s.name, a: rate(s.s, A1), b: rate(s.s, A2) })).filter((x) => isFinite(x.a) && isFinite(x.b)).map((x) => Object.assign(x, { d: x.b - x.a }));
        const worse = ch.filter((x) => x.d > 0.25 && x.b > x.a * 1.2).sort((a, b) => b.d - a.d);
        const better = ch.filter((x) => x.d < -0.25 && x.b < x.a * 0.8).sort((a, b) => a.d - b.d);
        if (worse.length || better.length) {
          add({
            id: 'store-trend', category: 'Store performance', kind: 'confirmed', confidence: 'High',
            title: `${N(worse.length)} store${worse.length === 1 ? ' is' : 's are'} deteriorating and ${N(better.length)} improving on labor above plan`,
            severity: worse.length >= 5 ? 'High' : 'Medium',
            what: `Compares labor above plan plus OT premium per paid hour in the first ${half} vs the last ${half} months of the selection (a change of more than $0.25 per paid hour and 20%).`,
            where: `${worse.length ? `Getting worse: ${list(worse.slice(0, 3).map((x) => `${x.name} ($${x.a.toFixed(2)} → $${x.b.toFixed(2)}/h)`))}. ` : ''}${better.length ? `Improving: ${list(better.slice(0, 3).map((x) => `${x.name} ($${x.a.toFixed(2)} → $${x.b.toFixed(2)}/h)`))}.` : ''}`,
            why: 'Deteriorating stores need attention before the pattern becomes persistent; improving stores show which practices work and can be copied.',
            evidence: [`Months compared: ${A1.join(', ')} vs ${A2.join(', ')}. Store-halves with fewer than 100 paid hours are not compared.`],
            action: 'Review deteriorating stores for recent changes (new manager, schedule changes); ask improving stores what changed and share it.',
            impact: { hours: null, cost: null, label: `${N(worse.length)} worsening · ${N(better.length)} improving`, basis: '(labor above plan + OT premium) per paid hour' },
            recurrence: 'Mixed',
            drill: { type: 'stores', key: 'trend', rows: worse.concat(better).map((x) => x.s), extra: Object.fromEntries(ch.map((x) => [x.s, { a: x.a, b: x.b, d: x.d }])) },
          });
        }
      }

      // 21 ── Employees repeating several kinds of deviation ─────────────────────────────
      const multi = employees.filter((e) => e.devTypes >= 3).sort((a, b) => b.devTypes - a.devTypes || b.avoid - a.avoid);
      if (multi.length && !(ctx.BEH && ctx.BEH.patterns.some((p) => p.cat === 'combined'))) {
        const mc = U.sum(multi.map((e) => e.avoid));
        add({
          id: 'repeat-devs', category: 'Employee behaviour', kind: 'confirmed', confidence: 'High',
          title: `${N(multi.length)} employees repeat three or more kinds of deviation week after week`,
          severity: multi.length >= 50 ? 'High' : 'Medium',
          what: `Each of these GEIDs shows at least three of these patterns in ${R.recurringWeeks.value}+ different weeks: early clock-in, late clock-out, overtime, manual punches, punch edits, unscheduled shifts.`,
          where: `Most patterns: ${list(multi.slice(0, 3).map((e) => `${e.name} · GEID ${e.g} · ${e.storeName} (${e.devTypes} patterns)`))}.`,
          why: 'An employee with several recurring deviations usually points to a working arrangement (an unofficial opening or closing routine, for example) that one coaching conversation or a schedule fix resolves at once.',
          evidence: [`Their estimated avoidable cost: ${$(mc)}.`],
          action: 'Discuss each listed employee with their store manager, starting with the highest avoidable cost, and confirm whether the pattern reflects real work that belongs on the schedule.',
          impact: { hours: null, cost: mc, label: `${$(mc)} avoidable across these employees`, basis: 'Subset of total avoidable estimate' },
          recurrence: 'Recurring',
          drill: { type: 'employees', key: 'devTypes', rows: multi.slice(0, 60).map((e) => e.g) },
        });
      }

      // 22 ── Employee behaviour patterns (behavior.js) ─────────────────────────────────
      const B = ctx.BEH;
      if (B) {
        const card = (cat, opts) => {
          const list = B.patterns.filter((p) => p.cat === cat);
          if (!list.length) return;
          const cost = U.sum(list.map((p) => p.cost || 0)), avoid = U.sum(list.map((p) => p.avoid || 0));
          const top = list.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 3);
          const longest = list.slice().sort((a, b) => (b.streak || 0) - (a.streak || 0))[0];
          const storesN = new Set(list.map((p) => p.store)).size;
          add({
            id: 'beh-' + cat, category: 'Employee behaviour', kind: opts.kind || 'estimate', confidence: 'High',
            title: opts.title(list, cost, avoid),
            severity: list.some((p) => p.severity === 'Critical') || list.length >= 50 ? 'High' : 'Medium',
            what: `${N(list.length)} employee${list.length === 1 ? '' : 's'} at ${N(storesN)} store${storesN === 1 ? '' : 's'} show this as a recurring pattern in the selected period (at least ${B.rules.minOcc} occurrences and a ${B.rules.minStreak}+ working-day streak, ${P(B.rules.minShare, 0)}+ of working days, or ${B.rules.minBest10}+ of any 10 working days). Longest run: ${longest.name} (GEID ${longest.g}), ${N(longest.streak)} consecutive ${longest.unit || 'working days'}.`,
            where: `Highest cost: ${list.length ? top.map((p) => `${p.name} · GEID ${p.g} · ${p.storeName} — ${$(p.cost)}: ${p.description}`).join(' | ') : '—'}`,
            why: opts.why,
            evidence: [
              `Dollar impact: ${$(cost)}${opts.avoidable && avoid ? `, of which ${$(avoid)} estimated avoidable` : ''}. ${opts.costNote}`,
              `Occurrences: ${N(U.sum(list.map((p) => p.occ)))} ${cat === 'overtime' ? 'weeks' : 'working days'} across these employees; ${N(list.filter((p) => p.severity !== 'Medium').length)} rated High or Critical.`,
              opts.extra ? opts.extra(list) : '',
            ].filter(Boolean),
            action: B.cats[cat].action,
            impact: { hours: U.sum(list.map((p) => p.hrs || 0)), cost, label: `${$(cost)} ${opts.impactLabel}`, basis: opts.costNote },
            recurrence: 'Recurring',
            drill: { type: 'patterns', cat },
          });
        };
        card('manual', {
          title: (l, c) => `${N(l.length)} employees keep recording manual punches — ${$(c)} of additional pay recorded that way`,
          why: 'Repeated manual entry by the same people usually has a fixable cause (no badge, PIN not working, clock in the wrong place, a habit of not clocking). It is not proof of misconduct, but time entered by hand cannot be verified against the clock.',
          costNote: 'Cost of the early-start, late-finish and unscheduled time on those manual punches, at each employee\'s rate — overlaps the early/late/unscheduled costs.',
          impactLabel: 'via manual punches (overlapping)', avoidable: true,
          extra: (l) => { const io = l.reduce((o, p) => { o.i += p.extra.inOnly || 0; o.o += p.extra.outOnly || 0; o.b += p.extra.both || 0; return o; }, { i: 0, o: 0, b: 0 }); return `Keyed-in days split: clock-in only ${N(io.i)}, clock-out only ${N(io.o)}, both ${N(io.b)} (from the punch audit log).`; },
        });
        card('late', {
          title: (l, c, a) => `${N(l.length)} employees repeatedly clock out late — ${$(c)} of additional pay, ${$(a)} avoidable`,
          why: 'The same people staying past the end of their shift week after week points to unscheduled work or no one checking clock-outs.',
          costNote: 'Late-out minutes on those days at each employee\'s rate; avoidable = beyond the tolerance and capped at store-day labor above plan.', impactLabel: 'additional pay', avoidable: true,
        });
        card('early', {
          title: (l, c, a) => `${N(l.length)} employees repeatedly clock in early — ${$(c)} of additional pay, ${$(a)} avoidable`,
          why: 'Habitual early clock-ins are paid time the schedule did not plan; they are usually fixed by a clock rule and a conversation.',
          costNote: 'Early-in minutes on those days at each employee\'s rate; avoidable = beyond the tolerance and capped at store-day labor above plan.', impactLabel: 'additional pay', avoidable: true,
        });
        card('overtime', {
          title: (l, c, a) => `${N(l.length)} employees are in overtime week after week — ${$(c)} of OT premium, ${$(a)} from working past the schedule`,
          why: 'Recurring overtime for the same people is usually a scheduling choice; moving hours to colleagues under the threshold removes the premium.',
          costNote: 'Actual OT premium (OT pay − OT hours × base rate) in those weeks.', impactLabel: 'OT premium', avoidable: true,
        });
        card('edits', {
          title: (l, c) => `${N(l.length)} employees have their punches edited again and again — net ${$(c)} of paid time added`,
          why: 'Frequent edits for the same employee mean their clocking is not working; when one manager makes most of them, the review should start with that manager.',
          costNote: 'Net paid time added by edits on those punches (forgotten clock-out corrections excluded), at the punch rate.', impactLabel: 'net added by edits', avoidable: false,
          extra: (l) => { const one = l.filter((p) => p.extra.topEditorShare >= 0.5); return one.length ? `${N(one.length)} of them have most of their edits made by a single editor.` : ''; },
        });
        card('combined', {
          title: (l, c, a) => `${N(l.length)} employees show two or more recurring patterns at once — ${$(c)} of additional pay, ${$(a)} avoidable`,
          why: 'When several patterns recur together (for example manual punches plus edits, or early starts plus late finishes) the cause is usually one working arrangement that can be fixed in one go.',
          costNote: 'Each employee\'s total additional pay from the non-overlapping parts (early, late, unscheduled, skipped meals, OT premium).', impactLabel: 'additional pay (non-overlapping)', avoidable: true,
        });
        if (B.storeConc.length && stores.length > 1) {
          const sc = B.storeConc;
          add({
            id: 'beh-store', category: 'Store performance', kind: 'confirmed', confidence: 'High',
            title: `${N(new Set(sc.map((x) => x.store)).size)} stores have 40%+ of their staff repeating the same punch behaviour`,
            severity: sc.length >= 10 ? 'High' : 'Medium',
            what: 'When many employees at one store show the same recurring pattern, the cause is the store\'s process (clock placement, manager practice, closing routine), not individual behaviour.',
            where: list(sc.slice(0, 4).map((x) => `${x.storeName}: ${x.label.toLowerCase()} for ${x.emps} of ${x.active} employees (${$(x.cost)})`), 4),
            why: 'A store-level fix (clock settings, manager process) addresses all of those employees at once.',
            evidence: sc.slice(0, 6).map((x) => `${x.storeName} — ${x.label}: ${x.emps} employees (${P(x.share, 0)} of active staff), ${$(x.cost)}.`),
            action: 'Treat these as store process issues: visit the store, check the clock set-up and how the manager handles punches, then re-check the pattern next month.',
            impact: { hours: null, cost: U.sum(sc.map((x) => x.cost)), label: `${$(U.sum(sc.map((x) => x.cost)))} across these store patterns (overlapping categories)`, basis: 'Sum of the employees\' pattern costs' },
            recurrence: 'Persistent',
            drill: { type: 'storeConc' },
          });
        }
      }

      // order: severity, then $ impact
      const sevOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
      out.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || ((b.impact && b.impact.cost) || 0) - ((a.impact && a.impact.cost) || 0));
      return out;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
