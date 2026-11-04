/* views-new.js — Labor % ranking and Manual punches. */
(function (G) {
  const F = G.FMT, UI = G.UI, esc = F.esc;
  const VIEWS = (G.VIEWS = G.VIEWS || {});
  const sn = (R, s) => (R.meta.storeNames && R.meta.storeNames[s]) || s;
  const ST = { 'Unusually high': 'uh', High: 'hi', 'Near average': 'av', Low: 'lo' };
  const pts = (v) => (F.ok(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(1) + ' pts' : '—');

  /** Ranking table (also used as the drill-down of the Labor % finding). */
  function laborTable(host, R, pageSize) {
    const LR = R.sales.laborRank;
    const rows = LR.rows.map((r) => Object.assign({ name: sn(R, r.s) }, r));
    UI.table(host, {
      rows, sortKey: 'rank', desc: false, pageSize: pageSize || 50, placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }),
      cols: [
        { key: 'rank', label: 'Rank', num: true, fmt: F.n },
        { key: 'name', label: 'Store' },
        { key: 'laborPct', label: 'Labor %', num: true, fmt: (v) => F.pct(v), bar: '--c-late', title: 'Punch pay ÷ actual sales, complete months only' },
        { key: 'diff', label: 'vs average', num: true, fmt: (v) => `<span style="color:${v > 0.02 ? 'var(--crit)' : v < -0.02 ? 'var(--ok)' : 'inherit'}">${pts(v)}</span>`, title: `Difference from the average of ${F.pct(LR.orgPct)} (total pay ÷ total sales of ranked stores)` },
        { key: 'status', label: 'Status', fmt: (v) => `<span class="rankst ${ST[v] || 'av'}">${esc(v)}</span>` },
        { key: 'pay', label: 'Labor $', num: true, fmt: F.moneyK },
        { key: 'sales', label: 'Sales', num: true, fmt: F.moneyK },
        { key: 'prev', label: 'Previous period', num: true, fmt: (v) => (v == null ? '—' : F.pct(v)), title: LR.prevMonths.length ? 'Same number of complete months immediately before: ' + LR.prevMonths.join(', ') : 'No previous comparable period in the data' },
        { key: 'change', label: 'Change', num: true, fmt: (v) => (v == null ? '—' : `<span style="color:${v > 0.005 ? 'var(--crit)' : v < -0.005 ? 'var(--ok)' : 'inherit'}">${pts(v)}</span>`) },
      ],
    });
  }

  VIEWS.laborrank = function (el, R) {
    const S = R.sales;
    el.innerHTML = `<h2>${esc(G.LCIViews.scopeTitle(R, 'Labor % ranking'))}</h2>`;
    if (!S.available) { el.innerHTML += `<div class="msg warn">${esc(S.reason || 'No sales data for this selection.')}</div>`; return; }
    const LR = S.laborRank;
    const monthsTxt = LR.months.map((k) => F.monthLabel(k)).join(', ');
    if (!LR.rows.length) { el.innerHTML += `<div class="msg warn">No store has complete sales for ${esc(monthsTxt)}, so Labor % cannot be ranked reliably.</div>`; return; }
    if (LR.rows.length === 1) {
      const r = LR.rows[0];
      el.innerHTML += `<p class="lead">Actual Labor % for ${esc(sn(R, r.s))}, ${esc(monthsTxt)}. A ranking compares stores — switch to Organization (or select several stores) to see where this store sits.</p>
        <div class="kpis k3">${UI.kpi({ label: 'Labor %', value: F.pct(r.laborPct), sub: `${F.money(r.pay)} labor ÷ ${F.money(r.sales)} sales`, cls: 'accent' })}
        ${UI.kpi({ label: 'Previous comparable period', value: r.prev == null ? '—' : F.pct(r.prev), sub: r.change == null ? 'Not available' : pts(r.change) + ' change' })}
        ${UI.kpi({ label: 'Months used', value: F.n(LR.months.length), sub: LR.partialMonths.length ? `${LR.partialMonths.map(F.monthShort).join(', ')} excluded (partial)` : 'Complete months only' })}</div>
        <div class="row" style="margin-top:14px"><button class="btn primary" id="lrOrg">Compare with all stores</button></div>`;
      UI.$('#lrOrg', el).addEventListener('click', () => G.App.applyFilter(Object.assign({}, G.App.filter, { stores: null })));
      return;
    }
    const inc = LR.biggestIncrease.filter((r) => r.change > 0)[0];
    el.innerHTML += `<p class="lead">Stores ranked from highest to lowest <b>actual</b> Labor % (punch pay ÷ actual sales) for ${esc(monthsTxt)}. Sales are monthly, so only complete months are used${LR.partialMonths.length ? ` — ${esc(LR.partialMonths.map(F.monthLabel).join(', '))} ${LR.partialMonths.length > 1 ? 'are' : 'is'} only partly selected and excluded` : ''}. Click a store for its detail.</p>
      <div class="stack">
        <div class="kpis k5">
          ${UI.kpi({ label: 'Average Labor %', value: F.pct(LR.orgPct), sub: `${F.n(LR.rows.length)} ranked stores · total pay ÷ total sales`, cls: 'accent', title: 'Sum of labor $ ÷ sum of actual sales across ranked stores' })}
          ${UI.kpi({ label: 'Highest', value: F.pct(LR.highest.laborPct), sub: `${esc(sn(R, LR.highest.s))} · ${pts(LR.highest.diff)}`, cls: 'bad' })}
          ${UI.kpi({ label: 'Lowest', value: F.pct(LR.lowest.laborPct), sub: `${esc(sn(R, LR.lowest.s))} · ${pts(LR.lowest.diff)}` })}
          ${UI.kpi({ label: 'Stores above average', value: F.n(LR.aboveAvg), sub: `${F.n(LR.rows.filter((r) => r.status === 'Unusually high').length)} unusually high`, cls: 'warn', title: 'Unusually high = 5+ points above average or 1.5 standard deviations' })}
          ${UI.kpi({ label: 'Largest increase', value: inc ? pts(inc.change) : '—', sub: inc ? `${esc(sn(R, inc.s))} vs ${LR.prevMonths.map(F.monthShort).join(', ')}` : LR.prevMonths.length ? 'No store increased' : 'No previous comparable period' })}
        </div>
        <div class="panel"><h3>Ranking — highest to lowest</h3><div id="lrT"></div></div>
        ${LR.notRanked.length ? `<div class="panel"><h3>Not ranked</h3><p class="note" style="margin-top:-4px">Labor % is not calculated where sales are incomplete — it would not be comparable.</p><div id="lrN"></div></div>` : ''}
      </div>`;
    laborTable(UI.$('#lrT', el), R, 60);
    if (LR.notRanked.length) UI.table(UI.$('#lrN', el), { search: false, rows: LR.notRanked.map((x) => Object.assign({ name: sn(R, x.s) }, x)), cols: [{ key: 'name', label: 'Store' }, { key: 'reason', label: 'Reason' }] });
  };

  VIEWS.manual = function (el, R) {
    const M = R.financials.manual || {}, I = R.integrity, t = R.adherence.tot;
    el.innerHTML = `<h2>${esc(G.LCIViews.scopeTitle(R, 'Manual punches'))}</h2>
      <p class="lead">A manual punch is a paid punch entered by a manager in the timecard (punch source <b>MANUAL</b>) instead of being captured by the clock. PIN/password and other device punches are clock punches, not manual. Many manual punches are legitimate corrections — this view shows where they concentrate and how much of the extra paid time came through them.</p>`;
    if (!M.n) { el.innerHTML += '<div class="empty panel">No manual punches in this selection.</div>'; return; }
    const ms = R.meta.months;
    const recurring = R.employees.filter((e) => e.recurringManual).length;
    el.innerHTML += `<div class="stack">
      <div class="kpis k5">
        ${UI.kpi({ label: 'Additional pay via manual punches', value: F.money(M.extraCost), sub: `${F.n(M.n)} manual punches · ${F.pct(M.n / Math.max(1, I.tot.punches))} of paid punches`, cls: 'accent', title: 'Cost of early-start, late-finish and unscheduled time recorded through manual punches — overlaps those categories' })}
        ${UI.kpi({ label: 'Manual hours', value: F.hrsK(M.min / 60), sub: `${F.pct(M.share)} of paid hours · ${F.moneyK(M.pay)} pay`, title: 'Paid hours on punches with source MANUAL' })}
        ${UI.kpi({ label: 'Employees · stores', value: `${F.n(M.emps)} · ${F.n(M.stores)}`, sub: `${F.n(recurring)} employees in ${R.rules.recurringWeeks.value}+ weeks` })}
        ${UI.kpi({ label: 'Extra time entered manually', value: F.hrsK((M.early + M.late + M.unsch) / 60), sub: `early ${F.hrsK(M.early / 60)} · late ${F.hrsK(M.late / 60)} · unscheduled ${F.hrsK(M.unsch / 60)}`, cls: 'warn', title: 'Time outside the schedule recorded through manual punches — overlaps the early/late/unscheduled totals' })}
        ${UI.kpi({ label: 'Avoidable, needs review', value: F.moneyK(M.avoidCost), sub: `of ${F.moneyK(M.beyondTolCost)} beyond tolerance · inside the avoidable total`, cls: 'bad', title: 'Early/late minutes beyond the punch tolerance on manual punches × rate, capped at store-day labor above plan. Not added to other totals.' })}
      </div>
      <div class="grid2">
        <div class="panel"><h3>Share of paid hours entered manually, by month</h3>${UI.legend([{ label: 'Manual share of paid hours', color: '--c-unsch' }])}<div class="chartbox sm"><canvas id="mnM"></canvas></div></div>
        <div class="panel"><h3>How much it costs and how it overlaps</h3><dl class="dash">
          <dt>Pay on manual time</dt><dd>${F.money(M.pay)} (exposure — not a loss)</dd>
          <dt>Early starts via manual punch</dt><dd>${F.hrsFromMin(M.early)}</dd>
          <dt>Late finishes via manual punch</dt><dd>${F.hrsFromMin(M.late)}</dd>
          <dt>Unscheduled manual shifts</dt><dd>${F.hrsFromMin(M.unsch)}</dd>
          <dt>Beyond the ${R.rules.punchTolerance.value}-min tolerance</dt><dd>${F.hrsFromMin(M.beyondTolMin)} · ${F.money(M.beyondTolCost)}</dd>
          <dt>Avoidable after netting (review)</dt><dd>${F.hrsFromMin(M.avoidMin)} · ${F.money(M.avoidCost)}</dd>
          <dt>Manual punches edited afterwards</dt><dd>${F.n(M.edited)} · +${F.hrsFromMin(M.editAddMin)} / −${F.hrsFromMin(M.editRemMin)}</dd>
          ${I.hasAudit && I.manual.withLag ? `<dt>Entered more than ${R.rules.retroLag.value} min late</dt><dd>${F.pct(I.manual.retro / I.manual.withLag, 0)} of manual entries (median ${F.n1(I.manual.medianLag / 60)} h)</dd>` : ''}
        </dl><p class="note">These figures are a view of the early, late and unscheduled time already counted elsewhere — they are never added to them.</p></div>
      </div>
      ${R.stores.length > 1 ? '<div class="panel"><h3>Stores with the most manual punches</h3><div id="mnS"></div></div>' : ''}
      <div class="panel"><h3>Employees with manual punches</h3><div id="mnE"></div></div>
    </div>`;
    UI.chart(UI.$('#mnM', el), { type: 'line', labels: ms.map((m) => F.monthShort(m.key)), series: [{ label: 'Manual share', type: 'line', color: '--c-unsch', data: ms.map((m) => { const a = R.adherence.byMonth[m.key]; return a && a.act ? (a.manMin / a.act) * 100 : null; }) }], fmtY: (v) => F.n1(v) + '%', beginAtZero: true });
    if (R.stores.length > 1) UI.table(UI.$('#mnS', el), { rows: R.stores.filter((s) => s.manN > 0), sortKey: 'manMin', pageSize: 20, placeholder: 'Search stores', onRow: (r) => G.App.go('stores', { s: r.s }), cols: G.LCIViews.storeCols('manual') });
    UI.table(UI.$('#mnE', el), { rows: R.employees.filter((e) => e.manN > 0), sortKey: 'manMin', pageSize: 20, placeholder: 'Search name or GEID', onRow: (r) => G.App.go('employees', { g: r.g }),
      cols: G.LCIViews.empCols('manual').concat([{ key: 'recurringManual', label: 'Recurring', val: (r) => (r.recurringManual ? 1 : 0), fmt: (v) => (v ? '<span class="tag vld">recurring</span>' : '') }]) });
  };

  G.LCIViews = Object.assign(G.LCIViews || {}, { laborTable });
})(window);
