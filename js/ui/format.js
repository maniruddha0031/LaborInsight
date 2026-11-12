/* format.js — number/text formatting and HTML escaping for the UI (en-US everywhere). */
(function (G) {
  const F = (G.FMT = {});
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

  // Also drops U+2063 (list-item marker from the engine) so text displays normally outside the finding bullets.
  F.esc = (s) => String(s == null ? '' : s).replace(/⁣/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Escape, then emphasise money, percentages, hours, multipliers and large counts. */
  F.hl = (s) => F.esc(s).replace(/(−?\$[0-9][0-9,]*(?:\.[0-9]+)?[KM]?|[0-9][0-9,]*(?:\.[0-9]+)?\s?(?:%|pts\b|h\b|×)|\b[0-9]{1,3}(?:,[0-9]{3})+\b)/g, '<b class="hlv">$1</b>');

  /**
   * Turn a finding paragraph into short bullet points: one per sentence, and one per item where the
   * sentence is a list ("Highest: A, B and C" → lead-in + one bullet per store).
   */
  F.bullets = (text) => {
    const out = [];
    const src = String(text || '').trim();
    if (!src) return out;
    const sentences = src.split(/(?<=[.!?])\s+(?=[A-Z0-9$(“"−])/);
    for (let s of sentences) {
      s = s.trim().replace(/\.$/, '');
      if (!s) continue;
      if (s.includes('⁣')) {
        const parts = s.split(/⁣(?:, | and )/);
        let lead = '', first = parts[0];
        const c = first.lastIndexOf(': ');
        if (c > 0) { lead = first.slice(0, c); first = first.slice(c + 2); }
        out.push({ lead, items: [first].concat(parts.slice(1)).map((x) => x.trim()) });
      } else out.push({ lead: s, items: null });
    }
    return out;
  };
  F.bulletsHtml = (text, cls) => {
    const b = F.bullets(text);
    if (!b.length) return '';
    return `<ul class="${cls || 'fx-pts'}">` + b.map((x) => x.items
      ? (x.lead ? `<li>${F.hl(x.lead)}:<ul>${x.items.map((i) => `<li>${F.hl(i)}</li>`).join('')}</ul></li>` : x.items.map((i) => `<li>${F.hl(i)}</li>`).join(''))
      : `<li>${F.hl(x.lead)}</li>`).join('') + '</ul>';
  };
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
