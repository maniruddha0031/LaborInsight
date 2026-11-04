/* format.js — number/text formatting and HTML escaping for the UI (en-US everywhere). */
(function (G) {
  const F = (G.FMT = {});
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

  F.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  F.ok = (v) => v != null && isFinite(v);
  F.n = (v) => (F.ok(v) ? nf0.format(v) : '—');
  F.n1 = (v) => (F.ok(v) ? nf1.format(v) : '—');
  F.money = (v) => (F.ok(v) ? (v < 0 ? '−$' : '$') + nf0.format(Math.abs(v)) : '—');
  /** Compact money: $1.2M / $340K / $980 */
  F.moneyK = (v) => {
    if (!F.ok(v)) return '—';
    const a = Math.abs(v), s = v < 0 ? '−$' : '$';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
    if (a >= 1e4) return s + Math.round(a / 1e3) + 'K';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
    return s + Math.round(a);
  };
  F.hrsFromMin = (m) => (F.ok(m) ? nf0.format(m / 60) + ' h' : '—');
  F.hrs = (h) => (F.ok(h) ? nf0.format(h) + ' h' : '—');
  F.hrsK = (h) => {
    if (!F.ok(h)) return '—';
    const a = Math.abs(h);
    if (a >= 1e6) return (h / 1e6).toFixed(2) + 'M h';
    if (a >= 1e4) return (h / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K h';
    return nf0.format(h) + ' h';
  };
  F.minHM = (m) => { if (!F.ok(m)) return '—'; const s = m < 0 ? '−' : ''; m = Math.round(Math.abs(m)); return s + Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  F.pct = (v, d) => (F.ok(v) ? (v * 100).toFixed(d == null ? 1 : d) + '%' : '—');
  F.pctSigned = (v, d) => (F.ok(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(d == null ? 1 : d) + '%' : '—');
  F.date = (iso) => { if (!iso) return '—'; const d = new Date(iso + 'T00:00:00Z'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  F.monthLabel = (key) => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }); };
  F.monthShort = (key) => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }); };
  F.bytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');
  F.kindTag = (k) => ({ confirmed: '<span class="tag conf">Confirmed</span>', estimate: '<span class="tag est">Estimate</span>', risk: '<span class="tag risk">Risk</span>', validate: '<span class="tag vld">Needs validation</span>' }[k] || '');
})(window);
