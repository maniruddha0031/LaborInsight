/*
 * quality.js — consolidated data-quality and validation report.
 * Distinguishes missing data (blank / '-'), zero values, and records that do not apply,
 * and reports every exclusion with its count.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;

  const ROUND_CAPS = [65535, 65536, 100000, 200000, 250000, 500000, 1000000, 1048575, 1048576];

  LCI.quality = {
    build(ctx, ing) {
      const { M, ADH, OT, INT, CMP, SAL, R } = ctx;
      const issues = M.quality.slice();
      const add = (level, area, msg, count) => issues.push({ level, area, msg, count: count == null ? null : count });
      const monthKeys = M.months.map((m) => m.key);

      // ---- per-file ----
      const files = ing.files.map((f) => {
        const months = monthKeys.map((k) => ({ k, n: (f.months || {})[k] || 0 }));
        const missingMonths = f.type && f.type !== 'premiumPay' && f.type !== 'miscPay' ? months.filter((m) => !m.n).map((m) => m.k) : [];
        const row = {
          name: f.name, type: f.type, label: f.label, rows: f.rows, accepted: f.accepted, duplicates: f.duplicates || 0, semanticDup: f.semanticDup || 0,
          invalidDate: f.invalidDate || 0, missingGeid: f.missingGeid || 0, missingStore: f.missingStore || 0, badShape: f.badShape || 0,
          stores: f.storeCount != null ? f.storeCount : (f.stores || []).length, from: f.minDay != null ? U.isoDay(f.minDay) : '', to: f.maxDay != null ? U.isoDay(f.maxDay) : '',
          months, missingMonths, notes: (f.notes || []).slice(), unmapped: f.unmapped || [],
        };
        if (ROUND_CAPS.includes(f.rows)) {
          row.notes.push(`Exactly ${f.rows.toLocaleString('en-US')} rows — a common export row limit. The file may be truncated; counts derived from it are lower bounds.`);
          add('warn', 'Completeness', `${f.name} has exactly ${f.rows.toLocaleString('en-US')} data rows, which matches a typical export cap. It may be truncated, so its counts are lower bounds.`, f.rows);
        }
        if (row.duplicates) {
          const share = row.duplicates / Math.max(1, row.rows);
          const dropped = ['schedule', 'punch', 'breaks', 'approval'].includes(f.type);
          add(share > 0.05 ? 'warn' : 'info', 'Duplicates', `${f.name}: ${row.duplicates.toLocaleString('en-US')} exact duplicate rows (${(share * 100).toFixed(1)}%) ${dropped ? 'removed before analysis' : 'detected (rows are aggregated, so duplicates do not inflate results)'}.`, row.duplicates);
        }
        if (row.semanticDup) add('info', 'Duplicates', `${f.name}: ${row.semanticDup.toLocaleString('en-US')} further rows repeat an existing shift segment with a different serial number; removed.`, row.semanticDup);
        if (row.invalidDate) add('warn', 'Validity', `${f.name}: ${row.invalidDate.toLocaleString('en-US')} row(s) with an unreadable date or time were skipped.`, row.invalidDate);
        if (row.missingGeid) add('warn', 'GEID', `${f.name}: ${row.missingGeid.toLocaleString('en-US')} row(s) have no GEID and cannot be linked to an employee; skipped.`, row.missingGeid);
        if (row.badShape) add('warn', 'Validity', `${f.name}: ${row.badShape.toLocaleString('en-US')} row(s) have the wrong number of columns; skipped.`, row.badShape);
        if (f.missingPayrollId) {
          row.notes.push(`${f.missingPayrollId.toLocaleString('en-US')} rows have no Payroll ID.`);
          add('warn', 'Validity', `${f.name}: ${f.missingPayrollId.toLocaleString('en-US')} paid punch rows (${(f.missingPayrollId / Math.max(1, f.rows) * 100).toFixed(1)}%) have no Payroll ID — confirm these hours reach payroll under the right employee.`, f.missingPayrollId);
        }
        return row;
      });
      // Month coverage is judged per report type: monthly reports may legitimately be split into one file per month.
      const byType = {};
      for (const f of files) if (f.type && f.accepted) {
        const t = (byType[f.type] = byType[f.type] || { label: f.label, files: [], months: {} });
        t.files.push(f.name);
        for (const m of f.months) t.months[m.k] = (t.months[m.k] || 0) + m.n;
      }
      for (const k in byType) {
        if (k === 'premiumPay' || k === 'miscPay') continue;
        const t = byType[k];
        const miss = monthKeys.filter((m) => !t.months[m]);
        t.missingMonths = miss;
        if (miss.length) add('warn', 'Coverage', `${t.label} has no rows for ${miss.join(', ')}. Month-level conclusions for those months exclude it.`, miss.length);
        // A month far below the type's median volume suggests an incomplete extract.
        const vals = monthKeys.map((m) => t.months[m] || 0).filter((v) => v > 0);
        const med = U.median(vals);
        const low = monthKeys.filter((m) => t.months[m] > 0 && t.months[m] < med * 0.6 && !M.months.find((x) => x.key === m).partial);
        if (low.length) add('warn', 'Coverage', `${t.label}: ${low.join(', ')} has under 60% of the typical monthly row count — possibly incomplete.`, low.length);
      }
      for (const f of files) f.missingMonths = [];
      const types = new Set(ing.files.map((f) => f.type).filter(Boolean));
      const expected = ['schedule', 'punch', 'punchAudit', 'approval', 'breaks', 'exception', 'sales'];
      const missingTypes = expected.filter((t) => !types.has(t)).map((t) => LCI.schemas.types[t].label);
      for (const t of missingTypes) add(t === 'Punches (timecards with pay)' ? 'error' : 'warn', 'Completeness', `No ${t} report found — analyses that depend on it are shown as unavailable.`);

      // ---- calculation checks ----
      const checks = [];
      const chk = (name, ok, detail, level) => checks.push({ name, status: ok ? 'pass' : level || 'warn', detail });
      const pr = M.punches;
      const recon = pr.filter((p) => isFinite(p.reg)).filter((p) => Math.abs(p.reg + p.ot + p.dt - p.tot) <= 1).length;
      const withReg = pr.filter((p) => isFinite(p.reg)).length;
      chk('Regular + OT + DT hours = Total paid hours', withReg && recon === withReg, `${recon.toLocaleString('en-US')} of ${withReg.toLocaleString('en-US')} punches reconcile.`);
      const ratePresent = pr.filter((p) => p.rate > 0).length;
      chk('Pay rate present on punches', ratePresent / Math.max(1, pr.length) > 0.98, `${(ratePresent / Math.max(1, pr.length) * 100).toFixed(2)}% of punches carry a pay rate > 0. Minutes without any known rate: ${Math.round(ADH.tot.noRateMin).toLocaleString('en-US')} (counted in hours, not in $).`);
      const badRatio = pr.filter((p) => p.rate > 0 && p.otRate > 0 && Math.abs(p.otRate / p.rate - R.otMultiplier.value) > 0.05).length;
      chk('OT pay rate = 1.5 × base rate', badRatio === 0, `${badRatio.toLocaleString('en-US')} punch rows have an OT rate that is not 1.5× the base rate.`, 'info');
      if (OT.noPremium && OT.noPremium.min > 0) add('warn', 'Pay', `${(OT.noPremium.min / 60).toFixed(0)} overtime hours (${OT.noPremium.emps} employees, ${OT.noPremium.weeks} weeks) were paid at straight time or $0 instead of an OT premium. Confirm whether these employees are OT-exempt or whether pay set-up is wrong. No premium is assumed for them.`, OT.noPremium.weeks);
      if (ADH.schedCheck.days) chk('Scheduled paid hours (shift − meal) match export Schedule Hours', ADH.schedCheck.match / ADH.schedCheck.days > 0.9,
        `${(ADH.schedCheck.match / ADH.schedCheck.days * 100).toFixed(1)}% of employee-days agree. Where they differ the employee has several shifts that day and the export repeats a daily total; the engine uses the shift times.`, 'info');
      const thr = R.weeklyOtThreshold;
      if (thr.inferred) chk(`Weekly OT threshold inferred = ${(thr.value / 60).toFixed(0)} h`, thr.inferred.share > 0.95, `${thr.inferred.matching.toLocaleString('en-US')} of ${thr.inferred.otWeeks.toLocaleString('en-US')} overtime weeks match (paid − OT = ${(thr.value / 60).toFixed(0)} h).`);
      chk('Open punches (no clock-out)', ADH.openPunches === 0, `${ADH.openPunches.toLocaleString('en-US')} punch(es) have no clock-out and were excluded from minutes.`, 'info');
      chk(`Punches ≥ ${R.autoClosePunch.value / 60} h (probable forgotten clock-out)`, ADH.longPunches === 0, `${ADH.longPunches.toLocaleString('en-US')} paid punch(es) are at least ${R.autoClosePunch.value / 60} hours long.`);
      chk('Adherence reconciliation', Math.abs(ADH.recon.residual) / Math.max(1, Math.abs(ADH.tot.act)) < 0.02,
        `Actual − scheduled = ${(ADH.recon.delta / 60).toFixed(0)} h; components explain ${(ADH.recon.explained / 60).toFixed(0)} h; residual ${(ADH.recon.residual / 60).toFixed(0)} h (mid-shift gaps and partly worked blocks).`, 'info');
      if (SAL.available) {
        chk('Sales granularity', true, 'Forecast and actual sales are used at store × month level only. No daily or hourly sales figures are derived or shown.');
        chk('Paid hours in sales file vs punch export', Math.abs(SAL.recon.ratio - 1) < 0.05, `Hours in the sales/hours file are ${(SAL.recon.ratio * 100).toFixed(1)}% of paid punch hours for the same store-months.`, 'info');
        if (SAL.negSlots) add('info', 'Validity', `Sales file contains ${SAL.negSlots.toLocaleString('en-US')} negative actual-sales rows (refunds/voids); kept in monthly totals.`, SAL.negSlots);
      }
      if (types.has('punchAudit')) {
        const b = INT.biometric;
        chk('Biometric punch volume sufficient for comparison', b.comparable, `${b.events.toLocaleString('en-US')} biometric events out of ${b.total.toLocaleString('en-US')} (${(b.share * 100).toFixed(3)}%).`, 'info');
      }
      if (CMP.minors.flagNo) add('warn', 'Validity', `${CMP.minors.flagNo.toLocaleString('en-US')} punches by employees younger than ${R.minorAge.value} carry Minor = "No" (${CMP.minors.flagMismatchEmployees} employees). Minor labor rules cannot be enforced on a record that is not flagged as minor.`, CMP.minors.flagNo);
      if (CMP.premium.rows === 0 && types.has('premiumPay')) add('info', 'Completeness', 'Premium pay report has no rows for production stores (only test-store rows, if any) — no break-violation premiums are paid in this data.');
      if (types.has('miscPay') && CMP.premium.miscAmount === 0) add('info', 'Completeness', 'Misc pay rows all carry $0 — nothing to quantify.');
      if (types.has('exception') && !CMP.exceptions.breakTypesFlagged.length) add('info', 'Completeness', 'The labor-exception report flags no break violations for production stores, which suggests break rules are not configured on the clock. Break compliance is instead measured from break and punch records.');

      const summary = {
        files: files.length, recognised: files.filter((f) => f.type).length, rowsRead: U.sum(files.map((f) => f.rows || 0)),
        errors: issues.filter((i) => i.level === 'error').length, warnings: issues.filter((i) => i.level === 'warn').length,
        status: issues.some((i) => i.level === 'error') ? 'error' : issues.some((i) => i.level === 'warn') ? 'warn' : 'ok',
      };
      const order = { error: 0, warn: 1, info: 2 };
      issues.sort((a, b) => order[a.level] - order[b.level]);
      return { summary, files, issues, checks, typeCoverage: byType, monthKeys, recordCounts: M.recordCounts, geidCoverage: M.geidCoverage, excludedStores: M.excluded };
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
