/*
 * util.js — shared helpers for the analysis engine.
 * Runs unchanged in a Web Worker (importScripts) and in Node (require), so it only
 * touches globalThis. All timestamps are "naive local" minutes since 1970-01-01 —
 * the source exports carry no timezone, so we never let the JS Date timezone shift them.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = (LCI.util = {});

  const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

  U.dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);

  /**
   * Parse a date or datetime string into naive minutes since epoch.
   * Accepts: YYYY-MM-DD[ HH:MM[:SS]], MM/DD/YYYY[ HH:MM[:SS]], DD-MON-YYYY.
   * Returns NaN for blank, '-', or anything unrecognised (callers count these as invalid).
   */
  U.parseTs = function (s) {
    if (!s) return NaN;
    s = s.trim();
    if (s === '' || s === '-') return NaN;
    let y, m, d, rest;
    let c = s.charCodeAt(4);
    if (c === 45 /* - */ && s.length >= 10) {
      y = +s.slice(0, 4); m = +s.slice(5, 7); d = +s.slice(8, 10); rest = s.slice(10);
    } else if (s.charCodeAt(2) === 47 /* / */ || s.charCodeAt(1) === 47) {
      const p = s.split(/[\/ ]/);
      m = +p[0]; d = +p[1]; y = +p[2]; rest = s.slice(s.indexOf(' ') > 0 ? s.indexOf(' ') : s.length);
    } else if (/^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(s)) {
      const p = s.split(/[- ]/);
      d = +p[0]; m = MON[p[1].toUpperCase()]; y = +p[2]; rest = s.slice(s.indexOf(' ') > 0 ? s.indexOf(' ') : s.length);
    } else return NaN;
    if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return NaN;
    let mins = U.dayNum(y, m, d) * 1440;
    rest = rest ? rest.trim() : '';
    if (rest) {
      const t = rest.split(':');
      const hh = +t[0], mm = +(t[1] || 0);
      if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) return NaN;
      mins += hh * 60 + mm;
    }
    return mins;
  };

  /** "HH:MM" clock time -> minutes from midnight (NaN if invalid). */
  U.parseClock = function (s) {
    if (!s) return NaN;
    s = s.trim();
    const ap = /([AP]M)$/i.exec(s);
    const t = s.replace(/\s*[AP]M$/i, '').split(':');
    let h = +t[0];
    const m = +(t[1] || 0);
    if (ap) { const pm = ap[1].toUpperCase() === 'PM'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) return NaN;
    return h * 60 + m;
  };

  /** Durations exported as "HH:MM", "H : MM", or decimal hours -> minutes. */
  U.parseDur = function (s) {
    if (s == null) return NaN;
    s = String(s).replace(/\s+/g, '');
    if (s === '' || s === '-' || s === ':') return NaN;
    if (s.indexOf(':') >= 0) {
      const [h, m] = s.split(':');
      const hh = +h, mm = +m;
      if (!isFinite(hh) || !isFinite(mm)) return NaN;
      return hh * 60 + mm;
    }
    const v = +s;
    return isFinite(v) ? Math.round(v * 60) : NaN;
  };

  U.num = function (s) {
    if (s == null) return NaN;
    s = String(s).trim();
    if (s === '' || s === '-') return NaN;
    s = s.replace(/[$,\s]/g, '');
    if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
    const v = +s;
    return isFinite(v) ? v : NaN;
  };

  U.dayOf = (mins) => Math.floor(mins / 1440);
  U.minOfDay = (mins) => ((mins % 1440) + 1440) % 1440;
  U.dateParts = function (day) {
    const dt = new Date(day * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
  };
  U.isoDay = function (day) { return new Date(day * 86400000).toISOString().slice(0, 10); };
  U.isoTs = function (mins) {
    if (!isFinite(mins)) return '';
    const s = new Date(mins * 60000).toISOString();
    return s.slice(0, 10) + ' ' + s.slice(11, 16);
  };
  U.monthKey = function (day) { const p = U.dateParts(day); return p.y + '-' + String(p.m).padStart(2, '0'); };
  /** Monday-start business week, the week OT is calculated on (HW: per business week, EOTwkMain). */
  U.weekStart = function (day) { const dow = U.dateParts(day).dow; return day - ((dow + 6) % 7); };
  U.DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /** Normalise a header to a lookup key: lower-case alphanumerics only. */
  U.hkey = (h) => String(h || '').replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9#]/g, '').replace(/#/g, 'no');

  // ---- interval math on [start,end) minute pairs ----
  /** Merge overlapping or touching intervals. Input: array of [s,e]. */
  U.union = function (iv) {
    const a = iv.filter((x) => x[1] > x[0]).sort((p, q) => p[0] - q[0]);
    const out = [];
    for (const x of a) {
      const last = out[out.length - 1];
      if (last && x[0] <= last[1]) { if (x[1] > last[1]) last[1] = x[1]; } else out.push([x[0], x[1]]);
    }
    return out;
  };
  U.total = (iv) => iv.reduce((s, x) => s + (x[1] - x[0]), 0);
  U.overlap = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  /** Total overlap between two unioned interval lists. */
  U.overlapAll = function (A, B) {
    let t = 0;
    for (const a of A) for (const b of B) t += U.overlap(a, b);
    return t;
  };

  // ---- stats ----
  U.sum = (a) => a.reduce((s, x) => s + x, 0);
  U.median = function (a) {
    if (!a.length) return NaN;
    const b = a.slice().sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  U.quantile = function (a, q) {
    if (!a.length) return NaN;
    const b = a.slice().sort((x, y) => x - y);
    const pos = (b.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return b[lo] + (b[hi] - b[lo]) * (pos - lo);
  };
  U.mad = function (a) { const m = U.median(a); return U.median(a.map((x) => Math.abs(x - m))); };
  /** Pearson correlation; NaN when fewer than 3 points or no variance. */
  U.corr = function (x, y) {
    const n = x.length;
    if (n < 3) return NaN;
    const mx = U.sum(x) / n, my = U.sum(y) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
  };
  /** Least-squares slope of y over index 0..n-1. */
  U.slope = function (y) {
    const n = y.length;
    if (n < 2) return 0;
    const mx = (n - 1) / 2, my = U.sum(y) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - mx) * (y[i] - my); den += (i - mx) * (i - mx); }
    return den ? num / den : 0;
  };
  /** Share of the total held by the top `frac` of contributors (concentration). */
  U.topShare = function (vals, frac) {
    const v = vals.filter((x) => x > 0).sort((a, b) => b - a);
    const tot = U.sum(v);
    if (!tot) return 0;
    const k = Math.max(1, Math.round(v.length * frac));
    return U.sum(v.slice(0, k)) / tot;
  };

  U.inc = function (obj, k, v) { obj[k] = (obj[k] || 0) + (v === undefined ? 1 : v); return obj[k]; };
  U.getOr = function (map, k, mk) { let v = map.get(k); if (v === undefined) { v = mk(); map.set(k, v); } return v; };
  U.round = (v, d) => { const f = Math.pow(10, d || 0); return Math.round(v * f) / f; };
  U.pct = (a, b) => (b ? a / b : 0);
})(typeof globalThis !== 'undefined' ? globalThis : self);
