/*
 * integrity.js — punch edits, manual time entry, punch methods and editor behaviour.
 *
 * Payable-time impact of edits is measured on the paid punch itself (Original vs Adjusted clock times):
 *     minutes added by an edit = (adjusted out − adjusted in) − (original out − original in)
 * Positive = the edit increased paid time. Costed at that punch's own pay rate.
 *
 * Patterns surfaced for review (never as proof of intent):
 *   - edits that move a punch exactly onto the scheduled start/end ("snap to schedule")
 *   - edited times landing on :00/:15/:30/:45 far more often than real clock punches do
 *   - manual punches keyed in long after the time they claim (retroactive entry)
 *   - editors who change their own punches (matched on name — editors carry no GEID; lower confidence)
 *   - days with abnormal edit volume
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;
  const A = (LCI.analysis = LCI.analysis || {});

  const q15 = (t) => isFinite(t) && U.minOfDay(t) % 15 === 0;

  /** "jdoe@x.com : Jane, Doe" -> {display:'Jane Doe', kind:'user'}; "gm00221@… : GM, 221" -> store GM account. */
  function parseEditor(raw) {
    const s = (raw || '').trim();
    if (!s || s === '-') return null;
    if (/^system$/i.test(s)) return { key: 'System', display: 'System (automatic)', kind: 'system', person: '' };
    const m = /^([^\s:]+@[^\s:]+)\s*:\s*(.*)$/.exec(s);
    if (m) {
      const email = m[1].toLowerCase();
      const parts = m[2].split(',').map((x) => x.trim());
      const gm = /^gm0*(\d+)@/i.exec(email);
      if (gm && /^gm$/i.test(parts[0] || '')) return { key: email, display: 'GM account · store ' + gm[1], kind: 'storeAccount', person: '', email, store: gm[1] };
      const person = parts.length >= 2 ? (parts[0] + ' ' + parts.slice(1).join(' ')).trim() : m[2].trim();
      return { key: email, display: person || email, kind: 'user', person, email };
    }
    return { key: s.toLowerCase(), display: s, kind: 'user', person: s };
  }
  A.parseEditor = parseEditor;

  A.integrity = function (M, R, ADH) {
    const S = ADH._idx.sIdx;
    const blockEdges = (g, day) => {
      const sr = S.get(g + '|' + day);
      if (!sr) return null;
      const base = day * 1440;
      const b = U.union(LCI.analysis.schedIntervals(sr, base).shifts);
      return { starts: new Set(b.map((x) => x[0])), ends: new Set(b.map((x) => x[1])) };
    };

    // ---- 1. edits on paid punches ----
    const mk = () => ({ punches: 0, edited: 0, addMin: 0, remMin: 0, addCost: 0, remCost: 0, inEarlier: 0, outLater: 0, snap: 0, snapMin: 0, forgotOut: 0, forgotMin: 0, forgotCost: 0, qEdited: 0, qEditedN: 0, addedN: 0 });
    const tot = mk(), byStore = {}, byEmp = {}, byMonth = {}, bySrc = {};
    const editedList = [];
    let qOrig = 0, qOrigN = 0;
    for (const p of M.punches) {
      const groups = [tot, byStore[p.s] = byStore[p.s] || mk(), byEmp[p.g] = byEmp[p.g] || Object.assign(mk(), { weeks: new Set() }),
        byMonth[U.monthKey(p.day)] = byMonth[U.monthKey(p.day)] || mk(), bySrc[p.src || '(none)'] = bySrc[p.src || '(none)'] || mk()];
      for (const o of groups) o.punches++;
      // Baseline for "round" times: original punches captured by a device, not keyed in by hand.
      if (isFinite(p.inO) && p.src !== 'MANUAL') { qOrigN++; if (q15(p.inO)) qOrig++; }
      const inCh = isFinite(p.inO) && isFinite(p.inA) && p.inO !== p.inA;
      const outCh = isFinite(p.outO) && isFinite(p.outA) && p.outO !== p.outA;
      if (!inCh && !outCh) continue;
      const before = isFinite(p.outO) && isFinite(p.inO) ? p.outO - p.inO : NaN;
      const after = isFinite(p.outA) ? p.outA - p.inA : NaN;
      const net = isFinite(before) && isFinite(after) ? after - before : 0;
      const forgot = isFinite(before) && before >= R.autoClosePunch.value && net < 0;
      const edges = blockEdges(p.g, p.day);
      const snap = edges && ((inCh && edges.starts.has(p.inA)) || (outCh && edges.ends.has(p.outA)));
      const rate = ADH.rateFor(p) || 0;
      for (const o of groups) {
        o.edited++;
        if (net > 0) { o.addMin += net; o.addCost += (net / 60) * rate; }
        else if (net < 0) { o.remMin -= net; o.remCost -= (net / 60) * rate; }
        if (inCh && p.inA < p.inO) o.inEarlier++;
        if (outCh && p.outA > p.outO) o.outLater++;
        if (snap) { o.snap++; if (net > 0) o.snapMin += net; }
        if (forgot) { o.forgotOut++; o.forgotMin -= net; o.forgotCost -= (net / 60) * rate; }
        if (net > 0) o.addedN++;
        if (inCh) { o.qEditedN++; if (q15(p.inA)) o.qEdited++; }
        if (outCh) { o.qEditedN++; if (q15(p.outA)) o.qEdited++; }
      }
      groups[2].weeks.add(U.weekStart(p.day));
      editedList.push({ g: p.g, s: p.s, day: p.day, inO: p.inO, outO: p.outO, inA: p.inA, outA: p.outA, net, rate, snap: !!snap, forgot, src: p.src });
    }
    const quarter = { origShare: qOrigN ? qOrig / qOrigN : null, editedShare: tot.qEditedN ? tot.qEdited / tot.qEditedN : null, naturalShare: 4 / 60 };

    // ---- 2. manual entries (audit log) ----
    const retro = R.retroLag.value;
    const man = { n: 0, withLag: 0, retro: 0, nextDay: 0, lags: [], byStore: {}, byEditor: {}, byMonth: {}, byEmp: {} };
    for (const e of M.auditManual) {
      man.n++;
      const st = (man.byStore[e.s] = man.byStore[e.s] || { n: 0, retro: 0, nextDay: 0 });
      const mo = (man.byMonth[U.monthKey(e.day)] = man.byMonth[U.monthKey(e.day)] || { n: 0, retro: 0 });
      const em = (man.byEmp[e.g] = man.byEmp[e.g] || { n: 0, retro: 0 });
      const ed = parseEditor(e.editor);
      const ek = ed ? ed.key : '(not recorded)';
      const er = (man.byEditor[ek] = man.byEditor[ek] || { n: 0, retro: 0, display: ed ? ed.display : '(not recorded)', kind: ed ? ed.kind : 'unknown', stores: {} });
      st.n++; mo.n++; em.n++; er.n++; er.stores[e.s] = 1;
      if (isFinite(e.lag)) {
        man.withLag++;
        man.lags.push(e.lag);
        if (e.lag > retro) { man.retro++; st.retro++; mo.retro++; em.retro++; er.retro++; }
        if (e.lag >= 1440) { man.nextDay++; st.nextDay++; }
      }
    }
    man.medianLag = U.median(man.lags);
    man.p90Lag = U.quantile(man.lags, 0.9);
    const lagBuckets = [['Within 5 min', 5], ['5–60 min', 60], ['1–4 h', 240], ['4–24 h', 1440], ['1 day +', Infinity]];
    man.lagDist = lagBuckets.map(([label]) => ({ label, n: 0 }));
    for (const l of man.lags) { let i = 0; while (l > lagBuckets[i][1]) i++; man.lagDist[i].n++; }
    delete man.lags;

    // ---- 3. punch methods (clock-in/out events in the audit log) ----
    const methods = {}, methodByStore = {}, methodByMonth = {};
    const inScope = M.storeFilter || null;
    for (const [k, n] of M.auditMethod) {
      const [s, dayStr, meth] = k.split('|');
      const day = +dayStr;
      if (M.excludedKeys.has(s) || (inScope && !inScope.has(s))) continue;
      if (day < M.period.start || day > M.period.end) continue;
      const mo = U.monthKey(day);
      methods[meth] = (methods[meth] || 0) + n;
      const st = (methodByStore[s] = methodByStore[s] || {}); st[meth] = (st[meth] || 0) + n;
      const mm = (methodByMonth[mo] = methodByMonth[mo] || {}); mm[meth] = (mm[meth] || 0) + n;
    }
    const totalEv = U.sum(Object.values(methods));
    const bio = Object.keys(methods).filter((m) => /BIO|FACE|FINGER/i.test(m)).reduce((s, m) => s + methods[m], 0);
    const bioShare = totalEv ? bio / totalEv : 0;
    const biometric = {
      events: bio, total: totalEv, share: bioShare,
      comparable: bio >= 200 && bioShare >= R.biometricMinShare.value,
      storesUsing: Object.keys(methodByStore).filter((s) => Object.keys(methodByStore[s]).some((m) => /BIO|FACE|FINGER/i.test(m))).length,
    };

    // Biometric vs non-biometric comparison at employee level, only when the data supports it.
    if (biometric.comparable) {
      const bioEmp = new Set();
      for (const [g, mm] of M.auditEmpMethod) {
        let b = 0, t = 0;
        for (const m in mm) { t += mm[m]; if (/BIO|FACE|FINGER/i.test(m)) b += mm[m]; }
        if (t && b / t >= 0.8) bioEmp.add(g);
      }
      const cmp = { bio: LCI.analysis.newAcc(), other: LCI.analysis.newAcc(), bioEdited: 0, bioPunches: 0, otherEdited: 0, otherPunches: 0 };
      for (const [g, E] of Object.entries(ADH.byEmp)) LCI.analysis.addAcc(bioEmp.has(g) ? cmp.bio : cmp.other, E);
      for (const [g, E] of Object.entries(byEmp)) { if (bioEmp.has(g)) { cmp.bioEdited += E.edited; cmp.bioPunches += E.punches; } else { cmp.otherEdited += E.edited; cmp.otherPunches += E.punches; } }
      cmp.bioEmployees = bioEmp.size;
      biometric.comparison = cmp;
    }

    // ---- 4. editors (approval report) ----
    const editors = {};
    const empName = (g) => { const e = M.emps.get(g); return e ? e.name : ''; };
    const addedKeys = new Set();
    const apTot = { rows: 0, edits: 0, clockRows: 0, manualCreate: 0, modified: 0, deleted: 0, system: 0, breakEdits: 0, selfEdits: 0, addMin: 0, remMin: 0, createdMin: 0, viaStoreAccount: 0, viaNamedUser: 0 };
    const perDay = {}, perStoreDay = {};
    for (const a of M.approvals) {
      apTot.rows++;
      const desc = a.desc.toLowerCase();
      // The approval report also lists ordinary clock punches ("Punch Added" via PIN/clock), where the
      // "Manager Modified" column can hold the employee's own name. Only real changes count as edits:
      // modifications, deletions/restores, system adjustments, and punches keyed in manually.
      const isEdit = /modif|delet|restor|accepted|rejected/.test(desc) || (/added/.test(desc) && a.method === 'MANUAL');
      if (!isEdit) { apTot.clockRows++; continue; }
      apTot.edits++;
      perDay[a.day] = (perDay[a.day] || 0) + 1;
      const sdk = a.s + '|' + a.day;
      perStoreDay[sdk] = (perStoreDay[sdk] || 0) + 1;
      const ed = parseEditor(a.editor);
      const isBreak = /break/i.test(a.type);
      let delta = 0;
      if (/modif/.test(desc) || /accepted/.test(desc)) {
        if (/clock in/i.test(a.type) && isFinite(a.oS) && isFinite(a.aS)) delta = a.oS - a.aS;
        else if (/clock out/i.test(a.type) && isFinite(a.oE) && isFinite(a.aE)) delta = a.aE - a.oE;
        else if (isBreak && isFinite(a.obS) && isFinite(a.obE) && isFinite(a.abS) && isFinite(a.abE)) delta = (a.obE - a.obS) - (a.abE - a.abS);
      }
      let created = 0;
      if (/added/.test(desc) && ed && ed.kind !== 'system' && !isFinite(a.oS) && isFinite(a.aS) && isFinite(a.aE)) {
        const k = a.g + '|' + a.aS + '|' + a.aE;
        if (!addedKeys.has(k)) { addedKeys.add(k); created = a.aE - a.aS; }
      }
      if (!ed) continue; // change with no editor recorded
      if (ed.kind === 'storeAccount') apTot.viaStoreAccount++; else if (ed.kind === 'user') apTot.viaNamedUser++;
      const E = (editors[ed.key] = editors[ed.key] || { key: ed.key, display: ed.display, kind: ed.kind, rows: 0, manualCreate: 0, modified: 0, deleted: 0, breakEdits: 0,
        addMin: 0, remMin: 0, createdMin: 0, self: 0, stores: {}, emps: {}, qAdj: 0, qAdjN: 0, homeStore: ed.store || '' });
      E.rows++; E.stores[a.s] = (E.stores[a.s] || 0) + 1; E.emps[a.g] = 1;
      if (ed.kind === 'system') apTot.system++;
      if (/added/.test(desc) && created) { E.manualCreate++; apTot.manualCreate++; E.createdMin += created; apTot.createdMin += created; }
      if (/modif/.test(desc)) { E.modified++; apTot.modified++; }
      if (/delet/.test(desc)) { E.deleted++; apTot.deleted++; }
      if (isBreak) { E.breakEdits++; apTot.breakEdits++; }
      if (delta > 0) { E.addMin += delta; apTot.addMin += delta; } else if (delta < 0) { E.remMin -= delta; apTot.remMin -= delta; }
      for (const t of [a.aS, a.aE]) if (isFinite(t)) { E.qAdjN++; if (q15(t)) E.qAdj++; }
      // Self-edit: editor's own name equals the employee's name on the punch. Name-based, so it is
      // reported as "probable" and never used to link records.
      if (ed.person) {
        const nm = (a.first + ' ' + a.last).trim().toLowerCase() || empName(a.g).toLowerCase();
        if (nm && nm === ed.person.toLowerCase()) { E.self++; apTot.selfEdits++; }
      }
    }
    const editorList = Object.values(editors).map((e) => Object.assign(e, { storeCount: Object.keys(e.stores).length, empCount: Object.keys(e.emps).length, stores: undefined, emps: undefined, topStore: LCI.model.topKey(e.stores) }))
      .sort((a, b) => b.rows - a.rows);
    const humanRows = editorList.filter((e) => e.kind !== 'system').map((e) => e.rows);
    const editorConc = { editors: humanRows.length, top10share: U.topShare(humanRows, 0.1), top5: editorList.filter((e) => e.kind !== 'system').slice(0, 5) };

    // ---- 5. edit volume spikes ----
    const dayCounts = Object.entries(perDay).map(([d, n]) => ({ day: +d, n }));
    const med = U.median(dayCounts.map((x) => x.n)), mad = U.mad(dayCounts.map((x) => x.n)) || 1;
    const spikes = dayCounts.filter((x) => x.n > med + 8 * mad && x.n > 2.5 * med).sort((a, b) => b.n - a.n);
    const storeDayCounts = Object.entries(perStoreDay).map(([k, n]) => { const [s, d] = k.split('|'); return { s, day: +d, n }; });
    const sdMed = U.median(storeDayCounts.map((x) => x.n));
    const storeSpikes = storeDayCounts.filter((x) => x.n >= Math.max(20, sdMed * 8)).sort((a, b) => b.n - a.n).slice(0, 25);

    return {
      tot, byStore, byEmp, byMonth, bySrc, quarter, editedList,
      manual: man, methods, methodByStore, methodByMonth, biometric,
      approvals: apTot, editors: editorList, editorConc, spikes, editMedianPerDay: med, storeSpikes,
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
