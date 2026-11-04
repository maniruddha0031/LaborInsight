/* components.js — small rendering building blocks shared by every view. */
(function (G) {
  const { esc } = G.FMT;
  const UI = (G.UI = {});
  UI.$ = (s, r) => (r || document).querySelector(s);
  UI.$$ = (s, r) => [...(r || document).querySelectorAll(s)];
  UI.css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------- chart registry (destroyed on every dataset change / re-render) ----------
  const charts = new Map();
  UI.destroyCharts = (scope) => {
    for (const [canvas, ch] of charts) if (!scope || scope.contains(canvas) || !document.body.contains(canvas)) { ch.destroy(); charts.delete(canvas); }
  };
  UI.chartCount = () => charts.size;

  /**
   * Line/bar chart with the house style: recessive grid, condensed tick font, one y-axis only,
   * hover tooltip on every chart (index mode, crosshair-like), 2px lines, rounded bar ends.
   */
  UI.chart = function (canvas, cfg) {
    if (!G.Chart) { canvas.parentElement.innerHTML = '<div class="empty">Chart library not loaded.</div>'; return null; }
    if (charts.has(canvas)) { charts.get(canvas).destroy(); charts.delete(canvas); }
    const ink = UI.css('--muted'), grid = UI.css('--grid'), panel = UI.css('--panel'), text = UI.css('--ink');
    const fmtY = cfg.fmtY || ((v) => G.FMT.n(v));
    const datasets = cfg.series.map((s) => {
      const color = s.color.startsWith('--') ? UI.css(s.color) : s.color;
      const base = { label: s.label, data: s.data, borderColor: color, backgroundColor: s.fill || color, borderWidth: s.type === 'line' || cfg.type === 'line' ? 2 : 0 };
      if ((s.type || cfg.type) === 'line') Object.assign(base, { type: 'line', pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: color, pointBorderColor: panel, pointBorderWidth: 2, tension: 0.25, fill: false, borderDash: s.dash || [] });
      else Object.assign(base, { type: 'bar', borderRadius: 4, borderSkipped: 'start', maxBarThickness: 34, borderColor: panel, borderWidth: cfg.stacked ? { top: 2 } : 0, stack: s.stack });
      return base;
    });
    const ch = new G.Chart(canvas, {
      type: cfg.type || 'bar',
      data: { labels: cfg.labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
        indexAxis: cfg.horizontal ? 'y' : 'x',
        interaction: { mode: cfg.horizontal ? 'nearest' : 'index', intersect: false, axis: cfg.horizontal ? 'y' : 'x' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: panel, titleColor: text, bodyColor: text, borderColor: UI.css('--line'), borderWidth: 1, padding: 10,
            titleFont: { family: "'IBM Plex Sans'", weight: '600' }, bodyFont: { family: "'IBM Plex Sans Condensed'" },
            callbacks: { label: (c) => ` ${c.dataset.label}: ${(cfg.fmtTip || fmtY)(c.parsed[cfg.horizontal ? 'x' : 'y'])}` },
          },
        },
        scales: {
          // Only the value axis gets a formatter; passing `callback: undefined` would replace the category labels.
          x: { stacked: !!cfg.stacked, grid: { display: !!cfg.horizontal, color: grid }, border: { display: false },
            ticks: Object.assign({ color: ink, font: { family: "'IBM Plex Sans Condensed'", size: 12 }, autoSkip: true, maxRotation: 0 }, cfg.horizontal ? { callback: (v) => fmtY(v) } : {}) },
          y: { stacked: !!cfg.stacked, beginAtZero: cfg.beginAtZero !== false, grid: { display: !cfg.horizontal, color: grid }, border: { display: false },
            ticks: Object.assign({ color: ink, font: { family: "'IBM Plex Sans Condensed'", size: 12 }, maxTicksLimit: 6 }, cfg.horizontal ? {} : { callback: (v) => fmtY(v) }),
            suggestedMin: cfg.suggestedMin, suggestedMax: cfg.suggestedMax },
        },
        onClick: cfg.onClick ? (e, els) => { if (els.length) cfg.onClick(els[0].index); } : undefined,
        onHover: cfg.onClick ? (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; } : undefined,
      },
    });
    charts.set(canvas, ch);
    return ch;
  };

  UI.legend = (items) => '<div class="legend">' + items.map((i) => `<span><i style="background:var(${i.color})"></i>${esc(i.label)}</span>`).join('') + '</div>';

  UI.kpi = (k) => `<div class="kpi ${k.cls || ''}"><div class="dl">${esc(k.label)}</div><div class="kv" title="${esc(k.title || '')}">${k.value}</div><div class="kx">${k.sub || ''}</div></div>`;

  /** Horizontal bar rows. rows: [{label, sub, value, display, sub2, color, outer}] */
  UI.bars = function (rows, opts) {
    const max = (opts && opts.max) || Math.max(1e-9, ...rows.map((r) => Math.max(r.value || 0, r.outer || 0)));
    return '<div class="bars">' + rows.map((r) => {
      const w = Math.max(0, (r.value || 0) / max * 100), wo = Math.max(0, (r.outer || 0) / max * 100);
      return `<div class="brow"${r.title ? ` title="${esc(r.title)}"` : ''}><div class="bl">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>
        <div class="track">${r.outer ? `<div class="fill outer" style="width:${wo}%;background:var(${r.color})"></div>` : ''}<div class="fill inner" style="width:${w}%;background:var(${r.color})"></div></div>
        <div class="bv">${r.display}${r.sub2 ? `<small>${r.sub2}</small>` : ''}</div></div>`;
    }).join('') + '</div>';
  };

  /**
   * Sortable, searchable, paged table.
   * cols: [{key, label, num, fmt(v,row) -> html, val(row) -> sortable value, bar:'--color', title}]
   */
  UI.table = function (host, o) {
    const st = { key: o.sortKey || null, desc: o.desc !== false, q: '', page: 0 };
    const size = o.pageSize || 50;
    const val = (c, r) => (c.val ? c.val(r) : r[c.key]);
    const maxOf = {};
    for (const c of o.cols) if (c.bar) maxOf[c.key] = Math.max(1e-9, ...o.rows.map((r) => Math.abs(+val(c, r) || 0)));
    host.innerHTML = (o.search !== false ? `<div class="controls"><input type="search" placeholder="${esc(o.placeholder || 'Search')}" aria-label="Search table" style="min-width:220px">${o.extra || ''}<span class="note tcount"></span></div>` : '') +
      `<div class="tbl ${o.tall ? 'tall' : ''}"><table><thead><tr></tr></thead><tbody></tbody></table></div><div class="pager"></div>`;
    const thead = host.querySelector('thead tr'), tbody = host.querySelector('tbody'), pager = host.querySelector('.pager'), count = host.querySelector('.tcount');
    thead.innerHTML = o.cols.map((c, i) => `<th class="${c.num ? 'num ' : ''}sortable" data-i="${i}" title="${esc(c.title || '')}">${esc(c.label)}<span class="ar"></span></th>`).join('');
    const search = host.querySelector('input[type=search]');
    if (search) search.addEventListener('input', () => { st.q = search.value.trim().toLowerCase(); st.page = 0; draw(); });
    thead.addEventListener('click', (e) => {
      const th = e.target.closest('th'); if (!th) return;
      const c = o.cols[+th.dataset.i];
      if (st.key === c.key) st.desc = !st.desc; else { st.key = c.key; st.desc = !!c.num; }
      st.page = 0; draw();
    });
    function draw() {
      let rows = o.rows;
      if (st.q) rows = rows.filter((r) => o.cols.some((c) => String(c.text ? c.text(r) : val(c, r) == null ? '' : val(c, r)).toLowerCase().includes(st.q)));
      if (st.key) {
        // The sort key may be a row field that is not shown as a column (e.g. default ranking).
        const c = o.cols.find((x) => x.key === st.key) || { key: st.key };
        rows = rows.slice().sort((a, b) => {
          let x = val(c, a), y = val(c, b);
          const bad = (v) => v == null || (typeof v === 'number' && !isFinite(v));
          if (bad(x) && bad(y)) return 0; if (bad(x)) return 1; if (bad(y)) return -1;
          if (typeof x === 'string') return st.desc ? y.localeCompare(x) : x.localeCompare(y);
          return st.desc ? y - x : x - y;
        });
      }
      UI.$$('th', thead).forEach((th) => { const c = o.cols[+th.dataset.i]; th.querySelector('.ar').textContent = c.key === st.key ? (st.desc ? '▼' : '▲') : ''; });
      const pages = Math.max(1, Math.ceil(rows.length / size));
      st.page = Math.min(st.page, pages - 1);
      const view = rows.slice(st.page * size, st.page * size + size);
      tbody.innerHTML = view.length ? view.map((r, i) => `<tr${o.onRow ? ` class="click" tabindex="0" data-i="${st.page * size + i}"` : ''}>` + o.cols.map((c) => {
        const v = val(c, r);
        let inner = c.fmt ? c.fmt(v, r) : esc(v == null ? '' : v);
        if (c.bar && isFinite(+v)) inner = `<span class="cellbar" style="width:${Math.round(Math.abs(+v) / maxOf[c.key] * 48)}px;background:var(${c.bar})"></span>` + inner;
        return `<td class="${c.num ? 'num' : ''}">${inner}</td>`;
      }).join('') + '</tr>').join('') : `<tr><td colspan="${o.cols.length}" class="empty">No rows</td></tr>`;
      if (o.onRow) {
        const cur = rows;
        UI.$$('tr.click', tbody).forEach((tr) => {
          const go = () => o.onRow(cur[+tr.dataset.i]);
          tr.addEventListener('click', go);
          tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        });
      }
      if (count) count.textContent = `${G.FMT.n(rows.length)} row${rows.length === 1 ? '' : 's'}`;
      pager.innerHTML = pages > 1 ? `<button class="btn" data-p="-1" ${st.page ? '' : 'disabled'}>Previous</button><span>Page ${st.page + 1} of ${pages}</span><button class="btn" data-p="1" ${st.page < pages - 1 ? '' : 'disabled'}>Next</button>` : '';
      UI.$$('button', pager).forEach((b) => b.addEventListener('click', () => { st.page += +b.dataset.p; draw(); }));
    }
    draw();
    return { redraw: draw, state: st };
  };

  /** Heatmap grid: rows × cols with a single-hue sequential scale (steel). */
  UI.heatmap = function (rowLabels, colLabels, cell, fmt, opts) {
    const vals = [];
    rowLabels.forEach((_, i) => colLabels.forEach((__, j) => { const v = cell(i, j); if (isFinite(v)) vals.push(v); }));
    const max = Math.max(1e-9, ...vals);
    const lowIsGood = !(opts && opts.diverge);
    let h = `<div class="heat-grid" style="grid-template-columns:minmax(90px,170px) repeat(${colLabels.length},minmax(44px,1fr))"><div></div>` + colLabels.map((c) => `<div class="hh">${esc(c)}</div>`).join('');
    rowLabels.forEach((r, i) => {
      h += `<div class="hr" title="${esc(r)}">${esc(r)}</div>`;
      colLabels.forEach((c, j) => {
        const v = cell(i, j);
        if (!isFinite(v)) { h += '<div class="hc" style="color:var(--muted)">—</div>'; return; }
        const t = lowIsGood ? Math.min(1, v / max) : v;
        h += `<div class="hc" title="${esc(r)} · ${esc(c)}: ${esc(fmt(v))}" style="background:color-mix(in srgb, var(--steel) ${Math.round(8 + t * 80)}%, var(--panel));color:${t > 0.5 ? 'var(--panel)' : 'var(--ink)'}">${esc(fmt(v))}</div>`;
      });
    });
    return h + '</div>';
  };

  UI.section = (title, lead) => `<h2>${esc(title)}</h2>${lead ? `<p class="lead">${lead}</p>` : ''}`;
})(window);
