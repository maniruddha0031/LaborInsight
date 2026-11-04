/* views-analysis.js — Executive overview, Findings, Action plan. */
(function (G) {
  const F = G.FMT, UI = G.UI, esc = F.esc;
  const VIEWS = (G.VIEWS = G.VIEWS || {});

  const storeName = (R, s) => (R.meta.storeNames && R.meta.storeNames[s]) || s;

  // ===================== EXECUTIVE OVERVIEW =====================
  VIEWS.overview = function (el, R) {
    const Fi = R.financials, p = R.meta.period;
    const months = R.trends.series;
    const avoidPctTxt = F.pct(Fi.avoidPct, 1);
    el.innerHTML = `
      <h2>${esc(G.LCIViews.scopeTitle(R, 'Executive labor overview'))}</h2>
      <p class="lead">${F.date(p.startIso)} – ${F.date(p.endIso)} · ${R.meta.storeCount} store${R.meta.storeCount === 1 ? '' : 's'} · ${F.n(R.meta.employeeCount)} employees (GEID). Paid labor of ${F.money(Fi.laborCost)} was compared shift by shift with the schedule, the punch record and the monthly sales it supported.</p>
      <div class="stack">
        <div class="kpis k3">
          ${UI.kpi({ label: 'Actual labor cost', value: F.money(Fi.laborCost), sub: `${F.hrsK(Fi.paidHours)} paid · ${F.pctSigned(Fi.paidHours / Fi.schedHours - 1)} vs schedule <span class="tag conf">Actual</span>`, cls: 'accent', title: 'Sum of Total Pay on every paid punch in the selected stores and dates (payroll export)' })}
          ${UI.kpi({ label: 'Additional labor cost', value: F.money(Fi.grossAddCost), sub: `${F.hrsK(Fi.grossAddMin / 60)} beyond schedule + OT premium · ${F.n(Fi.affected.emps)} employees, ${F.n(Fi.affected.stores)} stores <span class="tag est">Estimate</span>`, cls: 'warn', title: 'Early, late, unscheduled and skipped-meal minutes at each employee\'s own pay rate, plus OT premium. Each minute is counted once.' })}
          ${UI.kpi({ label: 'Estimated avoidable cost', value: F.money(Fi.avoidCost), sub: `${avoidPctTxt} of labor · ≈${F.moneyK(Fi.avoidRunRate)}/month recently <span class="tag est">Estimate</span>`, cls: 'bad', title: 'Early/late minutes beyond the punch tolerance and skipped planned meals, capped at labor above plan, plus OT premium from working past the schedule' })}
          ${UI.kpi({ label: 'Potential savings opportunity', value: `${F.moneyK(Fi.savingsRange[0])}–${F.moneyK(Fi.savingsRange[1])}`, sub: 'if 50–100% of the avoidable cost is captured — not guaranteed', title: 'A scenario, not realised savings' })}
          ${UI.kpi({ label: 'Top cost leakage category', value: Fi.topCategory ? F.money(Fi.topCategory.cost) : '—', sub: Fi.topCategory ? `${esc(Fi.topCategory.label)} · largest non-overlapping part` : '', title: 'Largest part of the additional labor cost' })}
          ${R.stores.length > 1 && Fi.topStore ? UI.kpi({ label: 'Highest cost leakage store', value: F.money(Fi.topStore.avoid), sub: `Store ${esc(Fi.topStore.name)} · estimated avoidable (of ${F.money(Fi.topStore.grossAdd)} additional)`, title: 'Store with the largest estimated avoidable cost' }) : UI.kpi({ label: 'Labor above plan', value: F.money(Fi.overPlan.cost), sub: `${F.hrsK(Fi.overPlan.min / 60)} on ${F.pct(Fi.overPlan.days / Fi.overPlan.storeDays, 0)} of days`, title: 'max(0, paid − scheduled hours) per day × that day\'s average rate' })}
        </div>

        <div class="panel">
          <div class="phead"><h3>From labor spend to savings</h3><span class="note">Each step is a subset of the one before; none of the figures are added together.</span></div>
          <div class="sumflow">
            <div class="sf"><div class="dl">1 · Actual labor expenditure</div><div class="v">${F.moneyK(Fi.laborCost)}</div><div class="x">Total pay on every paid punch in the period.</div></div>
            <div class="sf"><div class="dl">2 · Gross additional time</div><div class="v">${F.hrsK(Fi.grossAddMin / 60)}</div><div class="x">${F.moneyK(Fi.grossAddCost)} incl. OT premium. Early, late, unscheduled and skipped-meal minutes by individual employees.</div></div>
            <div class="sf"><div class="dl">3 · Labor above plan (net)</div><div class="v">${F.hrsK(Fi.overPlan.min / 60)}</div><div class="x">${F.moneyK(Fi.overPlan.cost)}. After netting each store-day against no-shows and early leaves (${F.hrsK(Fi.gapCovered / 60)} of cover removed).</div></div>
            <div class="sf hl"><div class="dl">4 · Estimated avoidable</div><div class="v">${F.moneyK(Fi.avoidCost)}</div><div class="x">Minutes beyond the ${R.rules.punchTolerance.value}-min punch tolerance and skipped planned meals (capped at labor above plan) + OT premium from drift.</div></div>
            <div class="sf"><div class="dl">5 · Potential savings</div><div class="v">${F.moneyK(Fi.savingsRange[0])}–${F.moneyK(Fi.savingsRange[1])}</div><div class="x">If 50–100% of the avoidable amount is captured by the actions. An estimate, not realised savings.</div></div>
          </div>
        </div>

        <div class="grid21">
          <div class="panel">
            <div class="phead"><h3>Where the money leaks — additional labor cost by category</h3><span class="note">Light bar = additional cost · solid bar = estimated avoidable</span></div>
            <div id="ovBars"></div>
            <p class="note" style="margin:10px 0 0">Costed at each employee's actual pay rate (OT at the exported OT pay). Unscheduled shifts are not counted as avoidable until call-in reasons are validated.</p>
          </div>
          <div class="panel">
            <div class="phead"><h3>Top findings</h3><button class="lnk" id="ovAll">All ${R.insights.length} findings</button></div>
            <div id="ovTop" class="actions"></div>
          </div>
        </div>

        <div class="grid2">
          <div class="panel">
            <div class="phead"><h3>Labor above plan and avoidable cost by month</h3></div>
            ${UI.legend([{ label: 'Labor above plan', color: '--c-neutral' }, { label: 'Estimated avoidable', color: '--c-late' }])}
            <div class="chartbox"><canvas id="ovMonth"></canvas></div>
            <p class="note" style="margin:6px 0 0">${months.some((m) => m.partial) ? 'Partial months: ' + months.filter((m) => m.partial).map((m) => `${m.label} (${m.days} days)`).join(', ') + '. ' : ''}Click a month to open the trend view.</p>
          </div>
          <div class="panel">
            <div class="phead"><h3>${R.stores.length === 1 ? 'Employees to act on first' : 'Stores to act on first'}</h3><button class="lnk" id="ovStores">${R.stores.length === 1 ? 'All employees' : 'All stores'}</button></div>
            <div id="ovStoreTbl"></div>
          </div>
        </div>
        <div class="panel" id="ovData"></div>
      </div>`;

    const parts = Fi.parts || [];
    const colorOf = { late: '--c-late', early: '--c-early', unsch: '--c-unsch', meal: '--c-meal', ot: '--c-ot' };
    const maxCost = Math.max(1, ...parts.map((p) => p.cost));
    UI.$('#ovBars', el).innerHTML = UI.bars(parts.map((p) => ({ label: p.label, sub: `${F.hrsK(p.min / 60)}${p.k === 'ot' ? ' OT' : ''}${p.note ? ' · ' + p.note.split(';')[0] : ''}`, outer: p.cost, value: p.avoid || 0, display: F.moneyK(p.cost), sub2: p.avoid ? F.moneyK(p.avoid) + ' avoidable' : 'needs review', color: colorOf[p.k], title: p.note || '' })), { max: maxCost }) +
      `<div class="note" style="margin:8px 0 0">Total additional labor cost <b>${F.money(Fi.grossAddCost)}</b> — the rows above add up to it; every minute is in exactly one row.</div>` +
      ((Fi.lenses || []).some((l) => l.cost > 0) ? `<div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--line)"><div class="note" style="margin-bottom:6px">Contributing factors — part of the rows above, <b>not added</b>:</div>${UI.bars(Fi.lenses.filter((l) => l.cost > 0).map((l) => ({ label: l.label, sub: l.k === 'manual' ? `${F.n(Fi.manual.n)} keyed-in punches` : `${F.n(Fi.edits.addedN)} punches with time added`, outer: l.cost, value: l.avoid || 0, display: F.moneyK(l.cost), sub2: l.avoid ? F.moneyK(l.avoid) + ' avoidable' : '', color: '--c-neutral' })), { max: maxCost })}<button class="lnk" id="ovManual">Open manual punch analysis</button> · <button class="lnk" id="ovBeh">Employee behavior patterns</button></div>` : '');
    const ob = UI.$('#ovBeh', el); if (ob) ob.addEventListener('click', () => G.App.go('behavior'));
    const om = UI.$('#ovManual', el); if (om) om.addEventListener('click', () => G.App.go('manual'));

    UI.$('#ovTop', el).innerHTML = R.insights.slice(0, 6).map((i, n) => `
      <div class="act"><div class="no ${i.severity}">${n + 1}</div>
        <div><div class="cmd"><button class="ilink" data-id="${esc(i.id)}">${esc(i.title)}</button></div>
        <div class="meta"><span class="sev s-${i.severity}">${i.severity}</span>${F.kindTag(i.kind)}<span class="tag">${esc(i.category)}</span></div></div>
        <div class="val">${i.impact && F.ok(i.impact.cost) && i.impact.cost ? F.moneyK(i.impact.cost) : ''}</div></div>`).join('');
    UI.$$('#ovTop .ilink', el).forEach((b) => b.addEventListener('click', () => G.App.go('findings', { open: b.dataset.id })));
    UI.$('#ovAll', el).addEventListener('click', () => G.App.go('findings'));
    UI.$('#ovStores', el).addEventListener('click', () => G.App.go(R.stores.length === 1 ? 'employees' : 'stores'));

    UI.chart(UI.$('#ovMonth', el), {
      labels: months.map((m) => F.monthShort(m.month) + (m.partial ? '*' : '')),
      series: [
        { label: 'Labor above plan', data: months.map((m) => m.overPlanCost), color: '--c-neutral' },
        { label: 'Estimated avoidable', data: months.map((m) => m.avoid), color: '--c-late' },
      ],
      fmtY: F.moneyK, onClick: () => G.App.go('trends'),
    });

    if (R.stores.length === 1) {
      UI.table(UI.$('#ovStoreTbl', el), { search: false, pageSize: 8, rows: R.employees.slice().sort((x, y) => y.avoid - x.avoid).slice(0, 8), sortKey: 'avoid', cols: G.LCIViews.empCols('cost').slice(0, 6), onRow: (r) => G.App.go('employees', { g: r.g }) });
    } else {
    const persistent = new Set(R.trends.persistent.map((x) => x.s));
    const top = R.stores.slice().sort((x, y) => y.avoid + y.overPlanCost * 0.25 - (x.avoid + x.overPlanCost * 0.25)).slice(0, 8);
    UI.table(UI.$('#ovStoreTbl', el), {
      search: false, pageSize: 8, rows: top, sortKey: 'avoid',
      cols: [
        { key: 'name', label: 'Store', fmt: (v, r) => esc(v) + (persistent.has(r.s) ? ' <span class="tag risk" title="Top quartile in most months">persistent</span>' : '') },
        { key: 'overPlanPct', label: 'Over plan', num: true, fmt: (v) => F.pct(v) },
        { key: 'overPlanCost', label: 'Above plan $', num: true, fmt: F.moneyK },
        { key: 'avoid', label: 'Avoidable $', num: true, fmt: F.moneyK, bar: '--c-late' },
        { key: 'otPrem', label: 'OT premium', num: true, fmt: F.moneyK },
      ],
      onRow: (r) => G.App.go('stores', { s: r.s }),
    });
    }

    const q = R.quality;
    UI.$('#ovData', el).innerHTML = `<div class="phead"><h3>Data notes that affect these numbers</h3><button class="lnk" id="ovQ">Data quality report</button></div>
      <ul class="vlist">${q.issues.filter((i) => i.level !== 'info').slice(0, 6).map((i) => `<li class="${i.level}"><span class="area">${esc(i.area)}</span>${esc(i.msg)}</li>`).join('') || '<li class="pass">No warnings.</li>'}</ul>`;
    UI.$('#ovQ', el).addEventListener('click', () => G.App.go('quality'));
  };

  // ===================== FINDINGS =====================
  const SEV = ['Critical', 'High', 'Medium', 'Low'];
  const KIND = { confirmed: 'Confirmed', estimate: 'Estimate', risk: 'Risk', validate: 'Needs validation' };

  function drillStores(R, rows) {
    const set = new Set(rows);
    return R.stores.filter((s) => set.has(s.s)).sort((a, b) => rows.indexOf(a.s) - rows.indexOf(b.s));
  }
  const dollars = (v) => (F.ok(v) ? '$' + F.n1(v) : '—');
  function storeCols(key) {
    const base = [{ key: 'name', label: 'Store' }];
    const m = {
      overPlanCost: [{ key: 'overPlanHrs', label: 'Hours above plan', num: true, fmt: F.hrs }, { key: 'overPlanPct', label: '% over plan', num: true, fmt: (v) => F.pct(v) }, { key: 'overPlanCost', label: 'Above plan $', num: true, fmt: F.money, bar: '--c-neutral' }, { key: 'otPrem', label: 'OT premium', num: true, fmt: F.money }],
      missedMealPct: [{ key: 'missedMealPct', label: '6h+ shifts without meal', num: true, fmt: (v) => F.pct(v, 0), bar: '--c-meal' }, { key: 'mealSkip', label: 'Skipped planned meal', num: true, fmt: F.hrsFromMin }, { key: 'shortMeals', label: 'Short meals', num: true, fmt: F.n }],
      manualPct: [{ key: 'manualPct', label: 'Manual punch share', num: true, fmt: (v) => F.pct(v), bar: '--c-unsch' }, { key: 'retro', label: 'Retroactive entries', num: true, fmt: F.n }, { key: 'editPct', label: 'Punches edited', num: true, fmt: (v) => F.pct(v) }, { key: 'editAddMin', label: 'Time added by edits', num: true, fmt: F.hrsFromMin }],
      nonFlex: [{ key: 'nonFlex', label: 'Months sales ↓ hours ↑', num: true, fmt: F.n }, { key: 'splh', label: 'SPLH', num: true, fmt: F.n1 }, { key: 'laborPct', label: 'Labor %', num: true, fmt: (v) => F.pct(v) }, { key: 'sales', label: 'Sales', num: true, fmt: F.moneyK }],
      peerGapHrs: [{ key: 'splh', label: 'SPLH', num: true, fmt: F.n1 }, { key: 'peerGapHrs', label: 'Hours vs peer median', num: true, fmt: F.hrs, bar: '--c-neutral' }, { key: 'laborPct', label: 'Labor %', num: true, fmt: (v) => F.pct(v) }],
      minorLate: [{ key: 'minorPunches', label: 'Minor punches', num: true, fmt: F.n }, { key: 'minorLate', label: 'Ending after limit', num: true, fmt: F.n, bar: '--c-late' }],
      manual: [{ key: 'manN', label: 'Manual punches', num: true, fmt: F.n }, { key: 'manMin', label: 'Manual hours', num: true, fmt: F.hrsFromMin, bar: '--c-unsch' }, { key: 'manShare', label: '% of paid hours', num: true, fmt: (v) => F.pct(v) }, { key: 'manPay', label: 'Pay on manual time', num: true, fmt: F.money }, { key: 'manAvoid', label: 'Avoidable (review)', num: true, fmt: F.money }, { key: 'retro', label: 'Entered late', num: true, fmt: F.n }],
      avoid: [{ key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money, bar: '--c-late' }, { key: 'avoidPerHr', label: '$ per paid hour', num: true, fmt: dollars }, { key: 'overPlanPct', label: '% above plan', num: true, fmt: (v) => F.pct(v) }, { key: 'otPrem', label: 'OT premium', num: true, fmt: F.money }, { key: 'manShare', label: 'Manual hours %', num: true, fmt: (v) => F.pct(v) }],
    };
    return base.concat(m[key] || m.overPlanCost);
  }
  const patterns = (r) => [r.recurringEarly && 'early in', r.recurringLate && 'late out', r.recurringOt && 'overtime', r.recurringManual && 'manual punches', r.editWeeks >= 4 && 'edits', r.unschWeeks >= 4 && 'unscheduled'].filter(Boolean);
  function empCols(key) {
    const base = [{ key: 'name', label: 'Employee', fmt: (v, r) => `${esc(v)}<span class="sub">GEID ${esc(r.g)} · ${esc(r.job)}</span>` }, { key: 'storeName', label: 'Store' }];
    const m = {
      late: [{ key: 'late', label: 'Late clock-out', num: true, fmt: F.hrsFromMin, bar: '--c-late' }, { key: 'nLateEv', label: 'Events >10 min', num: true, fmt: F.n }, { key: 'lateWeeks', label: 'Weeks', num: true, fmt: F.n }, { key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money }],
      early: [{ key: 'early', label: 'Early clock-in', num: true, fmt: F.hrsFromMin, bar: '--c-early' }, { key: 'nEarlyEv', label: 'Events >10 min', num: true, fmt: F.n }, { key: 'earlyWeeks', label: 'Weeks', num: true, fmt: F.n }, { key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money }],
      unsch: [{ key: 'unsch', label: 'Unscheduled', num: true, fmt: F.hrsFromMin, bar: '--c-unsch' }, { key: 'unschWeeks', label: 'Weeks', num: true, fmt: F.n }, { key: 'paidHrs', label: 'Paid hours', num: true, fmt: F.hrs }],
      otPrem: [{ key: 'otHrs', label: 'OT hours', num: true, fmt: F.hrs }, { key: 'otWeeks', label: 'OT weeks', num: true, fmt: F.n }, { key: 'otPrem', label: 'OT premium', num: true, fmt: F.money, bar: '--c-ot' }, { key: 'otDrift', label: 'From drift', num: true, fmt: F.money }],
      editAddMin: [{ key: 'edited', label: 'Edited punches', num: true, fmt: F.n }, { key: 'editPct', label: 'Share edited', num: true, fmt: (v) => F.pct(v) }, { key: 'editAddMin', label: 'Time added', num: true, fmt: F.hrsFromMin, bar: '--c-unsch' }, { key: 'editWeeks', label: 'Weeks', num: true, fmt: F.n }],
      avoid: [{ key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money, bar: '--c-late' }, { key: 'early', label: 'Early', num: true, fmt: F.hrsFromMin }, { key: 'late', label: 'Late', num: true, fmt: F.hrsFromMin }, { key: 'mealSkip', label: 'Skipped meal', num: true, fmt: F.hrsFromMin }, { key: 'otDrift', label: 'OT drift $', num: true, fmt: F.money }],
      paidHrs: [{ key: 'paidHrs', label: 'Paid hours', num: true, fmt: F.hrs }, { key: 'days', label: 'Days', num: true, fmt: F.n }],
      cost: [{ key: 'grossAdd', label: 'Additional cost', num: true, fmt: F.money, bar: '--c-late', title: 'Non-overlapping: early + late + unscheduled + skipped meals + OT premium' }, { key: 'avoid', label: 'Avoidable', num: true, fmt: F.money }, { key: 'mainIssue', label: 'Main cost driver' },
        { key: 'patternCount', label: 'Recurring patterns', num: true, fmt: (v, r) => (v ? `${F.n(v)}<span class="sub">${esc((r.patternCats || []).join(', '))}</span>` : '—') }, { key: 'paidHrs', label: 'Paid hours', num: true, fmt: F.hrs }, { key: 'lastDeviation', label: 'Last deviation', fmt: (v) => (v ? F.date(v) : '—') }],
      manual: [{ key: 'manN', label: 'Manual punches', num: true, fmt: F.n, bar: '--c-unsch' }, { key: 'manMin', label: 'Manual hours', num: true, fmt: F.hrsFromMin }, { key: 'manWeeks', label: 'Weeks', num: true, fmt: F.n }, { key: 'manPay', label: 'Pay on manual time', num: true, fmt: F.money }, { key: 'manAvoid', label: 'Avoidable (review)', num: true, fmt: F.money }],
      devTypes: [{ key: 'devTypes', label: 'Recurring patterns', num: true, fmt: F.n, bar: '--c-late' }, { key: 'pat', label: 'Which', val: (r) => patterns(r).join(' '), fmt: (v, r) => patterns(r).map((x) => `<span class="tag">${esc(x)}</span>`).join(' ') }, { key: 'avoid', label: 'Avoidable $', num: true, fmt: F.money }],
    };
    return base.concat(m[key] || m.avoid);
  }
  function editorCols() {
    return [{ key: 'display', label: 'Editor', fmt: (v, r) => esc(v) + (r.kind === 'storeAccount' ? ' <span class="tag vld">shared login</span>' : '') }, { key: 'rows', label: 'Edits', num: true, fmt: F.n },
      { key: 'self', label: 'On own punches', num: true, fmt: F.n, bar: '--c-late' }, { key: 'storeCount', label: 'Stores', num: true, fmt: F.n }, { key: 'empCount', label: 'Employees', num: true, fmt: F.n },
      { key: 'manualCreate', label: 'Punches keyed in', num: true, fmt: F.n }, { key: 'addMin', label: 'Time added', num: true, fmt: F.hrsFromMin }, { key: 'remMin', label: 'Time removed', num: true, fmt: F.hrsFromMin }];
  }

  async function renderDrill(host, R, d) {
    if (!d) { host.innerHTML = ''; return; }
    if (d.type === 'patterns') {
      if (R.behavior) G.LCIViews.patternTable(host, R, R.behavior.patterns.filter((p) => p.cat === d.cat), { pageSize: 15 });
    } else if (d.type === 'storeConc') {
      UI.table(host, { rows: (R.behavior || {}).storeConc || [], sortKey: 'cost', pageSize: 15, onRow: (r) => G.App.go('stores', { s: r.store }), cols: [{ key: 'storeName', label: 'Store' }, { key: 'label', label: 'Pattern' }, { key: 'emps', label: 'Employees', num: true, fmt: (v, r) => `${F.n(v)} of ${F.n(r.active)}` }, { key: 'share', label: 'Share of staff', num: true, fmt: (v) => F.pct(v, 0) }, { key: 'cost', label: '$ impact', num: true, fmt: F.money, bar: '--c-late' }] });
    } else if (d.type === 'laborRank') {
      if (R.sales.available && R.sales.laborRank) G.LCIViews.laborTable(host, R, 15); else host.innerHTML = '<div class="note">No Labor % ranking for this selection.</div>';
    } else if (d.type === 'stores' && d.key === 'trend') {
      const ex = d.extra || {};
      const delta = (v) => (F.ok(v) ? `<span class="tag ${v > 0 ? 'risk' : 'good'}">${v > 0 ? '+' : '−'}${dollars(Math.abs(v))}</span>` : '—');
      UI.table(host, { rows: drillStores(R, d.rows), pageSize: 15, placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }), cols: [{ key: 'name', label: 'Store' },
        { key: 'a', label: 'First half $/paid h', num: true, val: (r) => (ex[r.s] || {}).a, fmt: dollars }, { key: 'b', label: 'Second half $/paid h', num: true, val: (r) => (ex[r.s] || {}).b, fmt: dollars },
        { key: 'd', label: 'Change', num: true, val: (r) => (ex[r.s] || {}).d, fmt: delta }, { key: 'overPlanPct', label: '% above plan', num: true, fmt: (v) => F.pct(v) }] });
    } else if (d.type === 'stores') {
      UI.table(host, { rows: drillStores(R, d.rows), cols: storeCols(d.key), pageSize: 15, placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }) });
    } else if (d.type === 'employees') {
      const set = new Set(d.rows);
      const rows = R.employees.filter((e) => set.has(e.g)).sort((a, b) => d.rows.indexOf(a.g) - d.rows.indexOf(b.g));
      UI.table(host, { rows, cols: empCols(d.key), pageSize: 15, placeholder: 'Search name or GEID', onRow: (r) => G.App.go('employees', { g: r.g }) });
    } else if (d.type === 'editors') {
      const set = new Set(d.rows);
      UI.table(host, { rows: R.integrity.editors.filter((e) => set.has(e.key)), cols: editorCols(), sortKey: d.key, pageSize: 15, placeholder: 'Search editors' });
    } else if (d.type === 'storeMonths') {
      host.innerHTML = '<div class="note">Loading…</div>';
      const rows = await G.App.query({ type: 'storeMonths', rows: d.rows });
      UI.table(host, { search: false, rows, cols: [{ key: 'name', label: 'Store' }, { key: 'month', label: 'Month', fmt: (v) => F.monthLabel(v) }, { key: 'fs', label: 'Forecast sales', num: true, fmt: F.money },
        { key: 'as', label: 'Actual sales', num: true, fmt: F.money }, { key: 'ach', label: 'Achievement', num: true, fmt: (v) => F.pct(v) }, { key: 'hrs', label: 'Paid hours', num: true, fmt: F.hrs }] });
    } else if (d.type === 'records' && d.key === 'longPunches') {
      host.innerHTML = '<div class="note">Loading…</div>';
      const rows = await G.App.query({ type: 'records', key: 'longPunches' });
      UI.table(host, { rows, pageSize: 15, placeholder: 'Search', cols: [{ key: 'name', label: 'Employee', fmt: (v, r) => `${esc(v)}<span class="sub">GEID ${esc(r.g)}</span>` }, { key: 'store', label: 'Store' }, { key: 'date', label: 'Date' },
        { key: 'in', label: 'Clock in' }, { key: 'out', label: 'Clock out' }, { key: 'hours', label: 'Paid hours', num: true, fmt: F.n1 }, { key: 'pay', label: 'Pay', num: true, fmt: F.money }, { key: 'src', label: 'Source' }], onRow: (r) => G.App.go('employees', { g: r.g }) });
    } else if (d.type === 'records' && d.key === 'rateOutliers') {
      host.innerHTML = '<div class="note">Loading…</div>';
      const rows = await G.App.query({ type: 'records', key: 'rateOutliers' });
      UI.table(host, { rows, pageSize: 15, placeholder: 'Search', onRow: (r) => G.App.go('employees', { g: r.g }), cols: [{ key: 'name', label: 'Employee', fmt: (v, r) => `${esc(v)}<span class="sub">GEID ${esc(r.g)} · ${esc(r.job)}</span>` },
        { key: 'store', label: 'Store' }, { key: 'date', label: 'Date' }, { key: 'rate', label: 'Rate on punch', num: true, fmt: dollars }, { key: 'normal', label: 'Usual rate', num: true, fmt: dollars },
        { key: 'hours', label: 'Hours', num: true, fmt: F.n1 }, { key: 'pay', label: 'Pay', num: true, fmt: F.money, bar: '--c-late' }, { key: 'src', label: 'Source' }] });
    } else if (d.type === 'records' && d.key === 'spikes') {
      host.innerHTML = '<div class="note">Loading…</div>';
      const rows = await G.App.query({ type: 'records', key: 'spikes' });
      UI.table(host, { rows, pageSize: 15, cols: [{ key: 'date', label: 'Date' }, { key: 'store', label: 'Store' }, { key: 'edits', label: 'Edits that day', num: true, fmt: F.n, bar: '--c-unsch' }] });
    }
  }

  function findingCard(i, n) {
    const imp = i.impact || {};
    return `<article class="fcard sev-${i.severity}" id="fd-${esc(i.id)}">
      <button class="fhead" aria-expanded="false">
        <div><div class="ft">${n}. ${esc(i.title)}</div>
          <div class="fm"><span class="sev s-${i.severity}">${i.severity}</span>${F.kindTag(i.kind)}<span class="tag">Confidence: ${esc(i.confidence)}</span><span class="tag">${esc(i.category)}</span>${i.recurrence ? `<span class="tag">${esc(i.recurrence)}</span>` : ''}</div></div>
        <div class="fi">${F.ok(imp.cost) && imp.cost ? F.moneyK(imp.cost) : F.ok(imp.hours) && imp.hours ? F.hrsK(imp.hours) : ''}<small>${esc(imp.label || '')}</small></div>
      </button>
      <div class="fbody" hidden>
        <div class="fgrid">
          <div><div class="q">What happened</div><p>${esc(i.what)}</p></div>
          <div><div class="q">Where</div><p>${esc(i.where)}</p></div>
          <div><div class="q">Why it matters</div><p>${esc(i.why)}</p></div>
          <div><div class="q">Evidence</div><ul>${(i.evidence || []).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>
          <div class="fact"><div class="q">What to do</div><p>${esc(i.action)}</p><div class="fbasis">Owner: ${esc(i.plan.owner)} · ${esc(i.plan.horizon)}</div></div>
          <div><div class="q">Potential impact</div><p>${esc(imp.label || '—')}</p><div class="fbasis">Basis: ${esc(imp.basis || '—')}</div></div>
        </div>
        <h4 style="margin-top:16px">Supporting records</h4>
        <div class="drill"></div>
      </div>
    </article>`;
  }

  VIEWS.findings = function (el, R, params) {
    const cats = [...new Set(R.insights.map((i) => i.category))];
    const st = { sev: new Set(SEV), kind: new Set(Object.keys(KIND)), cat: 'All', q: '' };
    el.innerHTML = `<h2>${esc(G.LCIViews.scopeTitle(R, 'Labor cost findings'))}</h2>
      <p class="lead">Each finding is computed only from the selected stores and dates, and states what happened, where, why it matters, the evidence, the action and the impact. <b>Confirmed</b> = direct record counts; <b>Estimate</b> = $ derived with the stated basis; <b>Risk</b> = control or compliance exposure without a $ claim; <b>Needs validation</b> = a pattern to review before acting.</p>
      <div class="controls"><div class="chips" id="fSev">${SEV.map((s) => `<button class="chip" aria-pressed="true" data-v="${s}">${s}<span class="n">${R.insights.filter((i) => i.severity === s).length}</span></button>`).join('')}</div>
        <div class="chips" id="fKind">${Object.entries(KIND).map(([k, v]) => `<button class="chip" aria-pressed="true" data-v="${k}">${v}<span class="n">${R.insights.filter((i) => i.kind === k).length}</span></button>`).join('')}</div></div>
      <div class="controls"><label>Area <select id="fCat"><option>All</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label><input type="search" id="fQ" placeholder="Search findings" aria-label="Search findings"></div>
      <div class="flist" id="fList"></div>`;
    const list = UI.$('#fList', el);
    function draw() {
      const rows = R.insights.filter((i) => st.sev.has(i.severity) && st.kind.has(i.kind) && (st.cat === 'All' || i.category === st.cat) &&
        (!st.q || (i.title + ' ' + i.what + ' ' + i.where).toLowerCase().includes(st.q)));
      list.innerHTML = rows.length ? rows.map((i) => findingCard(i, R.insights.indexOf(i) + 1)).join('') : '<div class="empty panel">No findings match these filters.</div>';
      UI.$$('.fcard', list).forEach((card) => {
        const id = card.id.slice(3), ins = R.insights.find((x) => x.id === id);
        const head = card.querySelector('.fhead'), body = card.querySelector('.fbody');
        let loaded = false;
        head.addEventListener('click', () => {
          const open = body.hidden;
          body.hidden = !open; head.setAttribute('aria-expanded', String(open));
          if (open && !loaded) { loaded = true; renderDrill(card.querySelector('.drill'), R, ins.drill).catch((e) => { card.querySelector('.drill').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }); }
        });
      });
    }
    const chipSet = (host, set) => UI.$$('.chip', host).forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.v; if (set.has(v)) set.delete(v); else set.add(v);
      b.setAttribute('aria-pressed', String(set.has(v))); draw();
    }));
    chipSet(UI.$('#fSev', el), st.sev); chipSet(UI.$('#fKind', el), st.kind);
    UI.$('#fCat', el).addEventListener('change', (e) => { st.cat = e.target.value; draw(); });
    UI.$('#fQ', el).addEventListener('input', (e) => { st.q = e.target.value.trim().toLowerCase(); draw(); });
    draw();
    if (!R.insights.length) list.innerHTML = '<div class="empty panel">No findings for this selection — there may be too little data in the chosen stores and dates.</div>';
    if (params && params.open) {
      const card = UI.$('#fd-' + CSS.escape(params.open), el);
      if (card) { card.querySelector('.fhead').click(); setTimeout(() => card.scrollIntoView({ block: 'start' }), 30); }
    }
  };

  // ===================== ACTION PLAN =====================
  VIEWS.actions = function (el, R) {
    const groups = {};
    R.actions.forEach((a, i) => (groups[a.plan.group] = groups[a.plan.group] || []).push(Object.assign({ n: i + 1 }, a)));
    const order = ['Clock settings', 'Scheduling', 'Process & review', 'Data fixes', 'Technology'];
    const keys = Object.keys(groups).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const Fi = R.financials;
    el.innerHTML = `<h2>${esc(G.LCIViews.scopeTitle(R, 'Action plan'))}</h2>
      <p class="lead">Recommendations for the selected stores and dates, ordered by severity and impact and grouped by who acts. Clock settings refer to controls the time clock already supports (manager authorisation windows, auto-close, meal rules). Estimated avoidable cost: <b>${F.money(Fi.avoidCost)}</b> (${F.pct(Fi.avoidPct)} of labor) — an estimate requiring operational validation, not realised savings.</p>
      <div class="stack">${keys.map((k) => `<div class="panel"><h3>${esc(k)}</h3><div class="actions">${groups[k].map((a) => `
        <div class="act"><div class="no ${a.severity}">${a.n}</div>
          <div><div class="cmd">${esc(a.action)}</div><div class="why">Because: <button class="ilink" style="font-weight:500" data-id="${esc(a.id)}">${esc(a.title)}</button></div>
            <div class="meta"><span class="sev s-${a.severity}">${a.severity}</span>${F.kindTag(a.kind)}<span class="tag">Owner: ${esc(a.plan.owner)}</span><span class="tag">${esc(a.plan.horizon)}</span><span class="tag">Confidence: ${esc(a.confidence)}</span></div></div>
          <div class="val">${a.impact && F.ok(a.impact.cost) && a.impact.cost ? F.moneyK(a.impact.cost) : ''}<small>${esc(a.impact ? a.impact.label : '')}</small></div></div>`).join('')}</div></div>`).join('') || '<div class="empty panel">No recommendations for this selection.</div>'}</div>`;
    UI.$$('.ilink', el).forEach((b) => b.addEventListener('click', () => G.App.go('findings', { open: b.dataset.id })));
  };

  const scopeTitle = (R, base) => { const sc = R.meta.scope; return sc && sc.kind !== 'org' ? `${base} — ${sc.storeLabel}` : base; };
  G.LCIViews = Object.assign(G.LCIViews || {}, { storeCols, empCols, editorCols, storeName, scopeTitle, patterns });
})(window);
