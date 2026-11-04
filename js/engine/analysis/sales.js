/*
 * sales.js — monthly sales vs labor efficiency. Monthly granularity ONLY.
 *
 * Sales are aggregated to store × month at ingest; nothing here looks at days or hours of sales.
 *   Achievement %   = actual sales / forecast sales
 *   SPLH            = actual sales / paid labor hours (paid hours from the punch export)   [product: KpiCalculator]
 *   Scheduled SPLH  = forecast sales / scheduled paid hours                                 [product: KpiCalculator]
 *   Labor %         = labor $ (Total Pay on punches) / actual sales                         [product: KpiCalculator]
 *   Forecast bias   = forecast / actual − 1
 * Flex check: month-over-month, sales down but paid hours up = labor did not flex with demand.
 * Peer benchmark: store SPLH vs the median SPLH of stores with similar sales volume (terciles).
 * Benchmark gaps are estimates and are never added to leakage totals.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;
  const A = (LCI.analysis = LCI.analysis || {});

  A.sales = function (M, R, ADH) {
    // Sales are monthly: only calendar months lying entirely inside the selected range are used.
    // Partial months are listed as excluded — monthly sales are never prorated to days.
    const monthKeys = M.salesMonths ? M.salesMonths.slice() : M.months.map((m) => m.key);
    const partialMonths = M.salesMonths ? M.months.map((m) => m.key).filter((k) => !M.salesMonths.includes(k)) : [];
    const inPeriod = new Set(monthKeys);
    const nDaysOf = (a) => (a.nDays != null ? a.nDays : Object.keys(a.days || {}).length);
    const nSalesDaysOf = (a) => (a.nSalesDays != null ? a.nSalesDays : Object.keys(a.salesDays || {}).length);
    // Days of data the dataset holds for a month (e.g. a month the export starts part-way through).
    const dataDays = M.dataMonthDays || {};
    const sm = {};
    let negSlots = 0, rows = 0;
    for (const a of M.sales) {
      if (M.storeFilter && !M.storeFilter.has(a.s)) continue;
      rows += a.rows;
      negSlots += a.neg;
      if (!inPeriod.has(a.month)) continue;
      sm[a.s + '|' + a.month] = a;
    }
    const has = Object.keys(sm).length > 0;
    if (!has) {
      const reason = !M.sales.length ? 'No forecast/actual sales file was found in the dataset.'
        : partialMonths.length && !monthKeys.length ? `The selected range does not contain a complete calendar month (${partialMonths.join(', ')} ${partialMonths.length > 1 ? 'are' : 'is'} only partly selected). Sales are monthly, so sales, SPLH and Labor % cannot be calculated for part of a month without prorating — choose a range that covers whole months.`
          : 'No sales rows fall in the selected period or stores.';
      return { available: false, reason, partialMonths };
    }

    const stores = [...new Set(Object.values(sm).map((a) => a.s))];
    const table = [];
    for (const s of stores) for (const mk of monthKeys) {
      const a = sm[s + '|' + mk];
      const L = ADH.byStoreMonth[s + '|' + mk];
      if (!a && !L) continue;
      const hrs = L ? L.act / 60 : 0, sch = L ? L.sch / 60 : 0, pay = L ? L.cAct : 0;
      table.push({
        s, month: mk, fs: a ? a.fs : NaN, as: a ? a.as : NaN, txn: a ? a.txn : NaN,
        fh: a ? a.fh : NaN, shFile: a ? a.sh : NaN, ahFile: a ? a.ah : NaN,
        hrs, sch, pay,
        ach: a && a.fs ? a.as / a.fs : NaN,
        splh: a && hrs ? a.as / hrs : NaN,
        schedSplh: a && sch ? a.fs / sch : NaN,
        laborPct: a && a.as ? pay / a.as : NaN,
        salesDays: a ? nSalesDaysOf(a) : 0,
        // Reliable = sales rows for every day of data in that month and positive sales.
        reliable: !!(a && a.as > 0 && nDaysOf(a) >= (dataDays[mk] || 28)),
      });
    }

    // ---- org by month ----
    const byMonth = monthKeys.map((mk) => {
      const r = table.filter((x) => x.month === mk && isFinite(x.as));
      const as = U.sum(r.map((x) => x.as)), fs = U.sum(r.map((x) => x.fs)), hrs = U.sum(r.map((x) => x.hrs)), sch = U.sum(r.map((x) => x.sch)), pay = U.sum(r.map((x) => x.pay)), fh = U.sum(r.map((x) => x.fh || 0)), ahFile = U.sum(r.map((x) => x.ahFile || 0));
      return { month: mk, stores: r.length, as, fs, hrs, sch, pay, fh, ahFile, ach: fs ? as / fs : NaN, splh: hrs ? as / hrs : NaN, schedSplh: sch ? fs / sch : NaN, laborPct: as ? pay / as : NaN };
    });

    // ---- per store over the period ----
    const perStore = stores.map((s) => {
      const r = table.filter((x) => x.s === s && isFinite(x.as)).sort((a, b) => (a.month < b.month ? -1 : 1));
      const as = U.sum(r.map((x) => x.as)), fs = U.sum(r.map((x) => x.fs)), hrs = U.sum(r.map((x) => x.hrs)), pay = U.sum(r.map((x) => x.pay)), sch = U.sum(r.map((x) => x.sch)), fh = U.sum(r.map((x) => x.fh || 0));
      const overF = r.filter((x) => x.fs > x.as * 1.05).length, underF = r.filter((x) => x.fs < x.as * 0.95).length;
      // Month-over-month flex: sales fell (>3%) but paid hours rose.
      const nonFlex = [];
      for (let i = 1; i < r.length; i++) {
        const p = r[i - 1], c = r[i];
        if (!(p.as > 0 && p.hrs > 0)) continue;
        const ds = c.as / p.as - 1, dh = c.hrs / p.hrs - 1;
        if (ds < -0.03 && dh > 0) {
          // Hours the store would have used holding the previous month's SPLH at the new sales level.
          const expected = c.as / (p.as / p.hrs);
          nonFlex.push({ month: c.month, prev: p.month, salesChg: ds, hoursChg: dh, excessHrs: Math.max(0, c.hrs - expected), rate: c.pay / c.hrs });
        }
      }
      const elasticity = U.corr(r.map((x) => x.as), r.map((x) => x.hrs));
      return {
        s, months: r.length, as, fs, hrs, pay, sch, fh, ach: fs ? as / fs : NaN, splh: hrs ? as / hrs : NaN, laborPct: as ? pay / as : NaN,
        fcstBias: as ? fs / as - 1 : NaN, overForecastMonths: overF, underForecastMonths: underF,
        nonFlex, nonFlexExcessHrs: U.sum(nonFlex.map((x) => x.excessHrs)), nonFlexExcessCost: U.sum(nonFlex.map((x) => x.excessHrs * (x.rate || 0))),
        corrSalesHours: elasticity, splhTrend: U.slope(r.map((x) => x.splh || 0)), laborPctSeries: r.map((x) => x.laborPct),
      };
    }).filter((x) => x.as > 0);

    // ---- peer benchmark by sales-volume tercile ----
    const vols = perStore.map((x) => x.as).sort((a, b) => a - b);
    const t1 = U.quantile(vols, 1 / 3), t2 = U.quantile(vols, 2 / 3);
    const tier = (v) => (v <= t1 ? 'Lower volume' : v <= t2 ? 'Mid volume' : 'Higher volume');
    const tiers = {};
    for (const x of perStore) { x.tier = tier(x.as); (tiers[x.tier] = tiers[x.tier] || []).push(x.splh); }
    const tierMed = {};
    for (const t in tiers) tierMed[t] = U.median(tiers[t].filter(isFinite));
    for (const x of perStore) {
      const med = tierMed[x.tier];
      x.peerSplh = med;
      const target = med ? x.as / med : x.hrs;
      x.peerGapHrs = Math.max(0, x.hrs - target);
      x.peerGapCost = x.hrs ? x.peerGapHrs * (x.pay / x.hrs) : 0;
    }

    // Reconciliation: hours inside the sales file vs paid hours from punches (same store-months).
    const both = table.filter((x) => isFinite(x.ahFile) && x.hrs > 0);
    const recon = { fileHrs: U.sum(both.map((x) => x.ahFile)), punchHrs: U.sum(both.map((x) => x.hrs)) };
    recon.ratio = recon.punchHrs ? recon.fileHrs / recon.punchHrs : NaN;

    const tot = byMonth.reduce((o, m) => { o.as += m.as; o.fs += m.fs; o.hrs += m.hrs; o.pay += m.pay; o.sch += m.sch; return o; }, { as: 0, fs: 0, hrs: 0, pay: 0, sch: 0 });
    tot.ach = tot.fs ? tot.as / tot.fs : NaN; tot.splh = tot.hrs ? tot.as / tot.hrs : NaN; tot.laborPct = tot.as ? tot.pay / tot.as : NaN;
    tot.schedSplh = tot.sch ? tot.fs / tot.sch : NaN;

    // ---- Labor % ranking (actual: punch pay ÷ actual sales, full months only) ----
    // A store is ranked only when every selected month has complete, positive sales for it.
    const ranked = [], notRanked = [];
    for (const s of stores) {
      const rows = table.filter((x) => x.s === s);
      const bad = monthKeys.filter((mk) => { const r = rows.find((x) => x.month === mk); return !r || !r.reliable; });
      const pay = U.sum(rows.map((x) => x.pay)), as = U.sum(rows.filter((x) => isFinite(x.as)).map((x) => x.as));
      if (bad.length || !(as > 0)) { notRanked.push({ s, reason: bad.length ? `Incomplete or missing sales for ${bad.join(', ')}` : 'No sales' }); continue; }
      ranked.push({ s, laborPct: pay / as, pay, sales: as, hrs: U.sum(rows.map((x) => x.hrs)) });
    }
    const orgPct = U.sum(ranked.map((x) => x.pay)) / Math.max(1e-9, U.sum(ranked.map((x) => x.sales)));
    const pcts = ranked.map((x) => x.laborPct);
    const mean = U.sum(pcts) / Math.max(1, pcts.length);
    const sd = Math.sqrt(U.sum(pcts.map((v) => (v - mean) * (v - mean))) / Math.max(1, pcts.length - 1));
    // Previous comparable period: the same number of full months immediately before the selection.
    const prev = M.prevSalesMonths || [];
    const prevPct = {};
    if (prev.length && M.allSales && M.storeMonthPay) {
      for (const r of ranked) {
        let pay = 0, as = 0, ok = true;
        for (const mk of prev) {
          const a = M.allSales[r.s + '|' + mk], p = M.storeMonthPay[r.s + '|' + mk];
          if (!a || !(a.as > 0) || nDaysOf(a) < ((M.dataMonthDays || {})[mk] || 28) || p == null) { ok = false; break; }
          pay += p; as += a.as;
        }
        if (ok && as > 0) prevPct[r.s] = pay / as;
      }
    }
    ranked.sort((a, b) => b.laborPct - a.laborPct);
    ranked.forEach((r, i) => {
      r.rank = i + 1;
      r.diff = r.laborPct - orgPct;
      r.z = sd ? (r.laborPct - mean) / sd : 0;
      r.status = r.z >= 1.5 || r.diff >= 0.05 ? 'Unusually high' : r.diff >= 0.02 ? 'High' : r.diff <= -0.02 ? 'Low' : 'Near average';
      r.prev = prevPct[r.s] != null ? prevPct[r.s] : null;
      r.change = r.prev != null ? r.laborPct - r.prev : null;
    });
    const laborRank = {
      rows: ranked, notRanked, orgPct, months: monthKeys, partialMonths, prevMonths: Object.keys(prevPct).length ? prev : [],
      highest: ranked[0] || null, lowest: ranked[ranked.length - 1] || null, aboveAvg: ranked.filter((r) => r.laborPct > orgPct).length,
      biggestIncrease: ranked.filter((r) => r.change != null).sort((a, b) => b.change - a.change).slice(0, 5),
      basis: 'Actual Labor % = punch pay ÷ actual sales, complete calendar months only',
    };

    return { available: true, table, byMonth, perStore, tierMed, tierCuts: [t1, t2], recon, negSlots, rows, tot, granularity: 'monthly', partialMonths, salesMonths: monthKeys, laborRank };
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
