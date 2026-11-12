/*
 * views-focus.js — problem-specific ("contextual") drill-down: Problem → Store → Employee, showing only that
 * problem's records. Two entry points share it:
 *   - a finding:      params { f: findingId, s?, g? }            breadcrumb Organization / Findings / …
 *   - an Explore page: params { x: viewId, lens, s?, g? }         breadcrumb Organization / Explore / … (or Stores / Store …)
 * The generic Stores and Employees pages are separate (views-explore.js) and never inherit this context.
 */
(function (G) {
  const F = G.FMT, UI = G.UI, esc = F.esc;
  const VIEWS = (G.VIEWS = G.VIEWS || {});

  // Labels per lens (mirrors js/engine/focus.js) and what the headline dollar figure means for each.
  const LENS = {
    overplan: { label: 'Paid hours above schedule', title: 'Schedule vs Actual', money: 'Additional labor cost above schedule', moneyKind: 'Estimate', metric: 'Hours above schedule' },
    unsch: { label: 'Unscheduled shifts', title: 'Unscheduled Shift Analysis', money: 'Pay for unscheduled time', moneyKind: 'Recorded pay', metric: 'Unscheduled hours' },
    early: { label: 'Early clock-ins', title: 'Early Clock-In Analysis', money: 'Additional pay from early clock-ins', moneyKind: 'Estimate', metric: 'Early clock-in time' },
    late: { label: 'Late clock-outs', title: 'Late Clock-Out Analysis', money: 'Additional pay from late clock-outs', moneyKind: 'Estimate', metric: 'Late clock-out time' },
    meal: { label: 'Meal breaks', title: 'Meal Break Analysis', money: 'Pay for planned meals worked through', moneyKind: 'Estimate', metric: 'Planned meal worked' },
    ot: { label: 'Overtime', title: 'Overtime Analysis', money: 'Recorded overtime premium', moneyKind: 'Recorded', metric: 'Overtime hours' },
    manual: { label: 'Manual punches', title: 'Manual Punch Analysis', money: 'Additional pay recorded through manual punches', moneyKind: 'Estimate', metric: 'Manual punch hours' },
    edits: { label: 'Punch edits', title: 'Punch Edit Analysis', money: 'Net paid time added by edits', moneyKind: 'Estimate', metric: 'Paid time added' },
    long: { label: 'Forgotten clock-outs (14 h+ punches)', title: 'Long Punch Analysis', money: null, metric: 'Paid hours', noMoney: 'Not costed: a 14 h+ punch is usually a missed clock-out, so its pay is a correction risk rather than a confirmed loss.' },
    minor: { label: 'Minors not flagged as minors', title: 'Minor Compliance Analysis', money: null, metric: 'Paid hours', noMoney: 'Not costed: this is a compliance exposure. The data has no fine or penalty amounts, so no dollar figure is claimed.' },
    payrollid: { label: 'Punches without Payroll ID', title: 'Payroll ID Analysis', money: 'Pay on punches without Payroll ID', moneyKind: 'Recorded pay (at risk)', metric: 'Paid hours' },
    rate: { label: 'Pay-rate anomalies', title: 'Pay Rate Anomaly Analysis', money: 'Pay above the employee\'s usual rate', moneyKind: 'Estimate', metric: 'Paid hours' },
    avoid: { label: 'Estimated avoidable cost', title: 'Avoidable Cost Analysis', money: 'Estimated avoidable cost', moneyKind: 'Estimate', metric: 'Avoidable time' },
    labor: { label: 'Labor cost and Labor %', title: 'Sales & Labor Analysis', money: 'Recorded labor cost', moneyKind: 'Recorded', metric: 'Paid hours' },
  };
  // Explore pages that open this drill-down, and their sidebar labels.
  const EXPLORE = { manual: 'Manual punches', adherence: 'Schedule vs actual', overtime: 'Overtime', integrity: 'Punch integrity', compliance: 'Breaks & compliance', sales: 'Sales & labor', laborrank: 'Labor % ranking', behavior: 'Employee behavior', trends: 'Monthly trends' };
  const unitWord = (u, n) => ({ days: n === 1 ? 'day' : 'days', weeks: n === 1 ? 'week' : 'weeks', edits: n === 1 ? 'edit' : 'edits', punches: n === 1 ? 'punch' : 'punches' }[u] || u);
  const hm = (m) => (F.ok(m) ? F.minHM(m) : '—');
  const dateCell = (r) => `${F.date(r.date)}<span class="sub">${esc(r.dow || '')}</span>`;

  /** Record columns for each kind of lens. */
  function recordCols(d, withEmp) {
    const L = LENS[d.lens];
    const emp = withEmp ? [{ key: 'empName', label: 'Employee', text: (r) => r.empName + ' ' + r.g, fmt: (v, r) => `${esc(v)}<span class="sub">GEID ${esc(r.g)}</span>` }] : [];
    const money = L.money ? [{ key: 'cost', label: '$ impact', num: true, fmt: (v) => F.money(v), bar: '--c-late' }] : [];
    const issue = [{ key: 'issue', label: 'What happened', fmt: (v) => `<span class="note">${esc(v)}</span>` }];
    if (d.lens === 'ot') return emp.concat([{ key: 'day', label: 'Week of', val: (r) => r.day, fmt: (v, r) => F.date(r.date) }], money, [{ key: 'premDrift', label: 'From working past schedule', num: true, fmt: F.money }, { key: 'schMin', label: 'Scheduled', num: true, fmt: hm },
      { key: 'actMin', label: 'Paid', num: true, fmt: hm }, { key: 'min', label: 'Overtime', num: true, fmt: hm }], issue);
    if (d.lens === 'edits') return emp.concat([{ key: 'day', label: 'Date', val: (r) => r.day, fmt: (v, r) => dateCell(r) }], money, [{ key: 'clockIn', label: 'Original in', fmt: (v) => esc(v.slice(5)) }, { key: 'clockOut', label: 'Original out', fmt: (v) => esc(v.slice(5)) },
      { key: 'adjIn', label: 'Adjusted in', fmt: (v) => esc((v || '').slice(5)) }, { key: 'adjOut', label: 'Adjusted out', fmt: (v) => esc((v || '').slice(5)) }, { key: 'min', label: 'Paid time change', num: true, fmt: (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + F.minHM(Math.abs(v)) }], issue);
    if (['long', 'minor', 'payrollid', 'rate'].includes(d.lens)) return emp.concat([{ key: 'day', label: 'Date', val: (r) => r.day, fmt: (v, r) => dateCell(r) }], money.length ? money : [{ key: 'pay', label: 'Pay', num: true, fmt: F.money }], [{ key: 'clockIn', label: 'Clock-in', fmt: (v) => esc(v.slice(11)) },
      { key: 'clockOut', label: 'Clock-out', fmt: (v) => esc(v.slice(5)) }, { key: 'min', label: 'Paid hours', num: true, fmt: hm }], issue);
    const keyed = d.lens === 'manual' ? [{ key: 'keyed', label: 'Keyed in manually', fmt: (v) => esc(v || '—') }] : [];
    return emp.concat([{ key: 'day', label: 'Business date', val: (r) => r.day, fmt: (v, r) => dateCell(r) }], money, [
      { key: 'schedStart', label: 'Sched. start', fmt: (v) => esc(v || '—') }, { key: 'schedEnd', label: 'Sched. end', fmt: (v) => esc(v || '—') },
      { key: 'clockIn', label: 'Clock-in', fmt: (v) => esc(v || '—') }, { key: 'clockOut', label: 'Clock-out', fmt: (v) => esc(v || '—') }], keyed, [
      { key: 'schMin', label: 'Sched. hours', num: true, fmt: hm }, { key: 'actMin', label: 'Paid hours', num: true, fmt: hm },
      { key: 'min', label: L.metric, num: true, fmt: hm }], issue);
  }

  /** Parameters that carry the context from level to level. */
  const ctxOf = (p) => (p.f ? { f: p.f } : { x: p.x, lens: p.lens });

  function crumbs(el, R, p, d) {
    const ins = p.f ? R.insights.find((i) => i.id === p.f) : null;
    const C = ctxOf(p);
    const parts = [{ t: 'Organization', go: () => G.App.go('overview', {}) }];
    if (p.f) {
      parts.push({ t: 'Findings', go: () => G.App.go('findings', {}) });
      parts.push({ t: LENS[d.lens].label, go: ins ? () => G.App.go('findings', { open: ins.id }) : () => G.App.go('focus', C) });
    } else if (p.x === 'stores') {
      parts.push({ t: 'Stores', go: () => G.App.go('stores', {}) });
      if (p.s) parts.push({ t: 'Store ' + (d.storeName || p.s), go: () => G.App.go('stores', { s: p.s }) });
      parts.push({ t: LENS[d.lens].label, go: p.g ? () => G.App.go('focus', Object.assign({}, C, { s: p.s })) : null });
      if (p.g) parts.push({ t: (d.name || p.g) + ' · GEID ' + p.g, go: null });
      return draw(parts);
    } else {
      parts.push({ t: 'Explore', go: null });
      parts.push({ t: EXPLORE[p.x] || LENS[d.lens].label, go: () => G.App.go(p.x, {}) });
    }
    if (p.s) parts.push({ t: 'Store ' + (d.storeName || p.s), go: p.g ? () => G.App.go('focus', Object.assign({}, C, { s: p.s })) : null });
    else if (!p.g && p.f) parts[parts.length - 1].go = null;
    if (p.g) parts.push({ t: (d.name || p.g) + ' · GEID ' + p.g, go: null });
    draw(parts);
    function draw(list) {
      const nav = UI.$('.crumb', el);
      nav.innerHTML = list.map((x, i) => (x.go && i < list.length - 1 ? `<button data-i="${i}">${esc(x.t)}</button>` : `<span class="${i === list.length - 1 ? 'cur' : 'crx'}">${esc(x.t)}</span>`)).join('<span class="sep">/</span>');
      UI.$$('button', nav).forEach((b) => b.addEventListener('click', () => list[+b.dataset.i].go()));
    }
  }

  /** Lens-specific supporting panel (only figures belonging to this problem). */
  function extrasPanel(d, R, sm) {
    const x = d.extras;
    if (!x) return '';
    const li = (t) => `<li>${t}</li>`;
    let items = [];
    if (d.lens === 'manual') {
      const keyedDays = x.inOnly + x.outOnly + x.both;
      items = [
        li(`<b>${F.n(x.punches)}</b> manual punches on <b>${F.n(x.days)}</b> of ${F.n(x.workDays)} working days (<b>${F.pct(x.days / Math.max(1, x.workDays), 0)}</b> of days)`),
        keyedDays ? li(`Keyed in: clock-in only <b>${F.n(x.inOnly)}</b> days · clock-out only <b>${F.n(x.outOnly)}</b> · both <b>${F.n(x.both)}</b> (from the punch audit log)`) : li('The punch audit log has no clock-in / clock-out detail for these manual punches.'),
        keyedDays ? li(`<b>${F.n(x.enteredLate)}</b> days had a manual entry made more than ${F.n(x.retroLag)} min after the time it records`) : '',
        d.level === 'store' && d.patterns ? li(`<b>${F.n(d.patterns)}</b> employees here have a recurring manual-punch pattern (see the employee table)`) : '',
      ];
    } else if (d.lens === 'ot') {
      items = [
        li(`Recorded OT premium <b>${F.money(sm.cost)}</b> over <b>${F.n(x.weeks)}</b> employee-weeks with overtime`),
        li(`<b>${F.money(x.premSched)}</b> of premium was already built into the published schedule (planned overtime)`),
        li(`<b>${F.money(x.premDrift)}</b> came from working past the schedule (not planned) — counted in the avoidable estimate`),
        x.multiWeeks ? li(`<b>${F.n(x.multiWeeks)}</b> OT weeks involved more than one store`) : '',
        li('OT approvals are not in this dataset, so "unauthorized" overtime cannot be confirmed; overtime from working past the schedule is the closest measure.'),
      ];
    } else if (d.lens === 'overplan') {
      items = [
        li(`Scheduled <b>${F.hrs(x.sch / 60)}</b> · paid <b>${F.hrs(x.act / 60)}</b> (<b>${F.pctSigned(x.act / Math.max(1, x.sch) - 1)}</b> vs schedule)`),
        x.overDays != null ? li(`The store paid above its schedule on <b>${F.n(x.overDays)}</b> of ${F.n(x.storeDays)} days (netted per day)`) : li(`<b>${F.n(x.daysOver)}</b> days paid above the employee's own schedule`),
        li('Not all of this is avoidable: hours above schedule include cover for absences and genuine demand. The avoidable part is estimated separately (beyond tolerance, netted per store-day).'),
      ];
    } else if (d.lens === 'meal') {
      items = [li(`Planned unpaid meals worked through on <b>${F.n(x.worked)}</b> days — costed at the employee's rate`), li(`<b>${F.n(x.missed)}</b> long shifts with no meal recorded — a compliance exposure, not costed (no premium pay recorded)`)];
    } else if (d.lens === 'edits') {
      items = [li(`<b>${F.n(x.added)}</b> edits added paid time · <b>${F.n(x.removed)}</b> removed paid time`), li(`<b>${F.n(x.forgot)}</b> forgotten clock-outs corrected — excluded from the $ figure`)];
    } else if (d.lens === 'labor') {
      const row = d.s ? R.stores.find((r) => r.s === d.s) : null;
      items = [li(`Recorded labor cost <b>${F.money(x.cost)}</b> for <b>${F.hrs(x.act / 60)}</b> paid hours (scheduled ${F.hrs(x.sch / 60)})`),
        row ? li(R.sales.available && F.ok(row.laborPct) ? `Wage-based Labor % <b>${F.pct(row.laborPct)}</b> (punch pay ÷ actual sales, complete months) · SPLH ${F.n1(row.splh)}` : `Labor % not available: ${esc(R.sales.reason || 'no complete sales months in this period')}`) : ''];
    }
    items = items.filter(Boolean);
    return items.length ? `<div class="panel"><h3>${esc(LENS[d.lens].label)} — key facts</h3><ul class="fx-pts">${items.join('')}</ul></div>` : '';
  }

  /** Recommended actions: from the findings about this problem (the same text as on the Findings page). */
  function actionsPanel(R, lens, pat) {
    // Employee-pattern findings word their action for one person; at store / organization level use the others.
    const ins = R.insights.filter((i) => i.lens === lens && (pat || !String(i.id).startsWith('beh-')));
    const acts = [];
    if (pat && pat.action) acts.push(`<li>${esc(pat.action)}</li>`);
    for (const i of ins.slice(0, 3)) acts.push(`<li>${esc(i.action)} <button type="button" class="ilink" data-open="${esc(i.id)}">Finding: ${esc(i.title.replace(/⁣/g, '').slice(0, 70))}${i.title.length > 70 ? '…' : ''}</button></li>`);
    return acts.length ? `<div class="panel fx-do"><h3>Recommended actions</h3><ul class="fx-pts">${acts.join('')}</ul></div>` : '';
  }

  VIEWS.focus = async function (el, R, params) {
    const p = Object.assign({ f: null, x: null, lens: null, s: null, g: null }, params);
    const ins = p.f ? R.insights.find((i) => i.id === p.f) : null;
    const C = ctxOf(p);
    el.innerHTML = `<div class="backbar"><button class="btn" id="fcBack">‹ Back</button><nav class="crumb" aria-label="Drill-down path"></nav></div><div class="note">Loading ${p.g ? 'employee' : p.s ? 'store' : 'store breakdown'}…</div>`;
    UI.$('#fcBack', el).addEventListener('click', () => G.App.back());
    let d;
    try { d = await G.App.query({ type: 'focus', finding: p.f, lens: p.lens, s: p.s, g: p.g }); } catch (e) { el.querySelector('.note').outerHTML = `<div class="msg err">Could not load this drill-down: ${esc(e.message)}</div>`; return; }
    if (G.App.current !== 'focus' || ['f', 'x', 'lens', 's', 'g'].some((k) => (G.App.params[k] || null) !== (p[k] || null))) return; // navigated away meanwhile
    setTimeout(() => G.App.restoreScroll(), 0);
    const L = LENS[d.lens];
    el.querySelector('.note').remove();
    crumbs(el, R, p, d);
    const sm = d.summary;
    const ctxLine = ins ? `<div class="fc-ctx"><span class="sev s-${ins.severity}">${ins.severity}</span><span>Finding: <b>${esc(ins.title.replace(/⁣/g, ''))}</b></span></div>`
      : `<div class="fc-ctx"><span class="tag">${p.x === 'stores' ? 'From the store overview' : 'Explore · ' + esc(EXPLORE[p.x] || '')}</span><span>Only <b>${esc(L.label.toLowerCase())}</b> is shown here.${p.s && p.x !== 'stores' ? ' The store\'s other issues are on its <button type="button" class="ilink" id="fcStore">store overview</button>.' : ''}</span></div>`;
    const kind = L.moneyKind ? `<span class="tag ${/Recorded/.test(L.moneyKind) ? 'conf' : 'est'}">${esc(L.moneyKind)}</span> ` : '';
    const moneyKpi = (lbl, v, sub) => (L.money ? UI.kpi({ label: lbl, value: F.money(v), sub: kind + sub, cls: 'bad', title: 'Summed from the records listed below, at each employee\'s own pay rate' })
      : UI.kpi({ label: 'Records', value: F.n(sm.n), sub: esc(L.noMoney || ''), cls: 'warn' }));
    const wire = () => {
      UI.$$('[data-open]', el).forEach((b) => b.addEventListener('click', () => G.App.go('findings', { open: b.dataset.open })));
      const st = UI.$('#fcStore', el); if (st) st.addEventListener('click', () => G.App.go('stores', { s: p.s }));
    };
    const title = (where) => `<h2>${esc(L.title)} — ${esc(where)}</h2>`;

    if (d.level === 'org') {
      el.insertAdjacentHTML('beforeend', `${title('by store')}${ctxLine}
        <div class="stack"><div class="kpis">${moneyKpi(L.money || 'Records', sm.cost, `${F.n(d.stores.length)} stores`)}
          ${UI.kpi({ label: L.metric, value: F.hrsK(sm.min / 60), sub: `${F.n(sm.n)} ${unitWord(d.unit, sm.n)}` })}
          ${UI.kpi({ label: 'Affected employees', value: F.n(sm.emps), sub: 'GEIDs with at least one record' })}
          ${UI.kpi({ label: 'Dates', value: sm.first ? F.date(sm.first) : '—', sub: sm.last ? 'to ' + F.date(sm.last) : '' })}</div>
        ${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}
        <div class="panel"><h3>Stores — ${esc(L.label.toLowerCase())}</h3><p class="note" style="margin-top:-4px">Click a store to see only ${esc(L.label.toLowerCase())} for that store.</p><div id="fcS"></div></div>
        ${actionsPanel(R, d.lens)}</div>`);
      UI.table(UI.$('#fcS', el), { rows: d.stores, sortKey: 'cost', pageSize: 25, placeholder: 'Search stores', onRow: (r) => G.App.go('focus', Object.assign({}, C, { s: r.s })), cols: [
        { key: 'name', label: 'Store', fmt: (v) => 'Store ' + esc(v) }, { key: 'cost', label: L.money ? '$ impact' : 'Records', num: true, fmt: (v, r) => (L.money ? F.money(v) : F.n(r.n)), bar: '--c-late' },
        { key: 'min', label: L.metric, num: true, fmt: (v) => F.hrsFromMin(v) }, { key: 'n', label: 'Occurrences', num: true, fmt: (v) => `${F.n(v)} ${unitWord(d.unit, v)}` }, { key: 'emps', label: 'Employees', num: true, fmt: F.n }] });
      wire();
      return;
    }

    if (d.level === 'store') {
      const pctKpi = d.lens === 'overplan' && F.ok(sm.pct) ? UI.kpi({ label: '% over schedule', value: F.pct(sm.pct), sub: 'store paid hours vs scheduled, netted per day' }) : UI.kpi({ label: 'Occurrences', value: F.n(sm.n), sub: unitWord(d.unit, sm.n) });
      el.insertAdjacentHTML('beforeend', `${title('Store ' + d.storeName)}${ctxLine}
        <div class="stack">
          <div class="kpis k5">${moneyKpi(L.money || 'Records', sm.cost, L.money ? `Store ${esc(d.storeName)} · ${esc(L.label.toLowerCase())} only` : '')}
            ${UI.kpi({ label: L.metric, value: F.hrsK(sm.min / 60), sub: `${F.n(sm.n)} ${unitWord(d.unit, sm.n)}` })}
            ${pctKpi}
            ${UI.kpi({ label: 'Affected employees', value: F.n(sm.emps), sub: 'GEIDs with at least one record' })}
            ${UI.kpi({ label: 'Dates', value: sm.first ? F.date(sm.first) : '—', sub: sm.last ? 'to ' + F.date(sm.last) : '' })}</div>
          ${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}
          <div class="grid2">${extrasPanel(d, R, sm) || '<div></div>'}${actionsPanel(R, d.lens) || '<div></div>'}</div>
          <div class="panel"><h3>Employees — ${esc(L.label.toLowerCase())}</h3><p class="note" style="margin-top:-4px">Highest $ first. Click an employee to see only their ${esc(L.label.toLowerCase())} records.</p><div id="fcE"></div></div>
          ${d.storeDays && d.storeDays.length ? '<div class="panel"><h3>Days this store paid above its schedule (netted)</h3><div id="fcD"></div></div>' : ''}
          <div class="panel"><h3>Supporting records</h3>${d.recordsTotal > d.records.length ? `<p class="note">Showing the first ${F.n(d.records.length)} of ${F.n(d.recordsTotal)} records; all totals use every record.</p>` : ''}<div id="fcR"></div></div>
        </div>`);
      UI.table(UI.$('#fcE', el), { rows: d.employees, sortKey: L.money ? 'cost' : 'n', pageSize: 15, placeholder: 'Search name or GEID', onRow: (r) => G.App.go('focus', Object.assign({}, C, { s: p.s, g: r.g })), cols: [
        { key: 'name', label: 'Employee', text: (r) => r.name + ' ' + r.g, fmt: (v, r) => `${esc(v)}<span class="sub">GEID ${esc(r.g)}${r.job ? ' · ' + esc(r.job) : ''}</span>` },
        ...(L.money ? [{ key: 'cost', label: d.lens === 'overplan' ? '$ above own schedule' : '$ impact', num: true, fmt: F.money, bar: '--c-late', title: d.lens === 'overplan' ? 'Before store-day netting' : '' }] : []),
        { key: 'min', label: L.metric, num: true, fmt: (v) => F.hrsFromMin(v) }, { key: 'n', label: d.unit === 'days' ? 'Affected shifts / days' : 'Occurrences', num: true, fmt: (v) => `${F.n(v)} ${unitWord(d.unit, v)}` },
        { key: 'last', label: 'First – last', fmt: (v, r) => `${F.date(r.first)} – ${F.date(r.last)}` },
        { key: 'pattern', label: 'Recurring pattern', val: (r) => (r.pattern ? 1 : 0), fmt: (v, r) => (r.pattern ? `<span class="sev s-${r.patternSev}">${esc(r.patternSev)}</span> <span class="note">${esc(r.pattern)}</span>` : '—') }] });
      if (d.storeDays && d.storeDays.length) UI.table(UI.$('#fcD', el), { search: false, rows: d.storeDays, sortKey: 'cost', pageSize: 10, cols: [{ key: 'date', label: 'Date', fmt: (v, r) => `${F.date(v)}<span class="sub">${esc(r.dow)}</span>` }, { key: 'cost', label: '$ above plan', num: true, fmt: F.money, bar: '--c-neutral' }, { key: 'min', label: 'Hours above plan', num: true, fmt: hm }] });
      const nameOf = Object.fromEntries(d.employees.map((e) => [e.g, e.name]));
      UI.table(UI.$('#fcR', el), { rows: d.records.map((r) => Object.assign({ empName: nameOf[r.g] || r.g }, r)), sortKey: L.money ? 'cost' : 'day', desc: true, pageSize: 20, placeholder: 'Search employee, GEID or date', cols: recordCols(d, true), onRow: (r) => G.App.go('focus', Object.assign({}, C, { s: p.s, g: r.g })) });
      wire();
      return;
    }

    // employee level
    const pat = d.patterns && d.patterns[0];
    el.insertAdjacentHTML('beforeend', `${title(d.name)}${ctxLine}
      <div class="profile" style="margin:6px 0 14px"><div><div class="pl">GEID</div><div class="pv">${esc(d.g)}</div></div><div><div class="pl">Store</div><div class="pv">${esc(d.s ? d.storeName : 'All stores')}</div></div>
        ${d.job ? `<div><div class="pl">Job</div><div class="pv">${esc(d.job)}</div></div>` : ''}<div><button class="btn" id="fcAll">View all employee insights →</button></div></div>
      <div class="stack">
        <div class="kpis k5">${moneyKpi(L.money || 'Records', sm.cost, L.money ? esc(L.label.toLowerCase()) + ' only' : '')}
          ${UI.kpi({ label: L.metric, value: F.hrs(sm.min / 60), sub: d.lens === 'edits' ? 'paid time added by edits' : 'related to this problem' })}
          ${UI.kpi({ label: 'Affected ' + (d.unit === 'weeks' ? 'weeks' : d.unit === 'days' ? 'shifts / days' : d.unit), value: F.n(sm.n), sub: unitWord(d.unit, sm.n) })}
          ${UI.kpi({ label: 'First – last occurrence', value: sm.first ? F.date(sm.first) : '—', sub: sm.last ? 'to ' + F.date(sm.last) : '' })}
          ${UI.kpi({ label: 'Recurring pattern', value: pat ? pat.severity : 'None', sub: pat ? esc(pat.label) : 'no recurring pattern detected for this problem', cls: pat ? 'warn' : '' })}</div>
        ${pat ? `<div class="panel fc-pat"><h3>Recurring pattern</h3>${F.bulletsHtml(pat.description)}</div>` : ''}
        <div class="grid2">${extrasPanel(d, R, sm) || '<div></div>'}${actionsPanel(R, d.lens, pat) || '<div></div>'}</div>
        <div class="panel"><h3>Records — ${esc(L.label.toLowerCase())}</h3><div id="fcR"></div></div>
      </div>`);
    UI.$('#fcAll', el).addEventListener('click', () => G.App.go('employees', { g: d.g }));
    UI.table(UI.$('#fcR', el), { rows: d.records, sortKey: 'day', desc: true, pageSize: 25, placeholder: 'Search dates', cols: recordCols(d, false) });
    wire();
  };

  G.LCIViews = Object.assign(G.LCIViews || {}, { lensLabel: (k) => (LENS[k] ? LENS[k].label : ''), lensTitle: (k) => (LENS[k] ? LENS[k].title : '') });
})(window);
