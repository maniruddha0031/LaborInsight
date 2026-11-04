/*
 * model.js — post-ingest normalisation and data-quality evidence.
 *
 *  - Analysis period = the business-day range covered by paid punches (falls back to schedule).
 *  - Records outside the period are counted and excluded, never silently dropped.
 *  - Test / non-production stores are excluded when listed in the manifest or detected
 *    (all-same-digit store IDs such as 77777, or stores where most employee names look synthetic).
 *  - GEID is the only employee key. Names are kept for display; conflicts are reported, not merged.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;

  function topKey(obj) {
    let best = '', bc = -1;
    for (const k in obj) if (obj[k] > bc) { bc = obj[k]; best = k; }
    return best;
  }

  function build(ing, cfg) {
    const Q = [];   // data-quality issues: {level:'error'|'warn'|'info', area, msg, count}
    const q = (level, area, msg, count) => Q.push({ level, area, msg, count: count == null ? null : count });

    // ---- store display names ----
    const storeName = {};
    for (const [k, forms] of ing.storeDisplay) storeName[k] = topKey(forms);
    for (const [k, forms] of ing.storeDisplay) {
      const n = Object.keys(forms).length;
      if (n > 1) q('info', 'Stores', `Store ${storeName[k]} appears in ${n} formats (${Object.keys(forms).join(', ')}); normalised to one store.`);
    }

    // ---- period ----
    let minD = Infinity, maxD = -Infinity;
    const src = ing.punches.length ? ing.punches : ing.schedule;
    for (const p of src) { if (p.day < minD) minD = p.day; if (p.day > maxD) maxD = p.day; }
    if (!isFinite(minD)) { minD = null; maxD = null; }
    const period = { start: minD, end: maxD, startIso: minD != null ? U.isoDay(minD) : '', endIso: maxD != null ? U.isoDay(maxD) : '' };
    const months = [];
    if (minD != null) {
      let d = minD;
      while (d <= maxD) {
        const mk = U.monthKey(d);
        if (!months.length || months[months.length - 1].key !== mk) months.push({ key: mk, first: d, last: d, days: 0 });
        const m = months[months.length - 1];
        m.last = d; m.days++;
        d++;
      }
      for (const m of months) {
        const p = U.dateParts(m.first);
        m.calDays = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
        m.partial = m.days < m.calDays;
        m.label = new Date(m.first * 86400000).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ' + p.y;
        if (m.partial) q('warn', 'Coverage', `${m.label} covers ${m.days} of ${m.calDays} days (${U.isoDay(m.first)} to ${U.isoDay(m.last)}). Monthly totals for it are not a full month.`);
      }
    }

    // ---- test / non-production stores ----
    const excluded = new Set((cfg.excludeStores || []).map((s) => LCI.Ingestor.normStore(String(s))));
    const empByStore = {};
    for (const e of ing.emp.values()) {
      const s = topKey(e.stores);
      if (!s) continue;
      const nm = topKey(e.names);
      const st = (empByStore[s] = empByStore[s] || { n: 0, junk: 0 });
      st.n++;
      if (LCI.Ingestor.JUNK_NAME.test(nm)) st.junk++;
    }
    const salesStores = new Set([...ing.sales.values()].map((a) => a.s));
    for (const s in storeName) {
      const disp = storeName[s];
      const sameDigit = /^(\d)\1{3,}$/.test(disp);
      const st = empByStore[s];
      const junky = st && st.n >= 3 && st.junk / st.n >= 0.5;
      if (!excluded.has(s) && (sameDigit || junky)) {
        excluded.add(s);
        q('warn', 'Test data', `Store ${disp} looks like a test/training store (${sameDigit ? 'placeholder store ID' : 'mostly synthetic employee names'}); excluded from analysis.`);
      }
    }
    for (const s of excluded) if (cfg.excludeStores && cfg.excludeStores.map((x) => LCI.Ingestor.normStore(String(x))).includes(s))
      q('info', 'Test data', `Store ${storeName[s] || s} excluded by dataset configuration.`);

    // ---- filter records: period + excluded stores ----
    const counts = {};
    const keep = (name, list) => {
      const c = (counts[name] = { total: list.length, outOfPeriod: 0, excludedStore: 0 });
      const out = list.filter((r) => {
        if (r.s && excluded.has(r.s)) { c.excludedStore++; return false; }
        if (minD != null && (r.day < minD || r.day > maxD)) { c.outOfPeriod++; return false; }
        return true;
      });
      c.kept = out.length;
      return out;
    };
    const M = {
      period, months, storeName, excluded: [...excluded].map((s) => storeName[s] || s), excludedKeys: excluded,
      schedule: keep('Schedule', ing.schedule),
      punches: keep('Punches', ing.punches),
      approvals: keep('Punch change approvals', ing.approvals),
      breaks: keep('Breaks', ing.breaks),
      auditManual: keep('Manual punch entries', ing.auditManual),
      auditEdits: keep('Punch audit edits', ing.auditEdits),
      violations: keep('Labor exceptions', ing.violations),
      premium: keep('Premium pay', ing.premium),
      misc: keep('Misc pay', ing.misc),
      excPunch: [...ing.excPunch.values()].filter((p) => !excluded.has(p.s) && (minD == null || (p.day >= minD && p.day <= maxD))),
      sales: [...ing.sales.values()].filter((a) => !excluded.has(a.s)),
      auditMethod: ing.auditMethod, auditEmpMethod: ing.auditEmpMethod, auditEditor: ing.auditEditor,
      breakAudit: ing.breakAudit, files: ing.files, recordCounts: counts, quality: Q,
    };
    for (const k in counts) {
      const c = counts[k];
      if (c.outOfPeriod) q('info', 'Coverage', `${k}: ${c.outOfPeriod.toLocaleString('en-US')} record(s) fall outside the analysis period ${period.startIso} – ${period.endIso} and were excluded.`, c.outOfPeriod);
      if (c.excludedStore) q('info', 'Test data', `${k}: ${c.excludedStore.toLocaleString('en-US')} record(s) belong to excluded test stores.`, c.excludedStore);
    }

    // ---- employee master (GEID) ----
    const emps = new Map();
    let nameConflicts = 0, tcMismatch = 0, junkNames = 0;
    for (const e of ing.emp.values()) {
      const s = topKey(e.stores);
      if (s && excluded.has(s) && Object.keys(e.stores).every((x) => excluded.has(x))) continue;
      const names = Object.keys(e.names);
      const name = topKey(e.names) || '(no name)';
      const ages = Object.keys(e.ages).map(Number);
      const jobs = Object.keys(e.jobs).filter((j) => !j.startsWith('sched:'));
      const rec = {
        geid: e.geid, name, altNames: names.filter((n) => n.toLowerCase() !== name.toLowerCase()),
        store: s, stores: Object.keys(e.stores).filter((x) => !excluded.has(x)),
        job: jobs.length ? jobs.sort((a, b) => e.jobs[b] - e.jobs[a])[0] : '',
        minAge: ages.length ? Math.min(...ages) : null, maxAge: ages.length ? Math.max(...ages) : null,
        schedMinor: e.minorFlagYes > 0,
        timecardMismatch: Object.keys(e.timecards).some((t) => t !== e.geid),
        payrollIds: Object.keys(e.payrollIds).length,
        junkName: LCI.Ingestor.JUNK_NAME.test(name),
        types: e.types,
      };
      if (rec.altNames.length) nameConflicts++;
      if (rec.timecardMismatch) tcMismatch++;
      if (rec.junkName) junkNames++;
      emps.set(e.geid, rec);
    }
    M.emps = emps;
    if (nameConflicts) q('warn', 'GEID', `${nameConflicts} GEID(s) carry more than one employee name across files (e.g. spelling or case). Analysis keeps them as one employee because the GEID matches; names are display-only.`, nameConflicts);
    if (tcMismatch) q('info', 'GEID', `${tcMismatch} GEID(s) have a Timecard number that differs from the GEID. GEID is used for all joins.`, tcMismatch);
    if (junkNames) q('warn', 'GEID', `${junkNames} employee record(s) have placeholder-looking names (digits, keyboard strings, "test"). Kept, but they may be test accounts.`, junkNames);

    // Same name, different GEIDs — reported only; never merged.
    const byName = {};
    for (const r of emps.values()) { const k = r.name.toLowerCase(); (byName[k] = byName[k] || []).push(r.geid); }
    const shared = Object.values(byName).filter((a) => a.length > 1).length;
    if (shared) q('info', 'GEID', `${shared} employee name(s) are used by more than one GEID. They are treated as different people (GEID rules), not merged.`, shared);

    // GEIDs that only collide once leading zeros are stripped — possible formatting inconsistency.
    const stripped = {};
    for (const g of emps.keys()) { const k = g.replace(/^0+/, ''); (stripped[k] = stripped[k] || []).push(g); }
    const lz = Object.values(stripped).filter((a) => a.length > 1).length;
    if (lz) q('warn', 'GEID', `${lz} GEID pair(s) differ only by leading zeros. Not merged automatically — confirm whether they are the same person.`, lz);

    // Cross-file GEID coverage.
    const inSched = new Set(M.schedule.map((r) => r.g)), inPunch = new Set(M.punches.map((r) => r.g));
    let punchOnly = 0, schedOnly = 0;
    for (const g of inPunch) if (!inSched.has(g)) punchOnly++;
    for (const g of inSched) if (!inPunch.has(g)) schedOnly++;
    M.geidCoverage = { punch: inPunch.size, sched: inSched.size, punchOnly, schedOnly };
    if (punchOnly) q('info', 'Matching', `${punchOnly} GEID(s) have paid punches but never appear in the schedule — all their hours count as unscheduled.`, punchOnly);
    if (schedOnly) q('info', 'Matching', `${schedOnly} GEID(s) are scheduled but have no paid punches in the period.`, schedOnly);

    // Stores present in labor data but missing from sales (or the reverse).
    const laborStores = new Set(M.punches.map((p) => p.s));
    const noSales = [...laborStores].filter((s) => !salesStores.has(s));
    const noLabor = [...salesStores].filter((s) => !laborStores.has(s) && !excluded.has(s));
    if (ing.sales.size && noSales.length) q('warn', 'Matching', `${noSales.length} store(s) have punches but no sales rows: ${noSales.map((s) => storeName[s]).slice(0, 10).join(', ')}. They are left out of sales-efficiency KPIs.`, noSales.length);
    if (noLabor.length) q('info', 'Matching', `${noLabor.length} store(s) have sales rows but no punches.`, noLabor.length);
    M.noSalesStores = noSales;

    return M;
  }

  LCI.model = { build, topKey };
})(typeof globalThis !== 'undefined' ? globalThis : self);
