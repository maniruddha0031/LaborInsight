/*
 * pipeline.js — one entry point for every dataset, whether it came from datasets/manifest.json or an upload.
 *
 *   readZip(chunks)  -> streams entries through fflate, classifies each CSV by header, feeds the Ingestor
 *   analyse(ing,cfg) -> model -> adherence -> overtime -> integrity -> compliance -> sales -> summary -> insights
 *
 * Each run creates a fresh Ingestor and context, so datasets can never mix.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;

  const SKIP = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)|(^|\/)\.[^/]*$/i;

  function decoderFor(first) {
    if (first && first.length >= 2 && first[0] === 0xff && first[1] === 0xfe) return new TextDecoder('utf-16le');
    if (first && first.length >= 2 && first[0] === 0xfe && first[1] === 0xff) return new TextDecoder('utf-16be');
    return new TextDecoder('utf-8');
  }

  /** Start a text-file consumer bound to the ingestor. Returns {push(Uint8Array), end()} */
  function textConsumer(ing, name) {
    let dec = null, rowFn = null, header = null, csv = null, skipped = false;
    csv = new LCI.CsvStream((fields) => {
      if (skipped) return;
      if (!header) { header = fields; rowFn = ing.beginFile(name, header); if (!rowFn) skipped = true; return; }
      rowFn(fields);
    });
    return {
      push(bytes) { if (!dec) dec = decoderFor(bytes); csv.push(dec.decode(bytes, { stream: true })); },
      end() {
        if (dec) csv.push(dec.decode());
        csv.end();
        if (!header) ing.files.push({ name, type: null, label: 'Empty', rows: 0, accepted: 0, notes: ['File is empty.'], stores: [], months: {} });
        else ing.finishFile();
      },
    };
  }

  /**
   * Stream a ZIP. `chunks` is an async iterable of Uint8Array (fetch body, File.stream(), fs stream).
   * onProgress({bytes, file}) is called as compressed bytes are consumed.
   */
  async function readZip(chunks, ing, onProgress) {
    const fflate = G.fflate;
    if (!fflate) throw new Error('ZIP library (fflate) is not loaded.');
    const uz = new fflate.Unzip();
    uz.register(fflate.UnzipInflate);
    let current = '', fileErr = null, entries = 0;
    const others = [];
    uz.onfile = (file) => {
      const name = file.name;
      if (name.endsWith('/') || SKIP.test(name)) { file.ondata = () => {}; try { file.start(); } catch (e) {} return; }
      entries++;
      const lower = name.toLowerCase();
      if (!/\.(csv|txt|tsv)$/.test(lower)) {
        others.push({ name, reason: /\.(xlsx|xls|xlsm)$/.test(lower) ? 'Excel workbook — save each sheet as CSV inside the ZIP.' : /\.zip$/.test(lower) ? 'Nested ZIP — extract it into the outer ZIP.' : 'Not a CSV/TXT data file.' });
        file.ondata = () => {}; try { file.start(); } catch (e) {}
        return;
      }
      current = name;
      const tc = textConsumer(ing, name.split('/').pop() === name ? name : name);
      file.ondata = (err, data, final) => {
        if (err) { fileErr = err; return; }
        try { if (data && data.length) tc.push(data); if (final) tc.end(); } catch (e) { fileErr = e; }
      };
      try { file.start(); } catch (e) { others.push({ name, reason: 'Unsupported compression method: ' + e.message }); }
    };
    let bytes = 0;
    let sawAny = false;
    for await (const chunk of chunks) {
      sawAny = true;
      if (bytes === 0 && !(chunk[0] === 0x50 && chunk[1] === 0x4b)) throw new Error('This file is not a ZIP archive (missing ZIP signature).');
      bytes += chunk.length;
      uz.push(chunk, false);
      if (fileErr) throw fileErr;
      if (onProgress) onProgress({ bytes, file: current });
    }
    if (!sawAny) throw new Error('The ZIP file is empty.');
    uz.push(new Uint8Array(0), true);
    if (fileErr) throw fileErr;
    for (const o of others) ing.files.push({ name: o.name, type: null, label: 'Skipped', rows: 0, accepted: 0, notes: [o.reason], stores: [], months: {} });
    if (!entries) throw new Error('The ZIP contains no files.');
    return { entries };
  }

  // ---------------- summary builders ----------------
  function financials(M, R, ADH, OT, INT, SAL) {
    const t = ADH.tot;
    const labor = U.sum(M.punches.map((p) => (isFinite(p.pay) ? p.pay : 0)));
    const paidMin = t.act;
    const F = {
      laborCost: labor,
      paidHours: paidMin / 60,
      schedHours: t.sch / 60,
      varianceHours: (t.act - t.sch) / 60,
      // 2. gross additional hours (non-overlapping components)
      add: {
        early: { min: t.early, cost: t.cEarly },
        late: { min: t.late, cost: t.cLate },
        unsch: { min: t.unsch, cost: t.cUnsch },
        mealSkip: { min: t.mealSkip, cost: t.cMealSkip },
      },
      offsets: { lateIn: t.lateIn, earlyOut: t.earlyOut, noShow: t.noShow, extraBrk: t.extraBrk },
      otPremium: OT.tot.prem, otPremiumSched: OT.tot.premSched, otPremiumDrift: OT.tot.premDrift,
      editsAddedMin: INT.tot.addMin, editsAddedCost: INT.tot.addCost,
      noRateMin: t.noRateMin,
    };
    F.grossAddMin = t.early + t.late + t.unsch + t.mealSkip;
    F.grossAddCost = t.cEarly + t.cLate + t.cUnsch + t.cMealSkip + OT.tot.prem;
    // 3. net labor above plan: store-day actual paid beyond store-day scheduled paid
    F.overPlan = { min: t.overPlan, cost: t.cOverPlan, days: t.nOverDays, storeDays: t.nStoreDays, under: t.underPlan, unschUncovered: t.unschUncovered };
    F.gapCovered = ADH.coverage.gapCovered;
    // Behavioural minutes beyond tolerance, before store-day netting (shown for transparency)
    F.behav = { min: t.behavMin, cost: t.cBehav, early: t.avEarly, late: t.avLate, meal: t.mealSkip };
    // 4. estimated avoidable: behavioural minutes capped at store-day labor above plan + OT premium from drift
    F.avoid = {
      early: { min: t.avoidEarlyMin, cost: t.cAvoidEarly },
      late: { min: t.avoidLateMin, cost: t.cAvoidLate },
      mealSkip: { min: t.avoidMealMin, cost: t.cAvoidMeal },
      otDrift: { min: OT.tot.driftOt, cost: OT.tot.premDrift },
    };
    F.avoidCost = t.cAvoid + OT.tot.premDrift;
    F.avoidMin = t.avoidMin;
    F.reviewCost = Math.max(0, t.cOverPlan - t.cAvoid) + OT.tot.premSched;
    // Monthly run-rate from the most recent complete months (up to 3).
    const full = M.months.filter((m) => !m.partial);
    const recent = (full.length ? full : M.months).slice(-3);
    const mAvoid = (mk) => { const a = ADH.byMonth[mk] || {}; const o = OT.byMonth[mk] || {}; return (a.cAvoid || 0) + (o.premDrift || 0); };
    F.avoidRunRate = recent.length ? U.sum(recent.map((m) => mAvoid(m.key))) / recent.length : 0;
    F.runRateMonths = recent.map((m) => m.label);
    F.avoidPct = labor ? F.avoidCost / labor : 0;
    // Manual punches (Source Id MANUAL): a lens over the categories above — overlaps them, never added.
    const manEmps = new Set(), manStores = new Set();
    for (const p of M.punches) if (p.src === 'MANUAL') { manEmps.add(p.g); manStores.add(p.s); }
    const me = INT.bySrc.MANUAL || {};
    F.manual = { n: t.manN, min: t.manMin, pay: t.cMan, early: t.manEarly, late: t.manLate, unsch: t.manUnsch, beyondTolMin: t.manBehav, beyondTolCost: t.cManBehav,
      avoidMin: t.manAvoidMin, avoidCost: t.cManAvoid, emps: manEmps.size, stores: manStores.size, share: t.act ? t.manMin / t.act : 0,
      edited: me.edited || 0, editAddMin: me.addMin || 0, editAddCost: me.addCost || 0, editRemMin: me.remMin || 0,
      extraCost: t.cManExtra };
    F.savingsRange = [F.avoidCost * 0.5, F.avoidCost];
    // Edits: net paid time added, excluding corrections of forgotten clock-outs (those remove unworked time).
    const it = INT.tot;
    F.edits = { addCost: it.addCost, remCost: it.remCost, forgotCost: it.forgotCost || 0, netCost: it.addCost - (it.remCost - (it.forgotCost || 0)), edited: it.edited, addedN: it.addedN || 0 };
    // Non-overlapping cost attribution of additional labor cost: each minute is in exactly one part.
    F.parts = [
      { k: 'late', label: 'Late clock-outs', cost: t.cLate, avoid: t.cAvoidLate, min: t.late },
      { k: 'early', label: 'Early clock-ins', cost: t.cEarly, avoid: t.cAvoidEarly, min: t.early },
      { k: 'unsch', label: 'Unscheduled shifts', cost: t.cUnsch, avoid: 0, min: t.unsch, note: 'not counted as avoidable until call-in reasons are validated' },
      { k: 'meal', label: 'Skipped planned meals', cost: t.cMealSkip, avoid: t.cAvoidMeal, min: t.mealSkip },
      { k: 'ot', label: 'Overtime premium', cost: OT.tot.prem, avoid: OT.tot.premDrift, min: OT.tot.ot + OT.tot.dt, note: 'premium only; base pay of OT hours is in the parts above or in scheduled time' },
    ].sort((a, b) => b.cost - a.cost);
    // Lenses: overlap the parts above, never added to them.
    F.lenses = [
      { k: 'manual', label: 'Recorded through manual punches', cost: t.cManExtra, avoid: t.cManAvoid },
      { k: 'edits', label: 'Net paid time added by punch edits', cost: F.edits.netCost, avoid: null },
    ];
    return F;
  }

  function storeTable(M, R, ADH, OT, INT, CMP, SAL) {
    const sales = SAL.available ? Object.fromEntries(SAL.perStore.map((x) => [x.s, x])) : {};
    const empCount = {}, longP = {};
    for (const [g, e] of M.emps) if (e.store) empCount[e.store] = (empCount[e.store] || 0) + 1;
    for (const p of M.punches) if (p.tot >= R.autoClosePunch.value) longP[p.s] = (longP[p.s] || 0) + 1;
    return Object.keys(ADH.byStore).map((s) => {
      const a = ADH.byStore[s], o = OT.byStore[s] || {}, e = INT.byStore[s] || {}, mm = INT.methodByStore[s] || {}, man = INT.manual.byStore[s] || {}, b = CMP.breaks.byStore[s] || {};
      const ev = U.sum(Object.values(mm));
      const sl = sales[s];
      return {
        s, name: M.storeName[s] || s, emps: empCount[s] || 0,
        paidHrs: a.act / 60, schHrs: a.sch / 60, varHrs: (a.act - a.sch) / 60, varPct: a.sch ? a.act / a.sch - 1 : NaN, labor: a.cAct,
        early: a.early, late: a.late, unsch: a.unsch, mealSkip: a.mealSkip, noShow: a.noShow,
        nEarlyEv: a.nEarlyEv, nLateEv: a.nLateEv, nDays: a.nDays,
        avoid: a.cAvoid + (o.premDrift || 0), grossAdd: a.cEarly + a.cLate + a.cUnsch + a.cMealSkip + (o.prem || 0),
        avoidPerHr: a.act ? (a.cAvoid + (o.premDrift || 0)) / (a.act / 60) : 0,
        overPlanHrs: a.overPlan / 60, overPlanCost: a.cOverPlan, overDays: a.nOverDays, storeDays: a.nStoreDays, unschUncovered: a.unschUncovered,
        overPlanPct: a.sch ? a.overPlan / a.sch : 0,
        otHrs: ((o.ot || 0) + (o.dt || 0)) / 60, otPrem: o.prem || 0, otDrift: o.premDrift || 0,
        edited: e.edited || 0, editPct: e.punches ? e.edited / e.punches : 0, editAddMin: e.addMin || 0, editAddCost: e.addCost || 0,
        manualPct: ev ? (mm.MANUAL || 0) / ev : 0, retro: man.retro || 0,
        missedMealPct: b.eligible ? b.missed / b.eligible : NaN, shortMeals: b.short || 0,
        splh: sl ? sl.splh : NaN, laborPct: sl ? sl.laborPct : NaN, ach: sl ? sl.ach : NaN, fcstBias: sl ? sl.fcstBias : NaN, sales: sl ? sl.as : NaN,
        peerGapHrs: sl ? sl.peerGapHrs : NaN, nonFlex: sl ? sl.nonFlex.length : 0,
        manN: a.manN, manMin: a.manMin, manPay: a.cMan, manAvoid: a.cManAvoid, manShare: a.act ? a.manMin / a.act : 0, manExtraCost: a.cManExtra,
        cEarly: a.cEarly, cLate: a.cLate, cUnsch: a.cUnsch, cMeal: a.cMealSkip, editNetCost: (e.addCost || 0) - ((e.remCost || 0) - (e.forgotCost || 0)),
        minorPunches: (CMP.minors.byStore[s] || {}).punches || 0, minorLate: (CMP.minors.byStore[s] || {}).lateNight || 0, longPunches: longP[s] || 0,
      };
    });
  }

  function employeeTable(M, R, ADH, OT, INT, CMP) {
    const rw = R.recurringWeeks.value;
    return Object.keys(ADH.byEmp).map((g) => {
      const a = ADH.byEmp[g], o = OT.byEmp[g] || {}, e = INT.byEmp[g] || {}, man = INT.manual.byEmp[g] || {}, b = CMP.breaks.byEmp[g] || {};
      const m = M.emps.get(g) || {};
      return {
        g, name: m.name || '(unknown)', store: m.store || '', storeName: M.storeName[m.store] || m.store || '', stores: (m.stores || []).length, job: m.job || '',
        age: m.minAge, paidHrs: a.act / 60, schHrs: a.sch / 60, varHrs: (a.act - a.sch) / 60, days: a.nDays,
        early: a.early, nEarlyEv: a.nEarlyEv, earlyWeeks: a.earlyWeeks.size, late: a.late, nLateEv: a.nLateEv, lateWeeks: a.lateWeeks.size,
        unsch: a.unsch, unschWeeks: a.unschWeeks.size, mealSkip: a.mealSkip, skipWeeks: a.skipWeeks.size,
        avoid: a.cAvoid + (o.premDrift || 0), behav: a.cBehav, grossAdd: a.cEarly + a.cLate + a.cUnsch + a.cMealSkip + (o.prem || 0),
        otHrs: ((o.ot || 0) + (o.dt || 0)) / 60, otPrem: o.prem || 0, otWeeks: o.otWeeks || 0, otDrift: o.premDrift || 0,
        edited: e.edited || 0, editPct: e.punches ? e.edited / e.punches : 0, editAddMin: e.addMin || 0, editWeeks: e.weeks ? e.weeks.size : 0,
        manual: man.n || 0, retro: man.retro || 0, missedMeals: b.missed || 0, shortMeals: b.short || 0,
        recurringEarly: a.earlyWeeks.size >= rw, recurringLate: a.lateWeeks.size >= rw, recurringOt: (o.otWeeks || 0) >= rw,
        cEarly: a.cEarly, cLate: a.cLate, cUnsch: a.cUnsch, cMeal: a.cMealSkip, manExtraCost: a.cManExtra,
        editNetCost: (e.addCost || 0) - ((e.remCost || 0) - (e.forgotCost || 0)),
        mainIssue: [['Late clock-outs', a.cLate], ['Early clock-ins', a.cEarly], ['Unscheduled shifts', a.cUnsch], ['Skipped planned meals', a.cMealSkip], ['Overtime premium', o.prem || 0]].sort((x, y) => y[1] - x[1]).filter((x) => x[1] > 0).map((x) => x[0])[0] || '',
        manN: a.manN, manMin: a.manMin, manPay: a.cMan, manAvoid: a.cManAvoid, manWeeks: a.manWeeks ? a.manWeeks.size : 0, recurringManual: (a.manWeeks ? a.manWeeks.size : 0) >= rw,
        devTypes: [a.earlyWeeks.size >= rw, a.lateWeeks.size >= rw, (o.otWeeks || 0) >= rw, (a.manWeeks ? a.manWeeks.size : 0) >= rw, (e.weeks ? e.weeks.size : 0) >= rw, a.unschWeeks.size >= rw].filter(Boolean).length,
        nameConflict: (m.altNames || []).length > 0,
      };
    });
  }

  function trends(M, R, ADH, OT, INT, SAL, CMP) {
    const series = M.months.map((m) => {
      const a = ADH.byMonth[m.key] || LCI.analysis.newAcc(), o = OT.byMonth[m.key] || {}, e = INT.byMonth[m.key] || {}, mm = INT.methodByMonth[m.key] || {}, man = INT.manual.byMonth[m.key] || {}, s = SAL.available ? SAL.byMonth.find((x) => x.month === m.key) : null, b = CMP.breaks.byMonth[m.key] || {};
      const ev = U.sum(Object.values(mm));
      const hrs = a.act / 60;
      const per100 = (x) => (hrs ? (x / 60) / hrs * 100 : 0); // additional hours per 100 paid hours
      return {
        month: m.key, label: m.label, partial: m.partial, days: m.days,
        paidHrs: hrs, schHrs: a.sch / 60, varPct: a.sch ? a.act / a.sch - 1 : NaN, labor: a.cAct,
        early: a.early / 60, late: a.late / 60, unsch: a.unsch / 60, mealSkip: a.mealSkip / 60,
        earlyPer100: per100(a.early), latePer100: per100(a.late), unschPer100: per100(a.unsch), mealSkipPer100: per100(a.mealSkip),
        avoid: a.cAvoid + (o.premDrift || 0), avoidPct: a.cAct ? (a.cAvoid + (o.premDrift || 0)) / a.cAct : 0,
        overPlanHrs: a.overPlan / 60, overPlanPct: a.sch ? a.overPlan / a.sch : 0, overPlanCost: a.cOverPlan,
        otHrs: ((o.ot || 0) + (o.dt || 0)) / 60, otPrem: o.prem || 0, otPer100: per100((o.ot || 0) + (o.dt || 0)),
        editPct: e.punches ? e.edited / e.punches : 0, editAddMin: e.addMin || 0, manualPct: ev ? (mm.MANUAL || 0) / ev : 0, retro: man.retro || 0, retroPct: man.n ? man.retro / man.n : 0,
        missedMealPct: b.eligible ? b.missed / b.eligible : NaN,
        sales: s ? s.as : NaN, fcst: s ? s.fs : NaN, splh: s ? s.splh : NaN, laborPct: s ? s.laborPct : NaN, ach: s ? s.ach : NaN,
      };
    });
    // Direction of each metric: average of last 3 months vs first 3 months (needs ≥ 6 months).
    const dir = {};
    const metrics = ['varPct', 'earlyPer100', 'latePer100', 'unschPer100', 'mealSkipPer100', 'avoidPct', 'otPer100', 'editPct', 'manualPct', 'retroPct', 'missedMealPct', 'splh', 'laborPct', 'ach'];
    if (series.length >= 6) {
      for (const k of metrics) {
        const v = series.map((x) => x[k]).filter(isFinite);
        if (v.length < 6) continue;
        const a = U.sum(v.slice(0, 3)) / 3, b = U.sum(v.slice(-3)) / 3;
        dir[k] = { first3: a, last3: b, change: a ? b / a - 1 : NaN, slope: U.slope(v) };
      }
    }
    // Persistent stores: top quartile of avoidable $ per paid hour in ≥ N months.
    const pm = R.persistentMonths.value;
    const persist = {};
    for (const m of M.months) {
      const rows = Object.keys(ADH.byStore).map((s) => {
        const a = ADH.byStoreMonth[s + '|' + m.key], o = OT.byStoreMonth[s + '|' + m.key] || {};
        if (!a || a.act < 60 * 100) return null; // ignore store-months with < 100 paid hours
        return { s, v: (a.cOverPlan + (o.prem || 0)) / (a.act / 60) };
      }).filter(Boolean);
      if (rows.length < 4) continue;
      const cut = U.quantile(rows.map((r) => r.v), 0.75);
      for (const r of rows) if (r.v >= cut) persist[r.s] = (persist[r.s] || 0) + 1;
    }
    const persistent = Object.entries(persist).filter(([, n]) => n >= pm).map(([s, n]) => ({ s, months: n })).sort((a, b) => b.months - a.months);
    return { series, dir, persistent, persistMonths: persist };
  }

  /**
   * Run every analysis on an ingested dataset. cfg: { name, excludeStores, rules }
   * Returns { result (plain JSON for the UI), ctx (kept by the worker for drill-down queries) }
   */
  function analyse(ing, cfg, progress) {
    const step = (msg) => progress && progress({ stage: 'analyse', msg });
    step('Normalising records and checking data quality');
    const M = LCI.model.build(ing, cfg);
    if (!M.punches.length) {
      const err = new Error('No usable punch records were found. A punch/timecard report with GEID, clock-in, clock-out and paid hours is required.');
      err.files = ing.files; throw err;
    }
    const base = LCI.scope.filterModel(M, {});
    const out = run(base, cfg, progress);
    out.ctx.M0 = M;
    return out;
  }

  /**
   * Re-run the whole analysis for a store set and/or date range, on the already-normalised model.
   * filter = { stores: [store keys] | null, from: day number, to: day number }
   * The weekly OT threshold inferred on the full dataset is kept, so small slices are not re-inferred.
   */
  function analyseFiltered(M0, cfg, filter, baseRules, progress) {
    const M = LCI.scope.filterModel(M0, filter);
    const rules = Object.assign({}, cfg.rules || {});
    if (baseRules && baseRules.weeklyOtThreshold && rules.weeklyOtThreshold == null) rules.weeklyOtThreshold = baseRules.weeklyOtThreshold.value;
    const out = run(M, Object.assign({}, cfg, { rules }), progress);
    out.ctx.M0 = M0;
    return out;
  }

  function run(M, cfg, progress) {
    const step = (msg) => progress && progress({ stage: 'analyse', msg });
    const R = LCI.rules.build(cfg.rules);
    step('Matching punches to schedules by GEID');
    const ADH = LCI.analysis.adherence(M, R);
    step('Analysing overtime');
    const OT = LCI.analysis.overtime(M, R, ADH);
    step('Analysing punch edits, manual entries and punch methods');
    const INT = LCI.analysis.integrity(M, R, ADH);
    step('Checking breaks, minors and labor exceptions');
    const CMP = LCI.analysis.compliance(M, R, ADH);
    step('Calculating monthly sales and labor efficiency');
    const SAL = LCI.analysis.sales(M, R, ADH);
    step('Building summaries and trends');
    const F = financials(M, R, ADH, OT, INT, SAL);
    const stores = storeTable(M, R, ADH, OT, INT, CMP, SAL);
    const employees = employeeTable(M, R, ADH, OT, INT, CMP);
    step('Detecting employee behaviour patterns');
    const BEH = LCI.analysis.behavior(M, R, ADH, OT, INT, employees);
    // Per employee: number of recurring patterns, longest streak, and last day with any deviation.
    const lastDev = {};
    for (const d of ADH.days) if (d.nEarlyEv || d.nLateEv || d.unsch > 0 || d.mealSkip > 0 || d.manN) if (!lastDev[d.g] || d.day > lastDev[d.g]) lastDev[d.g] = d.day;
    for (const e of employees) {
      const b = BEH.empSummary[e.g];
      e.patternCount = b ? b.count : 0; e.patternCats = b ? b.cats : []; e.maxStreak = b ? b.maxStreak : 0;
      e.lastDeviation = lastDev[e.g] != null ? U.isoDay(lastDev[e.g]) : '';
    }
    for (const s of stores) {
      s.patternEmps = new Set(BEH.patterns.filter((p) => p.store === s.s && p.cat !== 'combined').map((p) => p.g)).size;
    }
    // Headline: largest non-overlapping category and the store with the most avoidable cost.
    F.topCategory = F.parts[0] ? { label: F.parts[0].label, cost: F.parts[0].cost } : null;
    const ts = stores.slice().sort((a, b) => b.avoid - a.avoid)[0];
    F.topStore = ts ? { s: ts.s, name: ts.name, avoid: ts.avoid, grossAdd: ts.grossAdd } : null;
    F.affected = { emps: employees.filter((e) => e.grossAdd > 0).length, stores: stores.filter((s) => s.grossAdd > 0).length };
    const TR = trends(M, R, ADH, OT, INT, SAL, CMP);
    const ctx = { M, R, ADH, OT, INT, CMP, SAL, F, stores, employees, TR, cfg, BEH };
    const quality = LCI.quality.build(ctx, { files: M.files });
    ctx.quality = quality;
    step('Generating findings and recommendations');
    const insights = LCI.insights.generate(ctx);
    ctx.insights = insights;
    const result = LCI.present.result(ctx);
    return { result, ctx };
  }

  LCI.pipeline = { readZip, textConsumer, analyse, analyseFiltered };
})(typeof globalThis !== 'undefined' ? globalThis : self);
