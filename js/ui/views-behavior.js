/* views-behavior.js — Employee Behavior & Labor Cost Patterns. */
(function (G) {
  const F = G.FMT, UI = G.UI, esc = F.esc;
  const VIEWS = (G.VIEWS = G.VIEWS || {});
  const ORDER = ['combined', 'manual', 'late', 'early', 'earlyLate', 'overtime', 'edits'];
  const SORTS = [
    { k: 'cost', label: 'Highest estimated cost' }, { k: 'occ', label: 'Most occurrences' }, { k: 'streak', label: 'Most consecutive working days / weeks' },
    { k: 'patterns', label: 'Most recurring patterns' }, { k: 'recent', label: 'Most recent occurrence' },
  ];
  const sevRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const shortD = (iso) => (iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');

  /** Pattern table (used by this view, finding drill-downs and the employee page). */
  function patternTable(host, R, rows, opts) {
    opts = opts || {};
    const emp = Object.fromEntries(R.employees.map((e) => [e.g, e]));
    const cols = [
      { key: 'name', label: 'Employee', text: (r) => r.name + ' ' + r.g, fmt: (v, r) => `${esc(v)}<span class="sub">GEID ${esc(r.g)}</span>` },
      { key: 'storeName', label: 'Store' },
      { key: 'label', label: 'Pattern', fmt: (v, r) => esc(v) + (r.flags && r.flags.includes('rising') ? ' <span class="tag risk">rising</span>' : '') + (r.flags && r.flags.includes('above store peers') ? ' <span class="tag vld">vs peers</span>' : '') },
      { key: 'cost', label: '$ impact', num: true, fmt: F.money, bar: '--c-late', title: 'Dollar impact of this pattern at the employee\'s own rate (see the pattern type for what is counted)' },
      { key: 'avoid', label: 'Avoidable $', num: true, fmt: (v) => (v == null ? '—' : F.money(v)) },
      { key: 'occ', label: 'Occurrences', num: true, fmt: (v, r) => (r.cat === 'combined' ? `${F.n(v)} patterns` : `${F.n(v)} of ${F.n(r.workDays)} ${r.unit || 'days'}`) },
      { key: 'streak', label: 'Longest run', num: true, fmt: (v, r) => (r.cat === 'combined' || !v ? '—' : `${F.n(v)} ${r.unit === 'weeks' ? 'wks' : 'days'}<span class="sub">${shortD(r.streakFrom)} – ${shortD(r.streakTo)}</span>`), title: 'Consecutive working days (weeks for overtime). Days not worked are skipped; a day with no data in scope breaks the run.' },
      { key: 'hrs', label: 'Hours', num: true, fmt: F.hrs },
      { key: 'last', label: 'First – last', val: (r) => r.last, fmt: (v, r) => `${shortD(r.first)} – ${shortD(r.last)}` },
      { key: 'severity', label: 'Severity', val: (r) => sevRank[r.severity], fmt: (v, r) => `<span class="sev s-${r.severity}">${r.severity}</span>` },
    ];
    if (!opts.compact) cols.push({ key: 'description', label: 'What the pattern is', fmt: (v) => `<span class="note">${esc(v)}</span>` });
    UI.table(host, { rows, cols, sortKey: opts.sortKey || 'cost', desc: opts.desc !== false, pageSize: opts.pageSize || 25, placeholder: 'Search name, GEID or store', onRow: opts.noClick ? null : (r) => G.App.go('employees', { g: r.g }) });
    return emp;
  }

  VIEWS.behavior = function (el, R, params) {
    const B = R.behavior;
    el.innerHTML = `<h2>${esc(G.LCIViews.scopeTitle(R, 'Employee behavior & labor cost patterns'))}</h2>`;
    if (!B || !B.patterns.length) { el.innerHTML += '<div class="empty panel">No recurring employee patterns in this selection. Patterns need at least ' + (B ? B.rules.minOcc : 8) + ' occurrences in the selected dates — try a longer period.</div>'; return; }
    const rules = B.rules;
    const sum = B.summary;
    const cats = ORDER.filter((k) => sum[k] && sum[k].emps);
    const st = { cat: params && params.cat && cats.includes(params.cat) ? params.cat : cats[0], sort: 'cost' };
    const emps = new Set(B.patterns.map((p) => p.g)).size;
    const nonOverlap = U_sum(R.employees.filter((e) => e.patternCount > 0).map((e) => e.grossAdd));
    el.innerHTML += `<p class="lead">Employees whose labor deviations <b>recur</b> in the selected stores and dates — consecutive working days, share of working days, rising trends and outliers vs store colleagues — each with its dollar impact at the employee's own pay rate. A recurring pattern is a reason to look, not proof of misconduct: manual punches, for example, often come from device or access problems.</p>
      <div class="stack">
        <div class="kpis k5">
          ${UI.kpi({ label: 'Employees with recurring patterns', value: F.n(emps), sub: `of ${F.n(R.meta.employeeCount)} employees in scope`, cls: 'accent' })}
          ${UI.kpi({ label: 'Their additional labor cost', value: F.moneyK(nonOverlap), sub: 'non-overlapping (early, late, unscheduled, meals, OT premium)', cls: 'bad', title: 'Each listed employee\'s total additional pay, counted once even when several patterns apply' })}
          ${UI.kpi({ label: 'Of which estimated avoidable', value: F.moneyK(U_sum(R.employees.filter((e) => e.patternCount > 0).map((e) => e.avoid))), sub: 'beyond tolerance, netted at store-day level', cls: 'warn' })}
          ${UI.kpi({ label: 'Largest pattern by $', value: F.moneyK(B.patterns[0].cost), sub: `${esc(B.patterns[0].name)} · ${esc(B.patterns[0].label.toLowerCase())}` })}
          ${UI.kpi({ label: 'Longest run', value: (() => { const p = B.patterns.filter((x) => x.cat !== 'combined' && x.unit !== 'weeks').sort((a, b) => b.streak - a.streak)[0]; return p ? `${F.n(p.streak)} days` : '—'; })(), sub: (() => { const p = B.patterns.filter((x) => x.cat !== 'combined' && x.unit !== 'weeks').sort((a, b) => b.streak - a.streak)[0]; return p ? `${esc(p.name)} · ${esc(p.label.toLowerCase())}` : ''; })(), title: 'Most consecutive working days showing the same pattern' })}
        </div>
        <div class="panel">
          <div class="phead"><h3>Patterns by type</h3><span class="note">Category $ overlap (an early start keyed in manually is both "early" and "manual"), so they are not added together.</span></div>
          <div class="chips" id="bhCats">${cats.map((k) => `<button class="chip" aria-pressed="${k === st.cat}" data-k="${k}">${esc(sum[k].label)}<span class="n">${F.n(sum[k].emps)} · ${F.moneyK(sum[k].cost)}</span></button>`).join('')}</div>
          <div class="controls" style="margin-top:12px"><label>Sort <select id="bhSort">${SORTS.map((s) => `<option value="${s.k}">${esc(s.label)}</option>`).join('')}</select></label><span class="note" id="bhCatNote"></span></div>
          <div id="bhT"></div>
        </div>
        ${B.storeConc.length && R.stores.length > 1 ? '<div class="panel"><h3>Stores where many employees share the same pattern</h3><p class="note" style="margin-top:-4px">40% or more of the store\'s active employees (8+ working days) show the same recurring pattern — usually a store process issue rather than individual behaviour.</p><div id="bhS"></div></div>' : ''}
        <div class="panel"><h3>How patterns are detected</h3><ul class="vlist">
          <li class="info">Working day = a day the employee has paid punches in the selected scope. A run of consecutive working days skips days not worked, but stops at any day with no data in scope, so missing data never extends a run.</li>
          <li class="info">Recurring = at least ${rules.minOcc} occurrences and either a run of ${rules.minStreak}+ working days, ${Math.round(rules.minShare * 100)}%+ of working days, or ${rules.minBest10}+ of any 10 working days. Also flagged: a month at twice the earlier rate ("rising"), and 3× the store's typical rate ("vs peers"). Early/late patterns under $${rules.minCost} are left out as immaterial.</li>
          <li class="info">Overtime is weekly: consecutive weeks with overtime pay. Manual punches = punch source MANUAL (keyed in by a manager), split into clock-in / clock-out from the audit log. Edits use the original vs adjusted punch times.</li>
          <li class="info">$ impact: early/late = cost of those minutes; manual = cost of early/late/unscheduled time recorded through manual punches; overtime = OT premium paid; edits = net paid time added (forgotten clock-out fixes excluded); multiple patterns = the employee's non-overlapping additional pay.</li>
        </ul></div>
      </div>`;
    const draw = () => {
      UI.$$('#bhCats .chip', el).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === st.cat)));
      const rows = B.patterns.filter((p) => p.cat === st.cat).map((p) => Object.assign({}, p, { patterns: (R.employees.find((e) => e.g === p.g) || {}).patternCount || 0 }));
      const sortKey = st.sort === 'cost' ? 'cost' : st.sort === 'occ' ? 'occ' : st.sort === 'streak' ? 'streak' : st.sort === 'recent' ? 'last' : 'patterns';
      if (st.sort === 'patterns') rows.sort((a, b) => b.patterns - a.patterns || b.cost - a.cost);
      const s = sum[st.cat];
      UI.$('#bhCatNote', el).innerHTML = `${F.n(s.emps)} employees · <b>${F.money(s.cost)}</b>${s.avoid ? ` · ${F.money(s.avoid)} avoidable` : ''} · ${F.n(s.high)} High/Critical`;
      patternTable(UI.$('#bhT', el), R, rows, { sortKey: st.sort === 'patterns' ? null : sortKey });
    };
    UI.$$('#bhCats .chip', el).forEach((b) => b.addEventListener('click', () => { st.cat = b.dataset.k; draw(); }));
    UI.$('#bhSort', el).addEventListener('change', (e) => { st.sort = e.target.value; draw(); });
    draw();
    if (UI.$('#bhS', el)) UI.table(UI.$('#bhS', el), { rows: B.storeConc, sortKey: 'cost', pageSize: 15, placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.store }), cols: [
      { key: 'storeName', label: 'Store' }, { key: 'label', label: 'Pattern' }, { key: 'emps', label: 'Employees', num: true, fmt: (v, r) => `${F.n(v)} of ${F.n(r.active)}` },
      { key: 'share', label: 'Share of staff', num: true, fmt: (v) => F.pct(v, 0), bar: '--c-unsch' }, { key: 'cost', label: '$ impact', num: true, fmt: F.money }] });
  };

  function U_sum(a) { let s = 0; for (const v of a) s += v || 0; return s; }

  G.LCIViews = Object.assign(G.LCIViews || {}, { patternTable });
})(window);
