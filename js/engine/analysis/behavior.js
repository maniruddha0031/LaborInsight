/*
 * behavior.js — recurring employee behaviour patterns, each tied to its dollar impact.
 *
 * Works on the employee-days already built by adherence.js (one record per GEID × business day), the
 * paid-punch edits from integrity.js, the overtime weeks from overtime.js and the manual-entry audit.
 *
 * Working day  = a business day on which the GEID has paid punches in scope.
 * Working-day streak = consecutive working days that all show the pattern. Days not worked are skipped
 *   (they neither break nor extend a streak), but a day with NO data at all in scope between two working
 *   days breaks the streak — missing data is never treated as a continuation.
 * Calendar streak = consecutive calendar days that all show the pattern.
 *
 * Dollars per category (each costed at the employee's own rate on that day):
 *   early / late           cost of early-in / late-out minutes; avoidable = the store-day-netted part
 *   manual punches         cost of early/late/unscheduled time recorded through manual punches; avoidable part
 *   overtime               actual OT premium; avoidable = premium from working past the schedule
 *   punch edits            net paid time added by edits (excluding forgotten clock-out corrections)
 * Category dollars overlap (an early start keyed in manually is both "early" and "manual"); the employee
 * total uses the non-overlapping parts only (early + late + unscheduled + skipped meal + OT premium).
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;
  const A = (LCI.analysis = LCI.analysis || {});

  const CATS = {
    manual: { label: 'Recurring manual punches', noun: 'manual punches', action: 'Review why this employee\'s punches keep being keyed in by a manager: clock or badge access, PIN problems, or a habit of not clocking. Fix the cause, and require a reason code and same-shift entry for each manual punch.' },
    early: { label: 'Repeated early clock-ins', noun: 'early clock-ins (> tolerance)', action: 'Ask the employee to clock in no earlier than the scheduled start, and turn on manager authorization for early clock-ins at this store.' },
    late: { label: 'Repeated late clock-outs', noun: 'late clock-outs (> tolerance)', action: 'Check whether the shift end is realistic for the tasks assigned; if it is, require a manager sign-off for staying past the scheduled end.' },
    earlyLate: { label: 'Early in and late out on the same days', noun: 'days starting early and finishing late', action: 'The working day is consistently longer than scheduled at both ends — either the schedule is too short for the role or the employee is not following it. Agree the real shift length with the store manager.' },
    overtime: { label: 'Recurring overtime', noun: 'overtime weeks', action: 'Plan this employee\'s week below the overtime threshold and move hours to colleagues with capacity; alert the manager mid-week when they approach the limit.' },
    edits: { label: 'Frequent punch edits', noun: 'days with edited punches', action: 'Find out why this employee\'s punches need correcting so often; edits that add time should need a reason and a second approver.' },
    combined: { label: 'Multiple recurring deviations', noun: 'recurring patterns', action: 'Several patterns recur together for this employee — review them in one conversation with the store manager and fix the underlying working arrangement.' },
  };

  const isEditRow = (a) => /modif|delet|restor|accepted|rejected/i.test(a.desc) || (/added/i.test(a.desc) && a.method === 'MANUAL');

  A.behavior = function (M, R, ADH, OT, INT, employees) {
    const end = M.period.end;
    const dataDays = new Set(M.punches.map((p) => p.day));   // days with any data in scope
    const empInfo = new Map(employees.map((e) => [e.g, e]));
    const daysBy = new Map();
    for (const d of ADH.days) { let a = daysBy.get(d.g); if (!a) daysBy.set(d.g, (a = [])); a.push(d); }
    const editDays = new Map();
    for (const e of INT.editedList) { const k = e.g + '|' + e.day; const x = editDays.get(k) || { n: 0, net: 0, cost: 0, add: 0 }; x.n++; x.net += e.net; if (!e.forgot) x.cost += (e.net / 60) * (e.rate || 0); if (e.net > 0) x.add++; editDays.set(k, x); }
    const manIO = new Map(); // g|day -> {in, out}
    for (const a of M.auditManual) { const k = a.g + '|' + a.day; const x = manIO.get(k) || { in: 0, out: 0 }; if (a.isIn) x.in++; else x.out++; manIO.set(k, x); }
    const editorBy = new Map(); // g -> {editor: n}
    for (const a of M.approvals) {
      if (!isEditRow(a) || !a.editor || a.editor === '-' || /^system$/i.test(a.editor)) continue;
      const ed = LCI.analysis.parseEditor(a.editor);
      if (!ed) continue;
      let o = editorBy.get(a.g); if (!o) editorBy.set(a.g, (o = {}));
      o[ed.display] = (o[ed.display] || 0) + 1;
    }

    /** Streaks/windows for one predicate over an employee's working days. */
    function scan(work, pred) {
      let cur = 0, curStart = null, best = 0, bestFrom = null, bestTo = null, prev = null;
      let calCur = 0, calBest = 0, calPrev = null;
      const occ = [];
      for (const d of work) {
        // A day without any data in scope between two working days breaks the streak.
        if (prev != null) { for (let x = prev + 1; x < d.day; x++) if (!dataDays.has(x)) { cur = 0; break; } }
        const hit = pred(d);
        if (hit) {
          occ.push(d);
          if (cur === 0) curStart = d.day;
          cur++;
          if (cur > best) { best = cur; bestFrom = curStart; bestTo = d.day; }
          calCur = calPrev != null && d.day === calPrev + 1 ? calCur + 1 : 1;
          calPrev = d.day;
          if (calCur > calBest) calBest = calCur;
        } else cur = 0;
        prev = d.day;
      }
      // Best density in any window of 10 consecutive working days.
      let best10 = 0;
      for (let i = 0; i < work.length; i++) {
        let n = 0;
        for (let j = i; j < Math.min(work.length, i + 10); j++) if (pred(work[j])) n++;
        if (n > best10) best10 = n;
        if (i + 10 >= work.length) break;
      }
      const recent = (days) => ({ n: occ.filter((d) => d.day > end - days).length, of: work.filter((d) => d.day > end - days).length });
      const byMonth = {};
      for (const d of work) { const m = (byMonth[d.month] = byMonth[d.month] || { work: 0, occ: 0 }); m.work++; if (pred(d)) m.occ++; }
      return { occ, best, bestFrom, bestTo, calBest, best10, win10: Math.min(10, work.length), r7: recent(7), r14: recent(14), r30: recent(30), byMonth };
    }

    /** Month-over-month jump: last month in scope vs the average rate of earlier months. */
    function momJump(byMonth) {
      const keys = Object.keys(byMonth).sort().filter((k) => byMonth[k].work >= 8);
      if (keys.length < 2) return null;
      const last = byMonth[keys[keys.length - 1]];
      const prev = keys.slice(0, -1).map((k) => byMonth[k].occ / byMonth[k].work);
      const prevRate = U.sum(prev) / prev.length, lastRate = last.occ / last.work;
      return last.occ >= 4 && lastRate >= Math.max(0.15, prevRate * 2) ? { month: keys[keys.length - 1], lastRate, prevRate } : null;
    }

    const preds = {
      manual: (d) => d.manN > 0,
      early: (d) => d.nEarlyEv > 0,
      late: (d) => d.nLateEv > 0,
      earlyLate: (d) => d.nEarlyEv > 0 && d.nLateEv > 0,
      edits: (d) => editDays.has(d.g + '|' + d.day),
    };
    const money = {
      manual: (o) => ({ cost: U.sum(o.map((d) => d.cManExtra || 0)), avoid: U.sum(o.map((d) => d.cManAvoid || 0)), hrs: U.sum(o.map((d) => d.manMin || 0)) / 60 }),
      early: (o) => ({ cost: U.sum(o.map((d) => d.cEarly)), avoid: U.sum(o.map((d) => d.cAvoidEarly || 0)), hrs: U.sum(o.map((d) => d.early)) / 60 }),
      late: (o) => ({ cost: U.sum(o.map((d) => d.cLate)), avoid: U.sum(o.map((d) => d.cAvoidLate || 0)), hrs: U.sum(o.map((d) => d.late)) / 60 }),
      earlyLate: (o) => ({ cost: U.sum(o.map((d) => d.cEarly + d.cLate)), avoid: U.sum(o.map((d) => (d.cAvoidEarly || 0) + (d.cAvoidLate || 0))), hrs: U.sum(o.map((d) => d.early + d.late)) / 60 }),
      edits: (o) => { const x = o.map((d) => editDays.get(d.g + '|' + d.day)); return { cost: Math.max(0, U.sum(x.map((e) => e.cost))), avoid: null, hrs: U.sum(x.map((e) => (e.net > 0 ? e.net : 0))) / 60 }; },
    };

    // ---- per employee scan ----
    const scans = new Map();
    for (const [g, list] of daysBy) {
      const work = list.filter((d) => d.nP > 0).sort((a, b) => a.day - b.day);
      if (work.length < 4) continue;
      const s = { g, work: work.length, store: work[0].s, cats: {} };
      for (const k in preds) s.cats[k] = scan(work, preds[k]);
      scans.set(g, s);
    }
    // Store peer rates (employees with ≥ 8 working days at that store as their main store).
    const peer = {};
    for (const s of scans.values()) {
      if (s.work < 8) continue;
      const st = (empInfo.get(s.g) || {}).store || s.store;
      for (const k in s.cats) ((peer[st] = peer[st] || {})[k] = (peer[st] || {})[k] || []).push(s.cats[k].occ.length / s.work);
    }
    const peerMed = {};
    for (const st in peer) { peerMed[st] = {}; for (const k in peer[st]) peerMed[st][k] = U.median(peer[st][k]); }

    // Thresholds: a pattern must recur clearly enough to need a conversation, and (where $ applies) be material.
    const minOcc = 8, minStreak = 5, minShare = 0.5, minBest10 = 8, minCost = 100;
    const patterns = [];
    const fmt = (d) => U.isoDay(d);
    for (const s of scans.values()) {
      const e = empInfo.get(s.g) || {};
      const st = e.store || s.store;
      for (const k in s.cats) {
        const c = s.cats[k];
        const n = c.occ.length;
        if (n < minOcc) continue;
        const share = n / s.work;
        const peerRatio = peerMed[st] && peerMed[st][k] > 0 ? share / peerMed[st][k] : (share > 0 && peerMed[st] && peerMed[st][k] === 0 ? Infinity : null);
        const mom = momJump(c.byMonth);
        const recurring = c.best >= minStreak || share >= minShare || c.best10 >= minBest10;
        const outlier = peerRatio != null && peerRatio >= 3 && n >= 8;
        if (!recurring && !mom && !outlier) continue;
        const $ = money[k](c.occ);
        if (k !== 'manual' && k !== 'edits' && $.cost < minCost) continue; // immaterial early/late patterns
        const sev = c.best >= 5 || c.best10 >= 8 || share >= 0.6 ? 'High' : 'Medium';
        const extra = {};
        if (k === 'manual') {
          let inOnly = 0, outOnly = 0, both = 0;
          for (const d of c.occ) { const io = manIO.get(d.g + '|' + d.day); if (!io) continue; if (io.in && io.out) both++; else if (io.in) inOnly++; else if (io.out) outOnly++; }
          extra.inOnly = inOnly; extra.outOnly = outOnly; extra.both = both;
          extra.punches = U.sum(c.occ.map((d) => d.manN));
          extra.manPay = U.sum(c.occ.map((d) => d.cMan || 0));
        }
        if (k === 'edits') {
          const eds = editorBy.get(s.g) || {};
          const top = Object.entries(eds).sort((a, b) => b[1] - a[1])[0];
          const tot = U.sum(Object.values(eds));
          if (top && tot >= 4) { extra.topEditor = top[0]; extra.topEditorShare = top[1] / tot; }
          extra.addedDays = c.occ.filter((d) => (editDays.get(d.g + '|' + d.day) || {}).add > 0).length;
        }
        patterns.push({
          g: s.g, name: e.name || s.g, store: st, storeName: M.storeName[st] || st, cat: k, label: CATS[k].label,
          occ: n, workDays: s.work, share, streak: c.best, streakFrom: c.bestFrom != null ? fmt(c.bestFrom) : '', streakTo: c.bestTo != null ? fmt(c.bestTo) : '',
          calStreak: c.calBest, best10: c.best10, win10: c.win10, r7: c.r7, r14: c.r14, r30: c.r30,
          first: fmt(c.occ[0].day), last: fmt(c.occ[c.occ.length - 1].day), lastDay: c.occ[c.occ.length - 1].day,
          hrs: $.hrs, cost: $.cost, avoid: $.avoid, severity: sev, peerRatio: isFinite(peerRatio) ? peerRatio : null, peerNone: peerRatio === Infinity, mom, extra,
          flags: [recurring && 'recurring', outlier && 'above store peers', mom && 'rising'].filter(Boolean),
        });
      }
    }

    // ---- overtime: consecutive OT weeks ----
    const wkBy = new Map();
    for (const w of OT.weeks) { let a = wkBy.get(w.g); if (!a) wkBy.set(w.g, (a = [])); a.push(w); }
    const allWeeks = [...new Set(M.punches.map((p) => U.weekStart(p.day)))].sort((a, b) => a - b);
    for (const [g, list] of wkBy) {
      list.sort((a, b) => a.week - b.week);
      if (list.length < 3) continue;
      let cur = 0, best = 0, from = null, bestFrom = null, bestTo = null, prev = null;
      for (const w of list) {
        cur = prev != null && w.week === prev + 7 ? cur + 1 : 1;
        if (cur === 1) from = w.week;
        if (cur > best) { best = cur; bestFrom = from; bestTo = w.week; }
        prev = w.week;
      }
      const e = empInfo.get(g) || {};
      const workedWeeks = new Set((daysBy.get(g) || []).filter((d) => d.nP > 0).map((d) => d.week)).size || allWeeks.length;
      const share = list.length / workedWeeks;
      if (!(best >= 4 || (list.length >= 6 && share >= 0.4))) continue;
      const prem = U.sum(list.map((w) => w.prem)), drift = U.sum(list.map((w) => w.premDrift || 0)), hrs = U.sum(list.map((w) => w.ot + w.dt)) / 60;
      patterns.push({
        g, name: e.name || g, store: e.store || list[0].store, storeName: M.storeName[e.store || list[0].store] || e.store, cat: 'overtime', label: CATS.overtime.label,
        // Weeks are Mon–Sun; dates are clipped to the selected period so a range starting mid-week is shown honestly.
        occ: list.length, workDays: workedWeeks, share, streak: best, streakFrom: U.isoDay(Math.max(bestFrom, M.period.start)), streakTo: U.isoDay(Math.min(bestTo + 6, end)), calStreak: null, best10: null, unit: 'weeks',
        first: U.isoDay(Math.max(list[0].week, M.period.start)), last: U.isoDay(Math.min(list[list.length - 1].week + 6, end)), lastDay: Math.min(list[list.length - 1].week + 6, end),
        hrs, cost: prem, avoid: drift, severity: best >= 4 || share >= 0.6 ? 'High' : 'Medium', flags: ['recurring'], extra: { schedShare: U.sum(list.map((w) => w.schedOt || 0)) / Math.max(1, U.sum(list.map((w) => w.ot + w.dt))) },
      });
    }

    // ---- combined: employees with ≥ 2 different recurring categories ----
    const byEmp = {};
    for (const p of patterns) (byEmp[p.g] = byEmp[p.g] || []).push(p);
    for (const g in byEmp) {
      const cats = [...new Set(byEmp[g].filter((p) => p.cat !== 'earlyLate').map((p) => p.cat))];
      if (cats.length < 2) continue;
      const e = empInfo.get(g) || {};
      const last = Math.max(...byEmp[g].map((p) => p.lastDay));
      patterns.push({
        g, name: e.name || g, store: e.store, storeName: e.storeName || e.store, cat: 'combined', label: CATS.combined.label,
        occ: cats.length, workDays: null, share: null, streak: Math.max(...byEmp[g].map((p) => p.streak || 0)), cats,
        first: byEmp[g].map((p) => p.first).sort()[0], last: U.isoDay(last), lastDay: last,
        hrs: e.paidHrs, cost: e.grossAdd || 0, avoid: e.avoid || 0, severity: cats.length >= 3 ? 'High' : 'Medium', flags: ['combined'], extra: {},
      });
    }

    // Severity: lift to Critical the patterns whose $ is in the top 5% of their category.
    for (const k of Object.keys(CATS)) {
      const list = patterns.filter((p) => p.cat === k);
      const cut = U.quantile(list.map((p) => p.cost || 0), 0.95);
      for (const p of list) if (p.severity === 'High' && p.cost > 0 && p.cost >= cut && list.length >= 20) p.severity = 'Critical';
    }
    for (const p of patterns) { p.description = describe(p); p.action = CATS[p.cat].action; }

    // ---- store concentration: many employees at one store with the same recurring pattern ----
    const storeConc = [];
    const active = {};
    for (const s of scans.values()) if (s.work >= 8) { const st = (empInfo.get(s.g) || {}).store || s.store; active[st] = (active[st] || 0) + 1; }
    const byStoreCat = {};
    for (const p of patterns) if (p.cat !== 'combined') { const k = p.store + '|' + p.cat; (byStoreCat[k] = byStoreCat[k] || []).push(p); }
    for (const k in byStoreCat) {
      const [st, cat] = k.split('|');
      const list = byStoreCat[k];
      const share = list.length / Math.max(1, active[st] || 0);
      if (list.length >= 4 && share >= 0.4) storeConc.push({ store: st, storeName: M.storeName[st] || st, cat, label: CATS[cat].label, emps: list.length, active: active[st] || 0, share, cost: U.sum(list.map((p) => p.cost || 0)) });
    }
    storeConc.sort((a, b) => b.cost - a.cost);

    // ---- per employee summary + category summary ----
    const empSummary = {};
    for (const g in byEmp) {
      const ps = patterns.filter((p) => p.g === g && p.cat !== 'combined');
      empSummary[g] = { count: ps.length, cats: ps.map((p) => p.cat), maxStreak: Math.max(0, ...ps.map((p) => p.streak || 0)), last: Math.max(...ps.map((p) => p.lastDay)) };
    }
    const summary = {};
    for (const k of Object.keys(CATS)) {
      const list = patterns.filter((p) => p.cat === k);
      summary[k] = { label: CATS[k].label, emps: list.length, cost: U.sum(list.map((p) => p.cost || 0)), avoid: U.sum(list.map((p) => p.avoid || 0)), occ: U.sum(list.map((p) => p.occ || 0)), high: list.filter((p) => p.severity !== 'Medium').length };
    }
    patterns.sort((a, b) => (b.cost || 0) - (a.cost || 0));
    return { patterns, storeConc, empSummary, summary, cats: CATS, minOcc, rules: { minOcc, minStreak, minShare, minBest10, minCost } };
  };

  const $f = (v) => '$' + Math.round(v || 0).toLocaleString('en-US');
  const pc = (v) => Math.round(v * 100) + '%';
  function describe(p) {
    const d = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    if (p.cat === 'combined') return `${p.cats.length} different recurring patterns: ${p.cats.map((c) => CATS[c].noun).join(', ')}.`;
    if (p.cat === 'overtime') return `Overtime in ${p.occ} of ${p.workDays} worked weeks${p.streak >= 2 ? `, including ${p.streak} consecutive weeks (${d(p.streakFrom)} – ${d(p.streakTo)})` : ''}. ${pc(p.extra.schedShare || 0)} of these OT hours were already in the schedule.`;
    let s = `${cap(CATS[p.cat].noun)} on ${p.occ} of ${p.workDays} working days (${pc(p.share)})`;
    if (p.streak >= 2) s += `, including ${p.streak} consecutive working days (${d(p.streakFrom)} – ${d(p.streakTo)})`;
    s += '.';
    if (p.best10 >= 5 && p.win10 === 10) s += ` At its peak ${p.best10} of 10 working days.`;
    if (p.r30 && p.r30.of >= 5 && p.r30.n) s += ` Last 30 days: ${p.r30.n} of ${p.r30.of} working days.`;
    if (p.cat === 'manual' && p.extra && (p.extra.inOnly + p.extra.outOnly + p.extra.both)) s += ` Keyed in: clock-in only ${p.extra.inOnly} day(s), clock-out only ${p.extra.outOnly}, both ${p.extra.both}.`;
    if (p.cat === 'edits' && p.extra.topEditor) s += ` ${pc(p.extra.topEditorShare)} of the edits were made by ${p.extra.topEditor}.`;
    if (p.peerRatio != null && p.peerRatio >= 3) s += ` ${p.peerRatio.toFixed(1)}× the typical rate at the same store.`;
    else if (p.peerNone) s += ' Most colleagues at the same store show none.';
    if (p.mom) s += ` Rising: ${pc(p.mom.lastRate)} of working days in ${p.mom.month} vs ${pc(p.mom.prevRate)} before.`;
    return s;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  A.behavior.CATS = CATS;
})(typeof globalThis !== 'undefined' ? globalThis : self);
