/* views-reference.js — Data quality and Method & rules. */
(function (G) {
  const F = G.FMT, UI = G.UI, esc = F.esc;
  const VIEWS = (G.VIEWS = G.VIEWS || {});

  VIEWS.quality = function (el, R) {
    const Q = R.quality, s = Q.summary;
    const mk = Q.monthKeys;
    el.innerHTML = `${UI.section('Data quality & validation', 'What was read, what was excluded and why, and the checks the calculations passed. Missing data (blank or "-"), zero values and records that do not apply are counted separately.')}
      <div class="stack">
        <div class="kpis">
          ${UI.kpi({ label: 'Files recognised', value: `${s.recognised} / ${s.files}`, sub: 'Classified by column headers' })}
          ${UI.kpi({ label: 'Rows read', value: F.n(s.rowsRead), sub: 'All files, before exclusions' })}
          ${UI.kpi({ label: 'Warnings', value: F.n(s.warnings), sub: `${F.n(s.errors)} errors`, cls: s.errors ? 'bad' : s.warnings ? 'warn' : '' })}
          ${UI.kpi({ label: 'GEIDs matched', value: F.n(Q.geidCoverage.punch), sub: `${F.n(Q.geidCoverage.punchOnly)} paid but never scheduled · ${F.n(Q.geidCoverage.schedOnly)} scheduled, never paid` })}
        </div>
        <div class="panel"><h3>Month coverage by report type</h3><div id="dqCov"></div></div>
        <div class="panel"><h3>Files</h3><div id="dqF"></div></div>
        <div class="grid2">
          <div class="panel"><h3>Issues found</h3><ul class="vlist">${Q.issues.map((i) => `<li class="${i.level}"><span class="area">${esc(i.area)}</span>${esc(i.msg)}</li>`).join('')}</ul></div>
          <div class="panel"><h3>Calculation checks</h3><ul class="vlist">${Q.checks.map((c) => `<li class="${c.status === 'pass' ? 'pass' : c.status}"><b>${esc(c.name)}</b><br><span class="note">${esc(c.detail)}</span></li>`).join('')}</ul></div>
        </div>
        <div class="panel"><h3>Records used after exclusions</h3><div id="dqRC"></div></div>
      </div>`;
    const cov = Object.entries(Q.typeCoverage || {}).map(([k, t]) => ({ k, label: t.label, files: t.files.length, months: t.months, missing: t.missingMonths || [] }));
    UI.table(UI.$('#dqCov', el), { search: false, rows: cov, cols: [{ key: 'label', label: 'Report type' }, { key: 'files', label: 'Files', num: true, fmt: F.n }]
      .concat(mk.map((m) => ({ key: 'm' + m, label: F.monthShort(m), num: true, val: (r) => r.months[m] || 0, fmt: (v) => (v ? F.n(v) : '<span class="tag risk">none</span>') }))) });
    UI.table(UI.$('#dqF', el), { rows: Q.files, placeholder: 'Search files', cols: [
      { key: 'name', label: 'File' }, { key: 'label', label: 'Detected as', fmt: (v, r) => (r.type ? esc(v) : `<span class="tag risk">${esc(v)}</span>`) },
      { key: 'rows', label: 'Rows', num: true, fmt: F.n }, { key: 'accepted', label: 'Accepted', num: true, fmt: F.n }, { key: 'duplicates', label: 'Duplicates', num: true, fmt: F.n },
      { key: 'invalidDate', label: 'Bad dates', num: true, fmt: F.n }, { key: 'missingGeid', label: 'No GEID', num: true, fmt: F.n }, { key: 'stores', label: 'Stores', num: true, fmt: F.n },
      { key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'notes', label: 'Notes', val: (r) => (r.notes || []).join(' '), fmt: (v, r) => esc((r.notes || []).join(' ')) + (r.unmapped && r.unmapped.length ? `<span class="sub">Unused columns: ${esc(r.unmapped.join(', '))}</span>` : '') }] });
    UI.table(UI.$('#dqRC', el), { search: false, rows: Object.entries(Q.recordCounts).map(([k, v]) => Object.assign({ k }, v)), cols: [
      { key: 'k', label: 'Record set' }, { key: 'total', label: 'Ingested', num: true, fmt: F.n }, { key: 'outOfPeriod', label: 'Outside period', num: true, fmt: F.n },
      { key: 'excludedStore', label: 'Test stores', num: true, fmt: F.n }, { key: 'kept', label: 'Used', num: true, fmt: F.n }] });
  };

  VIEWS.method = function (el, R) {
    const rules = Object.entries(R.rules);
    const srcTag = (s) => ({ product: '<span class="tag conf">Product rule</span>', data: '<span class="tag good">From data</span>', analysis: '<span class="tag est">Analysis assumption</span>' }[s] || '');
    el.innerHTML = `${UI.section('Method & rules', 'How every number is calculated, and where each rule comes from: verified in the Schedule/Clock product code, inferred from this dataset, or an analytical assumption that needs business validation.')}
      <div class="stack">
        <div class="panel"><h3>Rules and thresholds</h3><div id="mRules"></div></div>
        <div class="grid2">
          <div class="panel"><h3>Core formulas</h3>
            <h4>Schedule vs actual (per GEID × business day)</h4>
            <div class="formula">scheduled paid = shift blocks − planned MEAL segments   (REST is paid)
actual paid    = Σ Total Punch Hours (already net of unpaid breaks)
early clock-in = max(0, block start − first clock-in)
late clock-out = max(0, last clock-out − block end)
unscheduled    = punches overlapping no scheduled block
skipped meal   = planned meal − meal break taken (while on the clock)</div>
            <h4 style="margin-top:12px">Store-day netting</h4>
            <div class="formula">labor above plan = Σ store-days max(0, Σ paid − Σ scheduled)
behavioural      = early/late minutes beyond ${R.rules.punchTolerance.value} min + skipped meals
avoidable        = behavioural × min(1, labor above plan ÷ behavioural)</div>
            <h4 style="margin-top:12px">Overtime</h4>
            <div class="formula">OT premium   = OT pay − OT hours × base rate
scheduled OT = min(OT, max(0, scheduled week − ${R.rules.weeklyOtThreshold.value / 60} h))
drift OT     = OT − scheduled OT</div>
            <h4 style="margin-top:12px">Edits and sales</h4>
            <div class="formula">edit effect = (adjusted out − adjusted in) − (original out − original in)
SPLH        = monthly actual sales ÷ monthly paid hours
labor %     = monthly punch pay ÷ monthly actual sales
achievement = monthly actual ÷ monthly forecast sales</div>
          </div>
          <div class="panel"><h3>Financial definitions</h3><dl class="dash">
            <dt>Actual labor expenditure</dt><dd>Σ Total Pay on paid punches.</dd>
            <dt>Additional labor hours</dt><dd>Gross early + late + unscheduled + skipped-meal minutes (individual level).</dd>
            <dt>Estimated additional cost</dt><dd>Additional minutes × that punch's own pay rate, + OT premium.</dd>
            <dt>Labor above plan</dt><dd>Store-day net paid − scheduled, at the store-day's average paid rate.</dd>
            <dt>Estimated avoidable cost</dt><dd>Netted behavioural minutes × rate + drift OT premium.</dd>
            <dt>Potential savings</dt><dd>50–100% of avoidable — a scenario, not realised savings.</dd></dl>
            <p class="note">Categories never overlap: base pay of extra minutes sits in the adherence parts; only the OT premium is in overtime; edits overlap the adherence parts and are therefore shown separately and never added.</p>
            <h3 style="margin-top:16px">Known limitations</h3>
            <ul class="vlist">
              <li class="info">Sales are used monthly only. The dataset's sales files may carry finer time slots; they are deliberately aggregated to month and never used below that.</li>
              <li class="info">Unscheduled shifts may be legitimate call-ins; they are not counted as avoidable until reasons are validated.</li>
              <li class="info">Editor identity has no GEID. Self-edit detection is a name match and must be confirmed.</li>
              <li class="info">Break and minor thresholds vary by state; the values marked "Analysis assumption" are review thresholds.</li>
              <li class="info">Several export column meanings (Punch Method "Password", Source Id "CLOCK_TIMECARD", GEID) are not product field names; they are interpreted from their values (Password ≈ PIN punch, not biometric).</li>
              ${R.quality.issues.filter((i) => /export cap|truncat/i.test(i.msg)).map((i) => `<li class="warn">${esc(i.msg)}</li>`).join('')}
            </ul>
          </div>
        </div>
      </div>`;
    UI.table(UI.$('#mRules', el), { search: false, rows: rules.map(([k, v]) => Object.assign({ k }, v)), cols: [
      { key: 'label', label: 'Rule' }, { key: 'value', label: 'Value', num: true, fmt: (v, r) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : r.unit === 'min of day' ? Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0') : F.n1(v).replace(/\.0$/, '') + ' ' + esc(r.unit)) },
      { key: 'source', label: 'Source', fmt: (v, r) => srcTag(v) + (r.overridden ? ' <span class="tag">overridden by manifest</span>' : '') + (r.inferred ? `<span class="sub">${F.n(r.inferred.matching)} of ${F.n(r.inferred.otWeeks)} OT weeks agree</span>` : '') },
      { key: 'use', label: 'How it is used' }, { key: 'ref', label: 'Reference', fmt: (v) => `<span class="note">${esc(v)}</span>` }] });
  };
})(window);
