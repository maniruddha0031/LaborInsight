/* views-explore.js — Schedule vs actual, Overtime, Punch integrity, Compliance, Sales, Stores, Employees, Trends. */
(function (G) {
  const F = G.FMT, UI = G.UI, esc = F.esc;
  const VIEWS = (G.VIEWS = G.VIEWS || {});
  const sn = (R, s) => (R.meta.storeNames && R.meta.storeNames[s]) || s;
  const empMap = (R) => R._emp || (R._emp = Object.fromEntries(R.employees.map((e) => [e.g, e])));
  const pctOf = (a, b) => (b ? a / b : NaN);
  const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const DOWN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ===================== SCHEDULE VS ACTUAL =====================
  VIEWS.adherence = function (el, R) {
    const t = R.adherence.tot, Fi = R.financials;
    const shifts = Object.entries(R.adherence.byShift).filter(([k]) => k !== 'Unscheduled');
    const topOver = R.stores.slice().sort((a, b) => b.overPlanPct - a.overPlanPct).slice(0, 20);
    el.innerHTML = `${UI.section('Schedule vs actual', `Every punch is matched to the employee's scheduled shift by GEID and business date. Additional time is split into non-overlapping parts, so their costs can be added; time not worked (late arrivals, early leaves, no-shows) is shown alongside so the net change reconciles.`)}
      <div class="stack">
        <div class="kpis k5">
          ${UI.kpi({ label: 'Scheduled paid hours', value: F.hrsK(t.sch / 60), sub: 'Shift time minus planned unpaid meals' })}
          ${UI.kpi({ label: 'Actual paid hours', value: F.hrsK(t.act / 60), sub: F.pctSigned(t.act / t.sch - 1) + ' vs schedule' })}
          ${UI.kpi({ label: 'Labor above plan', value: F.money(t.cOverPlan), sub: `${F.hrsK(t.overPlan / 60)} · store-day net`, cls: 'warn', title: 'Each store-day: max(0, paid − scheduled) × that day\'s average pay rate' })}
          ${UI.kpi({ label: 'Scheduled, not worked', value: F.hrsK((t.noShow + t.lateIn + t.earlyOut) / 60), sub: `No-shows ${F.hrsK(t.noShow / 60)} · coverage risk` })}
          ${UI.kpi({ label: 'Additional pay beyond schedule', value: F.money(t.cEarly + t.cLate + t.cUnsch + t.cMealSkip), sub: `early ${F.moneyK(t.cEarly)} · late ${F.moneyK(t.cLate)} · unscheduled ${F.moneyK(t.cUnsch)} · meals ${F.moneyK(t.cMealSkip)}`, cls: 'bad', title: 'Non-overlapping, at each employee\'s own rate (OT premium is in Overtime)' })}
        </div>
        <div class="grid2">
          <div class="panel"><h3>What changed paid time vs schedule</h3>
            ${UI.bars([
              { label: 'Unscheduled shifts', value: t.unsch / 60, display: F.hrsK(t.unsch / 60), sub2: F.moneyK(t.cUnsch), color: '--c-unsch' },
              { label: 'Late clock-outs', value: t.late / 60, display: F.hrsK(t.late / 60), sub2: F.moneyK(t.cLate), color: '--c-late' },
              { label: 'Early clock-ins', value: t.early / 60, display: F.hrsK(t.early / 60), sub2: F.moneyK(t.cEarly), color: '--c-early' },
              { label: 'Skipped planned meals', value: t.mealSkip / 60, display: F.hrsK(t.mealSkip / 60), sub2: F.moneyK(t.cMealSkip), color: '--c-meal' },
              { label: 'No-shows (offset)', value: t.noShow / 60, display: '−' + F.hrsK(t.noShow / 60), color: '--c-neutral' },
              { label: 'Early clock-outs (offset)', value: t.earlyOut / 60, display: '−' + F.hrsK(t.earlyOut / 60), color: '--c-neutral' },
              { label: 'Late clock-ins (offset)', value: t.lateIn / 60, display: '−' + F.hrsK(t.lateIn / 60), color: '--c-neutral' },
              { label: 'Longer breaks (offset)', value: t.extraBrk / 60, display: '−' + F.hrsK(t.extraBrk / 60), color: '--c-neutral' },
            ])}
            <p class="note" style="margin:10px 0 0">Reconciliation: actual − scheduled = ${F.hrs(R.adherence.recon.delta / 60)}; the parts above net to ${F.hrs(R.adherence.recon.explained / 60)} (residual ${F.hrs(R.adherence.recon.residual / 60)} = mid-shift gaps). Gross additional ${F.hrsK(Fi.grossAddMin / 60)} vs ${F.hrsK(t.overPlan / 60)} above plan after store-day netting.</p>
          </div>
          <div class="panel"><h3>Early and late punches by shift type</h3>
            ${UI.legend([{ label: 'Early clock-in', color: '--c-early' }, { label: 'Late clock-out', color: '--c-late' }])}
            <div class="chartbox"><canvas id="adShift"></canvas></div>
            <p class="note" style="margin:6px 0 0">Shift type from the scheduled start: opening before 10:00, closing 16:00 or later.</p>
          </div>
        </div>
        <div class="grid2">
          <div class="panel"><h3>By weekday (per 100 paid hours)</h3>
            ${UI.legend([{ label: 'Unscheduled', color: '--c-unsch' }, { label: 'Late clock-out', color: '--c-late' }, { label: 'Early clock-in', color: '--c-early' }])}
            <div class="chartbox sm"><canvas id="adDow"></canvas></div></div>
          <div class="panel"><h3>% over plan by month — 20 highest stores</h3><div id="adHeat" style="overflow-x:auto"></div></div>
        </div>
        <div class="panel"><h3>Stores</h3><div id="adTbl"></div></div>
      </div>`;
    UI.chart(UI.$('#adShift', el), { labels: shifts.map(([k]) => k.replace(/ \(.*/, '')), series: [
      { label: 'Early clock-in', data: shifts.map(([, a]) => a.early / 60), color: '--c-early' },
      { label: 'Late clock-out', data: shifts.map(([, a]) => a.late / 60), color: '--c-late' }], fmtY: F.hrsK });
    const dw = DOW_ORDER.map((d) => R.adherence.byDow[d] || {});
    const per = (a, k) => (a.act ? (a[k] / a.act) * 100 : 0);
    UI.chart(UI.$('#adDow', el), { labels: DOW_ORDER.map((d) => DOWN[d]), series: [
      { label: 'Unscheduled', data: dw.map((a) => per(a, 'unsch')), color: '--c-unsch' },
      { label: 'Late clock-out', data: dw.map((a) => per(a, 'late')), color: '--c-late' },
      { label: 'Early clock-in', data: dw.map((a) => per(a, 'early')), color: '--c-early' }], fmtY: (v) => F.n1(v) + ' h' });
    const months = R.meta.months;
    const sm = R.adherence.storeMonth;
    UI.$('#adHeat', el).innerHTML = UI.heatmap(topOver.map((s) => s.name), months.map((m) => F.monthShort(m.key)), (i, j) => {
      const x = sm[topOver[i].s + '|' + months[j].key]; return x && x.sch ? x.overPlan / x.sch : NaN;
    }, (v) => F.pct(v, 0));
    UI.table(UI.$('#adTbl', el), { rows: R.stores, sortKey: 'overPlanCost', placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }), cols: [
      { key: 'name', label: 'Store' }, { key: 'schHrs', label: 'Scheduled', num: true, fmt: F.hrs }, { key: 'paidHrs', label: 'Paid', num: true, fmt: F.hrs },
      { key: 'varPct', label: 'Paid vs sched', num: true, fmt: (v) => F.pctSigned(v) }, { key: 'overPlanPct', label: '% above plan', num: true, fmt: (v) => F.pct(v), bar: '--c-neutral' },
      { key: 'early', label: 'Early in', num: true, fmt: F.hrsFromMin }, { key: 'late', label: 'Late out', num: true, fmt: F.hrsFromMin },
      { key: 'unsch', label: 'Unscheduled', num: true, fmt: F.hrsFromMin }, { key: 'mealSkip', label: 'Skipped meal', num: true, fmt: F.hrsFromMin },
      { key: 'noShow', label: 'No-show', num: true, fmt: F.hrsFromMin }, { key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money }] });
  };

  // ===================== OVERTIME =====================
  VIEWS.overtime = function (el, R) {
    const o = R.overtime, t = o.tot, E = empMap(R);
    const ms = R.meta.months;
    el.innerHTML = `${UI.section('Overtime', `OT hours and pay come from the payroll export. Weekly threshold inferred from the data: <b>${o.threshold / 60} h</b> (${F.pct(o.consistency, 1)} of OT weeks match). Only the premium above base pay is costed, so OT never double-counts paid hours.`)}
      <div class="stack">
        <div class="kpis k5">
          ${UI.kpi({ label: 'OT premium paid', value: F.money(t.prem), sub: 'OT pay − OT hours × base rate', cls: 'warn' })}
          ${UI.kpi({ label: 'Overtime hours', value: F.hrsK((t.ot + t.dt) / 60), sub: `${F.n(t.otWeeks)} employee-weeks with OT` })}
          ${UI.kpi({ label: 'Built into the schedule', value: F.pct(t.schedOt / Math.max(1, t.ot + t.dt), 0), sub: `${F.moneyK(t.premSched)} premium · schedule > ${o.threshold / 60} h` })}
          ${UI.kpi({ label: 'From working past schedule', value: F.pct(t.driftOt / Math.max(1, t.ot + t.dt), 0), sub: `${F.moneyK(t.premDrift)} premium · counted avoidable` })}
          ${UI.kpi({ label: 'Recurring OT employees', value: F.n(R.employees.filter((e) => e.recurringOt).length), sub: `OT in ${R.rules.recurringWeeks.value}+ weeks` })}
        </div>
        <div class="grid2">
          <div class="panel"><h3>OT premium by month</h3>${UI.legend([{ label: 'Scheduled OT', color: '--c-ot' }, { label: 'Drift OT', color: '--c-late' }])}<div class="chartbox"><canvas id="otM"></canvas></div>
            <p class="note" style="margin:6px 0 0">${o.truncatedLastWeek ? 'The last week is cut off by the period end; its OT may be understated. ' : ''}A week is assigned to the month containing its Thursday.</p></div>
          <div class="panel"><h3>Context</h3><ul class="vlist">
            <li class="info">${F.n(o.multiStore.weeks)} OT weeks involved more than one store (${F.money(o.multiStore.prem)} premium) — no single store manager sees the full week.</li>
            <li class="info">${F.n(t.over40NoOt)} employee-weeks went over ${o.threshold / 60} h with no OT paid — mostly ${esc(Object.entries(o.noOtByJob).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([j, n]) => `${j} (${F.n(n)})`).join(', '))}. Consistent with OT-exempt roles; not counted as leakage.</li>
            <li class="info">Scheduled OT = the part of OT that the published schedule already exceeded ${o.threshold / 60} h; drift OT = the rest.</li></ul></div>
        </div>
        <div class="panel"><h3>Highest-premium employee-weeks</h3><div id="otW"></div></div>
        <div class="panel"><h3>Employees</h3><div id="otE"></div></div>
      </div>`;
    UI.chart(UI.$('#otM', el), { stacked: true, labels: ms.map((m) => F.monthShort(m.key)), series: [
      { label: 'Scheduled OT', data: ms.map((m) => (o.byMonth[m.key] || {}).premSched || 0), color: '--c-ot', stack: 'a' },
      { label: 'Drift OT', data: ms.map((m) => (o.byMonth[m.key] || {}).premDrift || 0), color: '--c-late', stack: 'a' }], fmtY: F.moneyK });
    UI.table(UI.$('#otW', el), { rows: o.topWeeks, sortKey: 'prem', pageSize: 15, placeholder: 'Search GEID or store', onRow: (r) => G.App.go('employees', { g: r.g }), cols: [
      { key: 'g', label: 'Employee', text: (r) => (E[r.g] || {}).name + ' ' + r.g, fmt: (v) => `${esc((E[v] || {}).name || '')}<span class="sub">GEID ${esc(v)}</span>` },
      { key: 'store', label: 'Store', fmt: (v) => esc(sn(R, v)) }, { key: 'week', label: 'Week of' },
      { key: 'sched', label: 'Scheduled', num: true, fmt: F.hrsFromMin }, { key: 'paid', label: 'Paid', num: true, fmt: F.hrsFromMin },
      { key: 'ot', label: 'OT', num: true, fmt: F.hrsFromMin }, { key: 'schedOt', label: 'of which scheduled', num: true, fmt: F.hrsFromMin },
      { key: 'prem', label: 'Premium', num: true, fmt: F.money, bar: '--c-ot' }, { key: 'multi', label: 'Multi-store', fmt: (v) => (v ? 'Yes' : '') }] });
    UI.table(UI.$('#otE', el), { rows: R.employees.filter((e) => e.otHrs > 0), sortKey: 'otPrem', pageSize: 20, placeholder: 'Search name or GEID', onRow: (r) => G.App.go('employees', { g: r.g }), cols: G.LCIViews.empCols('otPrem') });
  };

  // ===================== PUNCH INTEGRITY =====================
  VIEWS.integrity = function (el, R) {
    const I = R.integrity, t = I.tot, ms = R.meta.months;
    const manSrc = R.adherence.bySource.MANUAL || { min: 0, n: 0, qIn: 0 };
    const pinKey = Object.keys(I.methods).find((k) => /PASS|PIN/.test(k)) || 'PASSWORD';
    const ap = I.approvals;
    el.innerHTML = `${UI.section('Punch integrity', 'How time gets into payroll: captured by the clock, keyed in by a manager, or edited afterwards — and by whom. Patterns here are review signals; none of them proves intent.')}
      <div class="stack">
        <div class="kpis k5">
          ${UI.kpi({ label: 'Paid hours keyed in manually', value: F.pct(manSrc.min / Math.max(1, R.adherence.tot.act)), sub: `${F.hrsK(manSrc.min / 60)} on ${F.n(manSrc.n)} punches`, cls: 'bad' })}
          ${UI.kpi({ label: 'Manual entries made late', value: I.hasAudit && I.manual.withLag ? F.pct(I.manual.retro / I.manual.withLag, 0) : '—', sub: `More than ${R.rules.retroLag.value} min after the punch time` })}
          ${UI.kpi({ label: 'Net paid time added by edits', value: F.money(R.financials.edits ? R.financials.edits.netCost : t.addCost), sub: `${F.pct(t.edited / Math.max(1, t.punches))} of punches edited · +${F.hrsK(t.addMin / 60)} / −${F.hrsK(t.remMin / 60)}`, title: 'Time added by edits minus time removed, excluding corrections of forgotten clock-outs, at the punch rate' })}
          ${UI.kpi({ label: 'Biometric punch share', value: F.pct(I.biometric.share, 3), sub: `${F.n(I.biometric.events)} of ${F.n(I.biometric.total)} events`, cls: I.biometric.comparable ? '' : 'warn' })}
          ${UI.kpi({ label: 'Edits via shared logins', value: I.hasApproval ? F.pct(ap.viaStoreAccount / Math.max(1, ap.viaStoreAccount + ap.viaNamedUser), 0) : '—', sub: `${F.n(ap.selfEdits)} probable self-edits` })}
        </div>
        <div class="grid2">
          <div class="panel"><h3>How punches were captured, by month</h3>${UI.legend([{ label: 'PIN / password', color: '--c-early' }, { label: 'Manual entry', color: '--c-unsch' }, { label: 'Biometric', color: '--c-meal' }])}<div class="chartbox"><canvas id="inM"></canvas></div>
            <p class="note" style="margin:6px 0 0">Share of clock-in/out events in the audit log.${I.biometric.comparable ? '' : ' Biometric volume is too small for a biometric vs non-biometric comparison; none is claimed.'}</p></div>
          <div class="panel"><h3>When manual punches were keyed in</h3>${I.hasAudit ? UI.bars(I.manual.lagDist.map((d, i) => ({ label: d.label, value: d.n, display: F.n(d.n), sub2: F.pct(d.n / Math.max(1, I.manual.withLag), 0), color: i < 1 ? '--c-meal' : '--c-unsch' }))) : '<div class="empty">No punch audit log in this dataset.</div>'}
            <p class="note" style="margin:10px 0 0">Delay between the time a manual punch records and when it was entered. Median ${F.n1(I.manual.medianLag / 60)} h.</p></div>
        </div>
        <div class="grid2">
          <div class="panel"><h3>What edits did to paid time</h3>${UI.bars([
            { label: 'Time added by edits', value: t.addMin / 60, display: F.hrsK(t.addMin / 60), sub2: F.moneyK(t.addCost), color: '--c-late' },
            { label: 'Removed: forgotten clock-outs', value: t.forgotMin / 60, display: F.hrsK(t.forgotMin / 60), sub2: F.n(t.forgotOut) + ' punches', color: '--c-neutral' },
            { label: 'Removed: other edits', value: (t.remMin - t.forgotMin) / 60, display: F.hrsK((t.remMin - t.forgotMin) / 60), color: '--c-neutral' },
            { label: 'Snapped to scheduled time', value: t.snapMin / 60, display: F.hrsK(t.snapMin / 60), sub2: F.n(t.snap) + ' edits', color: '--c-unsch' }])}
          </div>
          <div class="panel"><h3>Times landing on :00 / :15 / :30 / :45</h3>${UI.bars([
            { label: 'Expected by chance', value: I.quarter.naturalShare, display: F.pct(I.quarter.naturalShare, 0), color: '--c-neutral' },
            { label: 'Device-captured punches', value: I.quarter.origShare || 0, display: F.pct(I.quarter.origShare, 0), color: '--c-early' },
            { label: 'Manually keyed clock-ins', value: manSrc.n ? manSrc.qIn / manSrc.n : 0, display: F.pct(manSrc.n ? manSrc.qIn / manSrc.n : NaN, 0), color: '--c-unsch' },
            { label: 'Edited punch times', value: I.quarter.editedShare || 0, display: F.pct(I.quarter.editedShare, 0), color: '--c-late' }], { max: 1 })}
            <p class="note" style="margin:10px 0 0">Round times are estimates: someone typed a time rather than the clock recording it.</p></div>
        </div>
        ${I.spikes.length ? `<div class="panel"><h3>Days with abnormal edit volume</h3><p class="note">Typical day: ${F.n(I.editMedianPerDay)} edits. ${I.spikes.map((s) => `<b>${esc(s.day)}</b>: ${F.n(s.n)}`).join(' · ')}</p></div>` : ''}
        <div class="panel"><h3>Who edits punches</h3><p class="note" style="margin-top:-4px">From the punch-change report. Editors carry no GEID, so "own punches" is a name match and needs confirmation.</p><div id="inEd"></div></div>
        <div class="panel"><h3>Stores</h3><div id="inSt"></div></div>
      </div>`;
    const mm = ms.map((m) => I.methodByMonth[m.key] || {});
    const share = (x, f) => { const tot = Object.values(x).reduce((s, v) => s + v, 0); return tot ? Object.keys(x).filter(f).reduce((s, k) => s + x[k], 0) / tot * 100 : 0; };
    UI.chart(UI.$('#inM', el), { stacked: true, labels: ms.map((m) => F.monthShort(m.key)), series: [
      { label: 'PIN / password', data: mm.map((x) => share(x, (k) => /PASS|PIN/.test(k))), color: '--c-early', stack: 'a' },
      { label: 'Manual entry', data: mm.map((x) => share(x, (k) => k === 'MANUAL')), color: '--c-unsch', stack: 'a' },
      { label: 'Biometric', data: mm.map((x) => share(x, (k) => /BIO|FACE|FINGER/.test(k))), color: '--c-meal', stack: 'a' }], fmtY: (v) => F.n1(v) + '%', suggestedMax: 100 });
    UI.table(UI.$('#inEd', el), { rows: I.editors.filter((e) => e.kind !== 'system'), sortKey: 'rows', pageSize: 15, placeholder: 'Search editors', cols: G.LCIViews.editorCols() });
    UI.table(UI.$('#inSt', el), { rows: R.stores, sortKey: 'manualPct', placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }), cols: [
      { key: 'name', label: 'Store' }, { key: 'manualPct', label: 'Manual punch share', num: true, fmt: (v) => F.pct(v), bar: '--c-unsch' }, { key: 'retro', label: 'Late manual entries', num: true, fmt: F.n },
      { key: 'editPct', label: 'Punches edited', num: true, fmt: (v) => F.pct(v) }, { key: 'editAddMin', label: 'Time added by edits', num: true, fmt: F.hrsFromMin }, { key: 'editAddCost', label: 'Edit $ added', num: true, fmt: F.money },
      { key: 'longPunches', label: '≥14h punches', num: true, fmt: F.n }] });
  };

  // ===================== COMPLIANCE =====================
  VIEWS.compliance = function (el, R) {
    const C = R.compliance, b = C.breaks, mn = C.minors, ex = C.exceptions;
    el.innerHTML = `${UI.section('Breaks & compliance', 'Compliance exposure is reported as counts and hours. A missed or short break is not assumed to cost money unless premium pay was recorded. Thresholds marked "analysis" in Method & rules need confirming against the state rules that apply.')}
      <div class="stack">
        <div class="kpis">
          ${UI.kpi({ label: `${R.rules.mealRequiredAfter.value / 60}h+ shifts with no meal break`, value: F.pct(b.missed / Math.max(1, b.eligibleDays), 0), sub: `${F.n(b.missed)} of ${F.n(b.eligibleDays)} · ${F.n(b.missedEmployees)} employees`, cls: 'bad' })}
          ${UI.kpi({ label: `Meals under ${R.rules.minMealLength.value} min`, value: F.n(b.short), sub: `of ${F.n(b.total - b.rest)} recorded meal breaks` })}
          ${UI.kpi({ label: 'Minors not flagged as minor', value: F.n(mn.flagMismatchEmployees), sub: `${F.n(mn.flagNo)} punches · age < ${R.rules.minorAge.value}`, cls: mn.flagNo ? 'bad' : '' })}
          ${UI.kpi({ label: 'Minor punches ending late', value: F.n(mn.lateNight), sub: `after ${R.rules.minorLateHour.value / 60}:00 · ${F.n(mn.lateNightEmployees)} employees` })}
        </div>
        <div class="grid2">
          <div class="panel"><h3>Breaches flagged by the clock</h3>
            <table><thead><tr><th>Type</th><th class="num">Count</th></tr></thead><tbody>${Object.entries(ex.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, ' ').toLowerCase())}</td><td class="num">${F.n(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">None</td></tr>'}</tbody></table>
            <p class="note" style="margin:10px 0 0">${ex.breakTypesFlagged.length ? '' : 'No break violations are flagged for production stores although most long shifts have no recorded meal — break rules appear not to be enforced on the clock. '}Punches approved by a manager: ${F.pct(ex.authPunches / Math.max(1, ex.punches), 0)}. Premium pay recorded: ${F.money(C.premium.amount)} (${F.n(C.premium.rows)} rows).</p></div>
          <div class="panel"><h3>Meal breaks by month</h3>${UI.legend([{ label: '% of long shifts with no meal recorded', color: '--c-meal' }])}<div class="chartbox sm"><canvas id="cmM"></canvas></div></div>
        </div>
        <div class="panel"><h3>Stores</h3><div id="cmS"></div></div>
        <div class="panel"><h3>Employees with repeated missed meals</h3><div id="cmE"></div></div>
      </div>`;
    const ms = R.meta.months;
    UI.chart(UI.$('#cmM', el), { type: 'line', labels: ms.map((m) => F.monthShort(m.key)), series: [{ label: 'No meal recorded', data: ms.map((m) => { const x = b.byMonth[m.key]; return x && x.eligible ? x.missed / x.eligible * 100 : null; }), color: '--c-meal', type: 'line' }], fmtY: (v) => F.n(v) + '%', beginAtZero: true, suggestedMax: 100 });
    UI.table(UI.$('#cmS', el), { rows: R.stores, sortKey: 'missedMealPct', placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }), cols: [
      { key: 'name', label: 'Store' }, { key: 'missedMealPct', label: '6h+ shifts without meal', num: true, fmt: (v) => F.pct(v, 0), bar: '--c-meal' }, { key: 'shortMeals', label: 'Short meals', num: true, fmt: F.n },
      { key: 'mealSkip', label: 'Planned meal worked', num: true, fmt: F.hrsFromMin }, { key: 'minorPunches', label: 'Minor punches', num: true, fmt: F.n }, { key: 'minorLate', label: 'Minor late-night', num: true, fmt: F.n }] });
    UI.table(UI.$('#cmE', el), { rows: R.employees.filter((e) => e.missedMeals > 0), sortKey: 'missedMeals', pageSize: 15, placeholder: 'Search name or GEID', onRow: (r) => G.App.go('employees', { g: r.g }), cols: [
      { key: 'name', label: 'Employee', fmt: (v, r) => `${esc(v)}<span class="sub">GEID ${esc(r.g)}</span>` }, { key: 'storeName', label: 'Store' }, { key: 'age', label: 'Age', num: true, fmt: F.n },
      { key: 'missedMeals', label: 'Long shifts, no meal', num: true, fmt: F.n, bar: '--c-meal' }, { key: 'shortMeals', label: 'Short meals', num: true, fmt: F.n }, { key: 'mealSkip', label: 'Planned meal worked', num: true, fmt: F.hrsFromMin }] });
  };

  // ===================== SALES & LABOR (MONTHLY) =====================
  VIEWS.sales = function (el, R) {
    const S = R.sales;
    if (!S.available) { el.innerHTML = UI.section('Sales & labor') + `<div class="empty panel">${esc(S.reason || 'No sales data.')}</div>`; return; }
    const t = S.tot, bm = S.byMonth;
    el.innerHTML = `${UI.section('Sales & labor efficiency', '<b>Monthly granularity only.</b> Forecast and actual sales are aggregated to store × month; no daily or hourly sales figures are derived, and monthly relationships are not read as hourly ones. SPLH and labor % use paid hours and pay from the punch export.')}
      <div class="stack">
        <div class="kpis k5">
          ${UI.kpi({ label: 'Actual sales', value: F.moneyK(t.as), sub: `Forecast ${F.moneyK(t.fs)}` })}
          ${UI.kpi({ label: 'Sales achievement', value: F.pct(t.ach), sub: 'Actual ÷ forecast' })}
          ${UI.kpi({ label: 'SPLH (actual)', value: F.n1(t.splh), sub: `Scheduled SPLH ${F.n1(t.schedSplh)} (forecast ÷ scheduled hours)` })}
          ${UI.kpi({ label: 'Labor % of sales', value: F.pct(t.laborPct), sub: 'Punch pay ÷ actual sales' })}
          ${UI.kpi({ label: 'Hours: sales file vs punches', value: F.pct(S.recon.ratio), sub: 'Reconciliation of the two sources' })}
        </div>
        <div class="grid2">
          <div class="panel"><h3>Forecast vs actual sales by month</h3>${UI.legend([{ label: 'Actual sales', color: '--c-early' }, { label: 'Forecast sales', color: '--c-neutral' }])}<div class="chartbox"><canvas id="slM"></canvas></div></div>
          <div class="panel"><h3>SPLH by month</h3>${UI.legend([{ label: 'Actual SPLH', color: '--c-early' }, { label: 'Scheduled SPLH', color: '--c-neutral' }])}<div class="chartbox"><canvas id="slS"></canvas></div></div>
        </div>
        <div class="grid2">
          <div class="panel"><h3>Labor % of sales by month</h3><div class="chartbox sm"><canvas id="slL"></canvas></div></div>
          <div class="panel"><h3>Paid hours vs sales, month over month</h3><p class="note">Months where actual sales fell more than 3% while paid hours rose. Peer SPLH medians by volume band: ${Object.entries(S.tierMed).map(([k, v]) => `${esc(k)} ${F.n1(v)}`).join(' · ')}.</p><div id="slNF"></div></div>
        </div>
        <div class="panel"><h3>Stores</h3><div id="slT"></div></div>
      </div>`;
    const lab = bm.map((m) => F.monthShort(m.month));
    UI.chart(UI.$('#slM', el), { type: 'line', labels: lab, series: [{ label: 'Actual sales', data: bm.map((m) => m.as), color: '--c-early', type: 'line' }, { label: 'Forecast sales', data: bm.map((m) => m.fs), color: '--c-neutral', type: 'line', dash: [5, 4] }], fmtY: F.moneyK, beginAtZero: false });
    UI.chart(UI.$('#slS', el), { type: 'line', labels: lab, series: [{ label: 'Actual SPLH', data: bm.map((m) => m.splh), color: '--c-early', type: 'line' }, { label: 'Scheduled SPLH', data: bm.map((m) => m.schedSplh), color: '--c-neutral', type: 'line', dash: [5, 4] }], fmtY: F.n1, beginAtZero: false });
    UI.chart(UI.$('#slL', el), { type: 'line', labels: lab, series: [{ label: 'Labor %', data: bm.map((m) => m.laborPct * 100), color: '--c-late', type: 'line' }], fmtY: (v) => F.n1(v) + '%', beginAtZero: false });
    const nf = [];
    for (const p of S.perStore) for (const x of p.nonFlex) nf.push(Object.assign({ s: p.s, name: sn(R, p.s) }, x));
    UI.table(UI.$('#slNF', el), { rows: nf, sortKey: 'excessHrs', pageSize: 8, placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }), cols: [
      { key: 'name', label: 'Store' }, { key: 'month', label: 'Month', fmt: (v) => F.monthLabel(v) }, { key: 'salesChg', label: 'Sales', num: true, fmt: (v) => F.pctSigned(v) },
      { key: 'hoursChg', label: 'Paid hours', num: true, fmt: (v) => F.pctSigned(v) }, { key: 'excessHrs', label: 'Hours vs prior SPLH', num: true, fmt: F.hrs }] });
    UI.table(UI.$('#slT', el), { rows: S.perStore.map((x) => Object.assign({ name: sn(R, x.s) }, x)), sortKey: 'peerGapHrs', placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }), cols: [
      { key: 'name', label: 'Store' }, { key: 'tier', label: 'Volume band' }, { key: 'as', label: 'Actual sales', num: true, fmt: F.moneyK }, { key: 'ach', label: 'Achievement', num: true, fmt: (v) => F.pct(v) },
      { key: 'fcstBias', label: 'Forecast bias', num: true, fmt: (v) => F.pctSigned(v) }, { key: 'splh', label: 'SPLH', num: true, fmt: F.n1 }, { key: 'peerSplh', label: 'Peer SPLH', num: true, fmt: F.n1 },
      { key: 'peerGapHrs', label: 'Hours vs peer', num: true, fmt: F.hrs, bar: '--c-neutral' }, { key: 'laborPct', label: 'Labor %', num: true, fmt: (v) => F.pct(v) },
      { key: 'corrSalesHours', label: 'Hours follow sales (r)', num: true, fmt: (v) => (F.ok(v) ? v.toFixed(2) : '—'), title: 'Correlation of monthly paid hours with monthly sales; low or negative = labor does not flex with demand' }] });
  };

  // ===================== STORES =====================
  VIEWS.stores = function (el, R, params) {
    if (params && params.s) return storeDetail(el, R, params.s);
    if (R.stores.length === 1) return storeDetail(el, R, R.stores[0].s); // store view: go straight to it
    const persistent = new Set(R.trends.persistent.map((x) => x.s));
    const lr = R.sales.available && R.sales.laborRank ? Object.fromEntries(R.sales.laborRank.rows.map((x) => [x.s, x.laborPct])) : {};
    const METRICS = [
      { k: 'grossAdd', label: 'Estimated additional labor cost', fmt: F.money }, { k: 'avoid', label: 'Estimated avoidable labor cost', fmt: F.money },
      { k: 'otPrem', label: 'Overtime cost (premium)', fmt: F.money }, { k: 'manExtraCost', label: 'Manual punch-related cost', fmt: F.money },
      { k: 'cEarly', label: 'Early clock-in cost', fmt: F.money }, { k: 'cLate', label: 'Late clock-out cost', fmt: F.money },
      { k: 'labor', label: 'Labor cost', fmt: F.money }, { k: 'lp', label: 'Labor % (complete months)', fmt: (v) => F.pct(v), val: (r) => lr[r.s] },
    ];
    const cur = { k: (params && params.rank) || 'grossAdd' };
    el.innerHTML = `${UI.section('Stores', 'Rank stores by the money involved. A high Labor % store is not necessarily the one leaking the most dollars — switch the ranking to compare. Click a store for its detail.')}
      <div class="stack"><div class="panel"><div class="controls"><label>Rank by <select id="stRank">${METRICS.map((m) => `<option value="${m.k}">${esc(m.label)}</option>`).join('')}</select></label><span class="note" id="stRankNote"></span></div><div id="stBars"></div></div>
      <div class="panel"><div id="stT"></div></div></div>`;
    const drawRank = () => {
      const m = METRICS.find((x) => x.k === cur.k);
      const v = (r) => (m.val ? m.val(r) : r[m.k]);
      const rows = R.stores.filter((r) => F.ok(v(r))).sort((a, b) => v(b) - v(a)).slice(0, 12);
      const total = R.stores.reduce((x, r) => x + (F.ok(v(r)) && m.k !== 'lp' ? v(r) : 0), 0);
      UI.$('#stRankNote', el).innerHTML = m.k === 'lp' ? `Actual Labor %, ${R.sales.available ? 'complete months only' : 'not available for this range'}` : `Total ${F.money(total)} · top 12 shown, highest first`;
      UI.$('#stBars', el).innerHTML = rows.length ? UI.bars(rows.map((r, i) => ({ label: `${i + 1}. Store ${r.name}`, sub: m.k === 'lp' ? `${F.moneyK(r.labor)} labor` : `${F.pct(v(r) / Math.max(1e-9, total), 1)} of total · Labor % ${F.ok(lr[r.s]) ? F.pct(lr[r.s]) : '—'}`, value: v(r), display: m.fmt(v(r)), color: '--c-late' }))) : '<div class="empty">Not available for this selection.</div>';
      UI.$$('#stBars .brow', el).forEach((b, i) => { b.style.cursor = 'pointer'; b.addEventListener('click', () => G.App.go('stores', { s: rows[i].s })); });
    };
    UI.$('#stRank', el).value = cur.k;
    UI.$('#stRank', el).addEventListener('change', (e) => { cur.k = e.target.value; drawRank(); });
    drawRank();
    UI.table(UI.$('#stT', el), { rows: R.stores, sortKey: 'grossAdd', tall: true, pageSize: 60, placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }), cols: [
      { key: 'name', label: 'Store', fmt: (v, r) => esc(v) + (persistent.has(r.s) ? ' <span class="tag risk">persistent</span>' : '') },
      { key: 'grossAdd', label: 'Additional cost', num: true, fmt: F.money, title: 'Non-overlapping additional labor cost: early + late + unscheduled + skipped meals + OT premium' },
      { key: 'emps', label: 'Employees', num: true, fmt: F.n }, { key: 'paidHrs', label: 'Paid hours', num: true, fmt: F.hrs }, { key: 'labor', label: 'Labor $', num: true, fmt: F.moneyK },
      { key: 'overPlanPct', label: '% above plan', num: true, fmt: (v) => F.pct(v) }, { key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money, bar: '--c-late' },
      { key: 'avoidPerHr', label: 'Avoidable $/paid h', num: true, fmt: (v) => '$' + v.toFixed(2) }, { key: 'otPrem', label: 'OT premium', num: true, fmt: F.money },
      { key: 'manualPct', label: 'Manual punches', num: true, fmt: (v) => F.pct(v) }, { key: 'missedMealPct', label: 'No meal (6h+)', num: true, fmt: (v) => F.pct(v, 0) },
      { key: 'splh', label: 'SPLH', num: true, fmt: F.n1 }, { key: 'laborPct', label: 'Labor %', num: true, fmt: (v) => F.pct(v) }] });
  };

  async function storeDetail(el, R, s) {
    el.innerHTML = '<div class="note">Loading store…</div>';
    const d = await G.App.query({ type: 'store', s });
    if (!d || !d.row) { el.innerHTML = '<div class="msg err">Store not found in this dataset.</div>'; return; }
    const r = d.row, ms = d.months;
    const pers = R.trends.persistent.find((x) => x.s === s);
    el.innerHTML = `<div class="crumb"><button data-go="stores">Stores</button><span class="sep">›</span><span class="cur">${esc(r.name)}</span></div>
      <h2>Store ${esc(r.name)}</h2><p class="lead">${F.n(r.emps)} employees (by primary store) · ${F.hrs(r.paidHrs)} paid · ${F.money(r.labor)} labor${pers ? ` · <span class="tag risk">top quartile for over-plan cost in ${pers.months} of ${R.meta.months.length} months</span>` : ''}</p>
      <div class="stack">
        <div class="kpis k5">
          ${UI.kpi({ label: 'Paid vs scheduled', value: F.pctSigned(r.varPct), sub: `${F.hrs(r.paidHrs)} vs ${F.hrs(r.schHrs)}` })}
          ${UI.kpi({ label: 'Labor above plan', value: F.money(r.overPlanCost), sub: `${F.hrs(r.overPlanHrs)} · ${F.pct(r.overPlanPct)} of schedule`, cls: 'warn' })}
          ${UI.kpi({ label: 'Estimated avoidable', value: F.money(r.avoid), sub: `$${r.avoidPerHr.toFixed(2)} per paid hour`, cls: 'bad' })}
          ${UI.kpi({ label: 'OT premium', value: F.money(r.otPrem), sub: `${F.hrs(r.otHrs)} OT` })}
          ${UI.kpi({ label: 'Manual punch share', value: F.pct(r.manualPct), sub: `${F.pct(r.editPct)} of punches edited` })}
        </div>
        <div class="grid2">
          <div class="panel"><h3>Paid vs scheduled hours by month</h3>${UI.legend([{ label: 'Paid', color: '--c-early' }, { label: 'Scheduled', color: '--c-neutral' }])}<div class="chartbox"><canvas id="sdH"></canvas></div></div>
          <div class="panel"><h3>Where the extra time came from, by month</h3>${UI.legend([{ label: 'Unscheduled', color: '--c-unsch' }, { label: 'Late out', color: '--c-late' }, { label: 'Early in', color: '--c-early' }, { label: 'Planned meal worked', color: '--c-meal' }])}<div class="chartbox"><canvas id="sdX"></canvas></div></div>
        </div>
        <div class="grid2">
          <div class="panel"><h3>Monthly detail</h3><div id="sdM"></div></div>
          <div class="panel"><h3>By weekday</h3><div id="sdD"></div></div>
        </div>
        <div class="panel"><h3>Employees at this store — by additional labor cost</h3><div id="sdE"></div></div>
        ${d.editors.length ? '<div class="panel"><h3>Editors whose edits are mostly at this store</h3><div id="sdEd"></div></div>' : ''}
      </div>`;
    UI.$('[data-go]', el).addEventListener('click', () => G.App.go('stores'));
    const lab = ms.map((m) => F.monthShort(m.month));
    UI.chart(UI.$('#sdH', el), { type: 'line', labels: lab, series: [{ label: 'Paid', data: ms.map((m) => m.act / 60), color: '--c-early', type: 'line' }, { label: 'Scheduled', data: ms.map((m) => m.sch / 60), color: '--c-neutral', type: 'line', dash: [5, 4] }], fmtY: F.hrsK, beginAtZero: false });
    UI.chart(UI.$('#sdX', el), { stacked: true, labels: lab, series: [
      { label: 'Unscheduled', data: ms.map((m) => m.unsch / 60), color: '--c-unsch', stack: 'a' }, { label: 'Late out', data: ms.map((m) => m.late / 60), color: '--c-late', stack: 'a' },
      { label: 'Early in', data: ms.map((m) => m.early / 60), color: '--c-early', stack: 'a' }, { label: 'Planned meal worked', data: ms.map((m) => m.mealSkip / 60), color: '--c-meal', stack: 'a' }], fmtY: F.hrsK });
    UI.table(UI.$('#sdM', el), { search: false, rows: ms, cols: [{ key: 'label', label: 'Month' }, { key: 'act', label: 'Paid', num: true, fmt: F.hrsFromMin }, { key: 'overPlan', label: 'Above plan', num: true, fmt: F.hrsFromMin },
      { key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money }, { key: 'otPrem', label: 'OT prem.', num: true, fmt: F.money }, { key: 'sales', label: 'Sales', num: true, fmt: F.moneyK }, { key: 'splh', label: 'SPLH', num: true, fmt: F.n1 }, { key: 'laborPct', label: 'Labor %', num: true, fmt: (v) => F.pct(v) }] });
    const dw = DOW_ORDER.map((i) => d.dow[i]);
    UI.table(UI.$('#sdD', el), { search: false, rows: dw, cols: [{ key: 'dow', label: 'Day' }, { key: 'act', label: 'Paid', num: true, fmt: F.hrsFromMin }, { key: 'sch', label: 'Scheduled', num: true, fmt: F.hrsFromMin },
      { key: 'var', label: 'Paid vs sched', num: true, val: (x) => pctOf(x.act, x.sch) - 1, fmt: (v) => F.pctSigned(v) }, { key: 'unsch', label: 'Unscheduled', num: true, fmt: F.hrsFromMin }, { key: 'late', label: 'Late out', num: true, fmt: F.hrsFromMin }, { key: 'early', label: 'Early in', num: true, fmt: F.hrsFromMin }] });
    const empAll = R.employees.filter((x) => x.store === s);
    UI.table(UI.$('#sdE', el), { rows: empAll.length ? empAll : d.emps, sortKey: 'grossAdd', pageSize: 15, placeholder: 'Search name or GEID', onRow: (x) => G.App.go('employees', { g: x.g }), cols: G.LCIViews.empCols('cost') });
    if (d.editors.length) UI.table(UI.$('#sdEd', el), { search: false, rows: d.editors, sortKey: 'rows', cols: G.LCIViews.editorCols() });
  }

  // ===================== EMPLOYEES =====================
  VIEWS.employees = function (el, R, params) {
    if (params && params.g) return empDetail(el, R, params.g);
    el.innerHTML = `${UI.section('Employees', 'One row per GEID. Recurring = the pattern appears in at least ' + R.rules.recurringWeeks.value + ' different weeks. Click an employee for their day-by-day schedule vs punches.')}
      <div class="panel"><div id="emT"></div></div>`;
    const flag = (r) => [r.recurringEarly && 'early', r.recurringLate && 'late', r.recurringOt && 'OT', r.recurringManual && 'manual'].filter(Boolean);
    UI.table(UI.$('#emT', el), { rows: R.employees, sortKey: 'avoid', tall: true, pageSize: 60, placeholder: 'Search name, GEID, store or job', onRow: (r) => G.App.go('employees', { g: r.g }), cols: [
      { key: 'name', label: 'Employee', text: (r) => r.name + ' ' + r.g, fmt: (v, r) => `${esc(v)}${r.nameConflict ? ' <span class="tag vld" title="Different names for this GEID across files">name varies</span>' : ''}<span class="sub">GEID ${esc(r.g)}</span>` },
      { key: 'storeName', label: 'Store' }, { key: 'job', label: 'Job' }, { key: 'paidHrs', label: 'Paid h', num: true, fmt: F.hrs },
      { key: 'early', label: 'Early in', num: true, fmt: F.hrsFromMin }, { key: 'late', label: 'Late out', num: true, fmt: F.hrsFromMin }, { key: 'unsch', label: 'Unscheduled', num: true, fmt: F.hrsFromMin },
      { key: 'otHrs', label: 'OT h', num: true, fmt: F.hrs }, { key: 'manN', label: 'Manual punches', num: true, fmt: F.n }, { key: 'edited', label: 'Edited punches', num: true, fmt: F.n },
      { key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money, bar: '--c-late' },
      { key: 'rec', label: 'Recurring', val: (r) => flag(r).length, fmt: (v, r) => flag(r).map((x) => `<span class="tag">${x}</span>`).join(' ') }] });
  };

  async function empDetail(el, R, g) {
    el.innerHTML = '<div class="note">Loading employee…</div>';
    const d = await G.App.query({ type: 'employee', g });
    if (!d || !d.emp) { el.innerHTML = '<div class="msg err">GEID not found in this dataset.</div>'; return; }
    const e = d.emp, m = d.master;
    el.innerHTML = `<div class="crumb"><button data-go="employees">Employees</button><span class="sep">›</span><span class="cur">${esc(e.name)}</span></div>
      <h2>${esc(e.name)}</h2>
      <div class="profile" style="margin-bottom:14px">
        <div><div class="pl">GEID</div><div class="pv">${esc(m.geid)}</div></div><div><div class="pl">Job</div><div class="pv">${esc(m.job || '—')}</div></div>
        <div><div class="pl">Stores</div><div class="pv">${esc((m.stores || []).join(', '))}</div></div><div><div class="pl">Age on record</div><div class="pv">${F.n(m.age)}</div></div>
        ${m.altNames && m.altNames.length ? `<div><div class="pl">Other names on this GEID</div><div class="pv">${esc(m.altNames.join(', '))}</div></div>` : ''}
      </div>
      <div class="stack">
        <div class="kpis k5">
          ${UI.kpi({ label: 'Additional labor cost', value: F.money(e.grossAdd), sub: `${F.hrs(e.paidHrs)} paid vs ${F.hrs(e.schHrs)} scheduled · main driver: ${esc(e.mainIssue || '—')}`, cls: 'warn', title: 'Non-overlapping: early + late + unscheduled + skipped meals + OT premium, at this employee\'s rate' })}
          ${UI.kpi({ label: 'Estimated avoidable', value: F.money(e.avoid), sub: `${F.n(e.patternCount || 0)} recurring pattern(s)`, cls: 'bad' })}
          ${UI.kpi({ label: 'Early clock-in cost', value: F.money(e.cEarly), sub: `${F.minHM(e.early)} · ${F.n(e.nEarlyEv)} events >${R.rules.punchTolerance.value} min · ${F.n(e.earlyWeeks)} weeks` })}
          ${UI.kpi({ label: 'Late clock-out cost', value: F.money(e.cLate), sub: `${F.minHM(e.late)} · ${F.n(e.nLateEv)} events >${R.rules.punchTolerance.value} min · ${F.n(e.lateWeeks)} weeks` })}
          ${UI.kpi({ label: 'Overtime premium', value: F.money(e.otPrem), sub: `${F.hrs(e.otHrs)} OT · ${F.n(e.otWeeks)} weeks · manual punches ${F.n(e.manN)}` })}
        </div>
        ${d.patterns && d.patterns.length ? '<div class="panel"><h3>Recurring behavior patterns</h3><div id="edP"></div></div>' : ''}
        <div class="panel"><h3>Extra time by month</h3>${UI.legend([{ label: 'Unscheduled', color: '--c-unsch' }, { label: 'Late out', color: '--c-late' }, { label: 'Early in', color: '--c-early' }, { label: 'Planned meal worked', color: '--c-meal' }])}<div class="chartbox sm"><canvas id="edM"></canvas></div></div>
        <div class="panel"><div class="phead"><h3>Day by day: schedule vs punches</h3><label class="note"><input type="checkbox" id="edOnly" checked> Only days with a deviation</label></div><div id="edD"></div></div>
        <div class="grid2"><div class="panel"><h3>Edited punches</h3><div id="edE"></div></div><div class="panel"><h3>Weeks with overtime</h3><div id="edW"></div></div></div>
      </div>`;
    UI.$('[data-go]', el).addEventListener('click', () => G.App.go('employees'));
    if (d.patterns && d.patterns.length && G.LCIViews.patternTable) G.LCIViews.patternTable(UI.$('#edP', el), R, d.patterns, { compact: false, pageSize: 10, noClick: true });
    const ms = d.months;
    UI.chart(UI.$('#edM', el), { stacked: true, labels: ms.map((x) => F.monthShort(x.month)), series: [
      { label: 'Unscheduled', data: ms.map((x) => x.unsch / 60), color: '--c-unsch', stack: 'a' }, { label: 'Late out', data: ms.map((x) => x.late / 60), color: '--c-late', stack: 'a' },
      { label: 'Early in', data: ms.map((x) => x.early / 60), color: '--c-early', stack: 'a' }, { label: 'Planned meal worked', data: ms.map((x) => x.mealSkip / 60), color: '--c-meal', stack: 'a' }], fmtY: (v) => F.n1(v) + ' h' });
    const daysCols = [{ key: 'date', label: 'Date' }, { key: 'dow', label: 'Day' }, { key: 'store', label: 'Store' }, { key: 'sched', label: 'Scheduled' }, { key: 'actual', label: 'Punched' },
      { key: 'schMin', label: 'Sched paid', num: true, fmt: F.minHM }, { key: 'actMin', label: 'Paid', num: true, fmt: F.minHM },
      { key: 'early', label: 'Early', num: true, fmt: (v) => (v ? F.n(v) + 'm' : '') }, { key: 'late', label: 'Late', num: true, fmt: (v) => (v ? F.n(v) + 'm' : '') },
      { key: 'unsch', label: 'Unsched.', num: true, fmt: (v) => (v ? F.minHM(v) : '') }, { key: 'mealSkip', label: 'Meal worked', num: true, fmt: (v) => (v ? F.n(v) + 'm' : '') },
      { key: 'noShow', label: 'No-show', num: true, fmt: (v) => (v ? F.minHM(v) : '') }, { key: 'avoid', label: 'Avoidable $', num: true, fmt: (v) => (v ? F.money(v) : '') }];
    const drawDays = () => {
      const only = UI.$('#edOnly', el).checked;
      UI.table(UI.$('#edD', el), { rows: only ? d.days.filter((x) => x.early > R.rules.punchTolerance.value || x.late > R.rules.punchTolerance.value || x.unsch || x.mealSkip || x.noShow) : d.days, pageSize: 25, placeholder: 'Search dates or stores', cols: daysCols });
    };
    UI.$('#edOnly', el).addEventListener('change', drawDays);
    drawDays();
    UI.table(UI.$('#edE', el), { search: false, rows: d.edits, pageSize: 10, cols: [{ key: 'date', label: 'Date' }, { key: 'orig', label: 'Original' }, { key: 'adj', label: 'Adjusted' },
      { key: 'net', label: 'Paid time', num: true, fmt: (v) => (v > 0 ? '+' : '') + F.n(v) + 'm' }, { key: 'flag', label: '', val: (r) => (r.snap ? 'snapped to schedule' : r.forgot ? 'forgotten clock-out' : ''), fmt: (v) => (v ? `<span class="tag">${esc(v)}</span>` : '') }] });
    UI.table(UI.$('#edW', el), { search: false, rows: d.weeks, pageSize: 10, cols: [{ key: 'week', label: 'Week of' }, { key: 'sched', label: 'Scheduled', num: true, fmt: F.hrsFromMin }, { key: 'paid', label: 'Paid', num: true, fmt: F.hrsFromMin },
      { key: 'ot', label: 'OT', num: true, fmt: F.hrsFromMin }, { key: 'prem', label: 'Premium', num: true, fmt: F.money }] });
  }

  // ===================== TRENDS =====================
  const METRICS = [
    { k: 'varPct', label: 'Paid vs scheduled hours', fmt: (v) => F.pctSigned(v), goodDown: true, chart: (v) => v * 100, unit: '%' },
    { k: 'overPlanPct', label: 'Labor above plan (% of schedule)', fmt: (v) => F.pct(v), goodDown: true, chart: (v) => v * 100, unit: '%' },
    { k: 'avoid', label: 'Estimated avoidable $', fmt: F.moneyK, goodDown: true },
    { k: 'earlyPer100', label: 'Early clock-in h per 100 paid h', fmt: F.n1, goodDown: true },
    { k: 'latePer100', label: 'Late clock-out h per 100 paid h', fmt: F.n1, goodDown: true },
    { k: 'unschPer100', label: 'Unscheduled h per 100 paid h', fmt: F.n1, goodDown: true },
    { k: 'otPer100', label: 'OT h per 100 paid h', fmt: F.n1, goodDown: true },
    { k: 'editPct', label: 'Paid punches edited', fmt: (v) => F.pct(v), goodDown: true, chart: (v) => v * 100, unit: '%' },
    { k: 'manualPct', label: 'Manual punch share', fmt: (v) => F.pct(v), goodDown: true, chart: (v) => v * 100, unit: '%' },
    { k: 'missedMealPct', label: '6h+ shifts without a meal', fmt: (v) => F.pct(v, 0), goodDown: true, chart: (v) => v * 100, unit: '%' },
    { k: 'splh', label: 'SPLH', fmt: F.n1, goodDown: false },
    { k: 'laborPct', label: 'Labor % of sales', fmt: (v) => F.pct(v), goodDown: true, chart: (v) => v * 100, unit: '%' },
    { k: 'ach', label: 'Sales achievement', fmt: (v) => F.pct(v), goodDown: false, chart: (v) => v * 100, unit: '%' },
  ];
  VIEWS.trends = function (el, R) {
    const S = R.trends.series, dir = R.trends.dir;
    const avail = METRICS.filter((m) => S.some((x) => F.ok(x[m.k])));
    el.innerHTML = `${UI.section('Monthly trends', `${S.length} months. Rates are normalised per paid hour so partial months compare fairly${S.some((x) => x.partial) ? ' (partial: ' + S.filter((x) => x.partial).map((x) => x.label + ', ' + x.days + ' days').join('; ') + ')' : ''}. Direction compares the average of the last 3 months with the first 3; a single unusual month is not called a trend.`)}
      <div class="stack">
        <div class="panel"><div class="controls"><label>Metric <select id="trSel">${avail.map((m) => `<option value="${m.k}">${esc(m.label)}</option>`).join('')}</select></label></div>
          <div class="chartbox"><canvas id="trC"></canvas></div></div>
        <div class="grid2">
          <div class="panel"><h3>What improved and what worsened</h3><div id="trDir"></div></div>
          <div class="panel"><h3>Persistent stores</h3><p class="note" style="margin-top:-4px">Top quartile for (labor above plan + OT premium) per paid hour in at least ${R.rules.persistentMonths.value} months.</p><div id="trP"></div></div>
        </div>
        <div class="panel"><h3>All metrics by month</h3><div id="trT"></div></div>
      </div>`;
    const draw = () => {
      const m = METRICS.find((x) => x.k === UI.$('#trSel', el).value);
      UI.chart(UI.$('#trC', el), { type: 'line', labels: S.map((x) => F.monthShort(x.month) + (x.partial ? '*' : '')), series: [{ label: m.label, data: S.map((x) => (F.ok(x[m.k]) ? (m.chart ? m.chart(x[m.k]) : x[m.k]) : null)), color: '--c-early', type: 'line' }],
        fmtY: m.unit === '%' ? (v) => F.n1(v) + '%' : m.k === 'avoid' ? F.moneyK : F.n1, beginAtZero: false });
    };
    UI.$('#trSel', el).addEventListener('change', draw);
    draw();
    const rows = avail.filter((m) => dir[m.k]).map((m) => { const d = dir[m.k]; const worse = m.goodDown ? d.change > 0.05 : d.change < -0.05; const better = m.goodDown ? d.change < -0.05 : d.change > 0.05; return { m: m.label, first: m.fmt(d.first3), last: m.fmt(d.last3), change: d.change, status: worse ? 'Worsening' : better ? 'Improving' : 'Stable' }; });
    UI.table(UI.$('#trDir', el), { search: false, rows, sortKey: 'status', desc: false, cols: [{ key: 'm', label: 'Metric' }, { key: 'first', label: 'First 3 mo.', num: true }, { key: 'last', label: 'Last 3 mo.', num: true },
      { key: 'change', label: 'Change', num: true, fmt: (v) => F.pctSigned(v, 0) }, { key: 'status', label: 'Direction', fmt: (v) => `<span class="tag ${v === 'Worsening' ? 'risk' : v === 'Improving' ? 'good' : ''}">${v}</span>` }] });
    const byS = Object.fromEntries(R.stores.map((s) => [s.s, s]));
    UI.table(UI.$('#trP', el), { search: false, pageSize: 12, rows: R.trends.persistent.map((p) => Object.assign({ months: p.months }, byS[p.s] || { name: p.s })), sortKey: 'months', onRow: (r) => r.s && G.App.go('stores', { s: r.s }), cols: [
      { key: 'name', label: 'Store' }, { key: 'months', label: 'Months in top quartile', num: true, fmt: F.n }, { key: 'overPlanPct', label: '% above plan', num: true, fmt: (v) => F.pct(v) }, { key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money }] });
    UI.table(UI.$('#trT', el), { search: false, rows: S, cols: [{ key: 'label', label: 'Month', fmt: (v, r) => esc(v) + (r.partial ? ' *' : '') }].concat(avail.map((m) => ({ key: m.k, label: m.label, num: true, fmt: m.fmt }))) });
  };
})(window);
