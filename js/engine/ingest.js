/*
 * ingest.js — turns classified CSV rows into a compact, normalised data model.
 *
 * One Ingestor instance per analysis run (never shared between datasets). For every file
 * it records validation evidence: rows read, rows accepted, invalid dates, missing GEIDs,
 * exact duplicate rows, months and stores covered, unmapped columns.
 *
 * Sales rows are reduced to store × month on arrival. The exports may carry finer time
 * slots, but forecast/actual sales are treated as monthly data by design (see docs/CALCULATIONS.md):
 * no daily or intraday sales figure is ever retained or used.
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});
  const U = LCI.util;

  // 53-bit FNV-style hash of a row (minus serial columns) for duplicate detection without keeping strings.
  function rowHash(fields, skip) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < fields.length; i++) {
      if (i === skip) continue;
      const s = fields[i];
      for (let j = 0; j < s.length; j++) {
        const c = s.charCodeAt(j);
        h1 = Math.imul(h1 ^ c, 16777619);
        h2 = Math.imul(h2 ^ c, 2246822519);
      }
      h1 = Math.imul(h1 ^ 44, 16777619);
      h2 = Math.imul(h2 ^ 44, 2246822519);
    }
    return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 2097151);
  }

  const JUNK_NAME = /test|^[^a-z]*$|(.)\1{3,}|^[bcdfghjklmnpqrstvwxz]{5,}$/i;

  function normStore(s) {
    s = (s || '').trim();
    if (!s || s === '-') return '';
    return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s.toUpperCase();
  }
  function cleanId(s) { s = (s || '').trim(); return s === '-' ? '' : s; }
  const yes = (s) => /^(y|yes|true|1)$/i.test((s || '').trim());

  class Ingestor {
    constructor(opts) {
      this.opts = opts || {};
      this.files = [];
      this.storeDisplay = new Map();   // normalised key -> Map(original form -> count)
      this.emp = new Map();            // GEID -> employee master record
      this.schedule = [];
      this.schedKeys = new Set();
      this.punches = [];
      this.auditManual = [];
      this.auditEdits = [];
      this.auditMethod = new Map();    // store|day|method -> count (clock in/out events only)
      this.auditEmpMethod = new Map(); // geid -> {method:count}
      this.auditEditor = new Map();    // editor -> {n, stores:Set}
      this.auditRows = 0;
      this.approvals = [];
      this.breaks = [];
      this.breakAudit = { rows: 0, byEditor: new Map(), manual: 0, editedByMgr: 0, methods: {} };
      this.violations = [];
      this.violKeys = new Set();
      this.excPunch = new Map();       // geid|startTs -> {s, day, auth:bool, mgr:Set}
      this.sales = new Map();          // store|month -> aggregate
      this.premium = [];
      this.misc = [];
    }

    // ---------- shared helpers ----------
    _empTouch(geid, r, map, type) {
      let e = this.emp.get(geid);
      if (!e) {
        e = { geid, names: {}, stores: {}, jobs: {}, ages: {}, timecards: {}, payrollIds: {}, types: {}, minorFlagYes: 0 };
        this.emp.set(geid, e);
      }
      e.types[type] = (e.types[type] || 0) + 1;
      if (map.first !== undefined || map.last !== undefined) {
        const nm = ((r[map.first] || '') + ' ' + (r[map.last] || '')).trim();
        if (nm) e.names[nm] = (e.names[nm] || 0) + 1;
      }
      if (map.timecard !== undefined) { const t = cleanId(r[map.timecard]); if (t) e.timecards[t] = 1; }
      if (map.payrollId !== undefined) { const t = cleanId(r[map.payrollId]); if (t) e.payrollIds[t] = 1; }
      if (map.age !== undefined) { const a = +r[map.age]; if (a > 0) e.ages[a] = (e.ages[a] || 0) + 1; }
      return e;
    }

    // ---------- file lifecycle ----------
    beginFile(name, header) {
      const type = LCI.schemas.classify(header);
      const info = {
        name, type, label: type ? LCI.schemas.types[type].label : 'Unrecognised',
        columns: header.length, rows: 0, accepted: 0, badShape: 0, invalidDate: 0, missingGeid: 0,
        missingStore: 0, duplicates: 0, months: {}, stores: new Set(), minDay: Infinity, maxDay: -Infinity,
        notes: [], missingReq: [], unmapped: [],
      };
      this.files.push(info);
      if (!type) {
        info.notes.push('Columns did not match any known report type — file skipped. Header: ' + header.slice(0, 12).join(', '));
        return null;
      }
      const m = LCI.schemas.mapHeader(type, header);
      info.missingReq = m.missingReq;
      info.unmapped = m.unmapped;
      if (m.missingReq.length) {
        info.notes.push('Missing required column(s): ' + m.missingReq.join(', ') + ' — file skipped.');
        return null;
      }
      const serial = header.findIndex((h) => /^s\.?\s*no\.?$|^row\s*(no|num|number)?$|^#$/i.test(String(h).replace(/^﻿/, '').trim()));
      const hashes = new Set();
      const handler = this['_row_' + type].bind(this);
      const ncol = header.length;
      return (r) => {
        info.rows++;
        if (r.length !== ncol) {
          // Tolerate trailing empty columns; reject genuinely broken rows.
          if (r.length < ncol - 1) { info.badShape++; return; }
        }
        const h = rowHash(r, serial);
        if (hashes.has(h)) { info.duplicates++; if (type === 'schedule' || type === 'punch' || type === 'breaks' || type === 'approval') return; }
        else hashes.add(h);
        const day = handler(r, m.map, info);
        if (day === false) return;
        info.accepted++;
        if (isFinite(day)) {
          if (day < info.minDay) info.minDay = day;
          if (day > info.maxDay) info.maxDay = day;
          const mk = U.monthKey(day);
          info.months[mk] = (info.months[mk] || 0) + 1;
        }
      };
    }

    _common(r, map, info, needGeid) {
      const ts = U.parseTs(r[map.date]);
      if (!isFinite(ts)) { info.invalidDate++; return null; }
      const day = U.dayOf(ts);
      const sraw = map.store !== undefined ? r[map.store] : '';
      const s = normStore(sraw);
      if (map.store !== undefined && !s) info.missingStore++;
      if (s) { info.stores.add(s); const dm = U.getOr(this.storeDisplay, s, () => ({})); const o = sraw.trim(); dm[o] = (dm[o] || 0) + 1; }
      let g = '';
      if (needGeid) {
        g = cleanId(r[map.geid]);
        if (!g) { info.missingGeid++; return null; }
      }
      return { day, s, g };
    }

    // ---------- per-type row handlers: return business day, or false to reject ----------
    _row_schedule(r, map, info) {
      const c = this._common(r, map, info, true);
      if (!c) return false;
      const st = U.parseClock(r[map.start]), en = U.parseClock(r[map.end]);
      if (!isFinite(st) || !isFinite(en)) { info.invalidDate++; return false; }
      const bt = map.breakType !== undefined ? (r[map.breakType] || '').trim().toUpperCase() : 'SHIFT';
      const kind = bt.indexOf('MEAL') >= 0 ? 'M' : bt.indexOf('REST') >= 0 ? 'R' : 'S';
      const job = map.jobDesc !== undefined ? (r[map.jobDesc] || '').trim() : '';
      // Duplicate guard on business content (serial numbers differ between exact duplicates).
      const key = c.g + '|' + c.day + '|' + c.s + '|' + st + '|' + en + '|' + kind + '|' + job;
      if (this.schedKeys.has(key)) { info.semanticDup = (info.semanticDup || 0) + 1; return false; }
      this.schedKeys.add(key);
      const minor = map.minorType !== undefined ? yes(r[map.minorType]) : false;
      const e = this._empTouch(c.g, r, map, 'schedule');
      if (minor) e.minorFlagYes++;
      if (c.s) e.stores[c.s] = (e.stores[c.s] || 0) + 1;
      if (job) e.jobs['sched:' + job] = 1;
      this.schedule.push({ g: c.g, s: c.s, day: c.day, st, en: en <= st ? en + 1440 : en, kind, job,
        hrs: map.schedHours !== undefined ? U.num(r[map.schedHours]) : NaN, minor });
      return c.day;
    }

    _row_punch(r, map, info) {
      const c = this._common(r, map, info, true);
      if (!c) return false;
      const inA = U.parseTs(r[map.adjIn]), outA = U.parseTs(r[map.adjOut]);
      const tot = U.parseDur(r[map.totalHrs]);
      if (!isFinite(inA)) { info.invalidDate++; return false; }
      const g = (f) => (map[f] !== undefined ? r[map[f]] : undefined);
      const p = {
        g: c.g, s: c.s, day: c.day, inA, outA,
        inO: U.parseTs(g('origIn')), outO: U.parseTs(g('origOut')),
        src: (g('sourceId') || '').trim().toUpperCase(),
        rate: U.num(g('rate')), otRate: U.num(g('otRate')),
        reg: U.parseDur(g('regHrs')), ot: U.parseDur(g('otHrs')) || 0, dt: U.parseDur(g('dtHrs')) || 0,
        brk: U.parseDur(g('breakHrs')) || 0, tot: isFinite(tot) ? tot : (isFinite(outA) ? outA - inA : NaN),
        // OT/DT pay stay NaN when the column is absent, so overtime.js can tell "not exported" from "paid $0".
        pay: U.num(g('totalPay')), otPay: map.otPay !== undefined ? U.num(g('otPay')) || 0 : NaN, dtPay: map.dtPay !== undefined ? U.num(g('dtPay')) || 0 : NaN,
        job: (g('job') || '').trim(), age: +(g('age') || 0) || 0, minor: yes(g('minorType')),
      };
      if (map.payrollId !== undefined && !cleanId(r[map.payrollId])) { p.noPayrollId = true; info.missingPayrollId = (info.missingPayrollId || 0) + 1; }
      const e = this._empTouch(c.g, r, map, 'punch');
      if (c.s) e.stores[c.s] = (e.stores[c.s] || 0) + 1;
      if (p.job) e.jobs[p.job] = (e.jobs[p.job] || 0) + 1;
      this.punches.push(p);
      return c.day;
    }

    _row_punchAudit(r, map, info) {
      const c = this._common(r, map, info, true);
      if (!c) return false;
      this.auditRows++;
      const pt = (r[map.punchType] || '').trim();
      const isIn = /in$/i.test(pt);
      const method = ((r[map.method] || '').trim().toUpperCase()) || '(blank)';
      const detail = map.detail !== undefined ? (r[map.detail] || '').trim() : '';
      const editor = map.modifiedBy !== undefined ? (r[map.modifiedBy] || '').trim() : '';
      const modAt = map.modifiedAt !== undefined ? U.parseTs(r[map.modifiedAt]) : NaN;
      if (/added/i.test(detail) || !detail) {
        // Keyed by business day (not month) so any date range can be analysed.
        const k = c.s + '|' + c.day + '|' + method;
        this.auditMethod.set(k, (this.auditMethod.get(k) || 0) + 1);
        const em = U.getOr(this.auditEmpMethod, c.g, () => ({}));
        em[method] = (em[method] || 0) + 1;
      }
      if (editor && editor !== '-') {
        const ed = U.getOr(this.auditEditor, editor, () => ({ n: 0, stores: {}, manual: 0, modified: 0, deleted: 0 }));
        ed.n++; ed.stores[c.s] = 1;
        if (method === 'MANUAL') ed.manual++;
        if (/modif/i.test(detail)) ed.modified++;
        if (/delet/i.test(detail)) ed.deleted++;
      }
      const adjIn = U.parseTs(r[map.adjIn]), adjOut = U.parseTs(r[map.adjOut]);
      const origIn = U.parseTs(r[map.origIn]), origOut = U.parseTs(r[map.origOut]);
      // A manual "Punch Added" is time keyed in by someone other than the clock; the lag between the
      // punch time and when it was entered shows whether it was recorded live or reconstructed later.
      if (method === 'MANUAL' && /added/i.test(detail)) {
        const t = isIn ? adjIn : adjOut;
        this.auditManual.push({ g: c.g, s: c.s, day: c.day, isIn, t, modAt, lag: isFinite(t) && isFinite(modAt) ? modAt - t : NaN, editor });
      } else if (/modif|delet|restor/i.test(detail)) {
        this.auditEdits.push({ g: c.g, s: c.s, day: c.day, isIn, detail, origIn, origOut, adjIn, adjOut, modAt, editor, method });
      }
      return c.day;
    }

    _row_approval(r, map, info) {
      const c = this._common(r, map, info, true);
      if (!c) return false;
      const g = (f) => (map[f] !== undefined ? U.parseTs(r[map[f]]) : NaN);
      this._empTouch(c.g, r, map, 'approval');
      this.approvals.push({
        g: c.g, s: c.s, day: c.day,
        type: (r[map.type] || '').trim(), desc: (r[map.description] || '').trim(),
        method: map.method !== undefined ? ((r[map.method] || '').trim().toUpperCase() || '(blank)') : '',
        editor: map.editor !== undefined ? (r[map.editor] || '').trim() : '',
        oS: g('origStart'), oE: g('origEnd'), aS: g('adjStart'), aE: g('adjEnd'),
        obS: g('origBrkStart'), obE: g('origBrkEnd'), abS: g('adjBrkStart'), abE: g('adjBrkEnd'),
        first: (r[map.first] || '').trim(), last: (r[map.last] || '').trim(),
      });
      return c.day;
    }

    _row_breaks(r, map, info) {
      const c = this._common(r, map, info, true);
      if (!c) return false;
      const bi = U.parseTs(r[map.brkIn]), bo = U.parseTs(r[map.brkOut]);
      const t = map.breakType !== undefined ? (r[map.breakType] || '') : '';
      const dur = map.totalBreak !== undefined ? U.parseDur(r[map.totalBreak]) : NaN;
      this._empTouch(c.g, r, map, 'breaks');
      this.breaks.push({ g: c.g, s: c.s, day: c.day, bi, bo, kind: /rest/i.test(t) ? 'R' : 'M',
        dur: isFinite(bi) && isFinite(bo) ? bo - bi : dur, open: !isFinite(bo) });
      return c.day;
    }

    _row_breakAudit(r, map, info) {
      const c = this._common(r, map, info, true);
      if (!c) return false;
      const B = this.breakAudit;
      B.rows++;
      const method = ((r[map.method] || '').trim().toUpperCase()) || '(blank)';
      B.methods[method] = (B.methods[method] || 0) + 1;
      if (method === 'MANUAL') B.manual++;
      const ed = map.modifiedBy !== undefined ? (r[map.modifiedBy] || '').trim() : '';
      if (ed && ed !== '-' && ed !== 'System') {
        B.editedByMgr++;
        const x = U.getOr(B.byEditor, ed, () => ({ n: 0, stores: {} }));
        x.n++; x.stores[c.s] = 1;
      }
      return c.day;
    }

    _row_exception(r, map, info) {
      const c = this._common(r, map, info, true);
      if (!c) return false;
      const start = map.start !== undefined ? r[map.start] : '';
      const pk = c.g + '|' + start;
      let p = this.excPunch.get(pk);
      if (!p) { p = { s: c.s, day: c.day, auth: false, mgr: '' }; this.excPunch.set(pk, p); }
      if (map.mgrAuth !== undefined && yes(r[map.mgrAuth])) p.auth = true;
      const mn = map.mgrName !== undefined ? (r[map.mgrName] || '').trim() : '';
      if (mn && mn !== '-') p.mgr = mn;
      const br = (r[map.breach] || '').trim();
      if (br) {
        // Format observed: "MM/DD/YYYY HH:MM=TYPE" — several joined with "~".
        for (const part of br.split('~')) {
          const eq = part.lastIndexOf('=');
          const type = (eq >= 0 ? part.slice(eq + 1) : part).trim().toUpperCase();
          const at = eq >= 0 ? U.parseTs(part.slice(0, eq)) : NaN;
          if (!type) continue;
          const k = c.g + '|' + type + '|' + (isFinite(at) ? at : c.day);
          if (this.violKeys.has(k)) continue;
          this.violKeys.add(k);
          this.violations.push({ g: c.g, s: c.s, day: c.day, type, at });
        }
      }
      this._empTouch(c.g, r, map, 'exception');
      return c.day;
    }

    _row_sales(r, map, info) {
      const ts = U.parseTs(r[map.date]);
      if (!isFinite(ts)) { info.invalidDate++; return false; }
      const day = U.dayOf(ts);
      const sraw = r[map.store] || '';
      const s = normStore(sraw);
      if (!s) { info.missingStore++; return false; }
      info.stores.add(s);
      const dm = U.getOr(this.storeDisplay, s, () => ({})); const o = sraw.trim(); dm[o] = (dm[o] || 0) + 1;
      const mk = U.monthKey(day);
      const a = U.getOr(this.sales, s + '|' + mk, () => ({ s, month: mk, fs: 0, as: 0, fh: 0, sh: 0, ah: 0, ih: 0, txn: 0, days: {}, salesDays: {}, neg: 0, rows: 0 }));
      const v = (f) => (map[f] !== undefined ? U.num(r[map[f]]) : NaN);
      const fs = v('fcstSales'), as = v('actSales');
      a.rows++;
      a.days[day] = 1;
      if (as > 0) a.salesDays[day] = 1;
      if (as < 0) a.neg++;
      if (isFinite(fs)) a.fs += fs;
      if (isFinite(as)) a.as += as;
      const fh = v('fcstHours'), sh = v('schedHours'), ah = v('actHours'), ih = v('idealHours'), tx = v('txn');
      if (isFinite(fh)) a.fh += fh;
      if (isFinite(sh)) a.sh += sh;
      if (isFinite(ah)) a.ah += ah;
      if (isFinite(ih)) a.ih += ih;
      if (isFinite(tx)) a.txn += tx;
      return day;
    }

    _payItem(r, map, info, list) {
      const c = this._common(r, map, info, true);
      if (!c) return false;
      list.push({ g: c.g, s: c.s, day: c.day, job: (r[map.job] || '').trim(), rate: U.num(r[map.rate]), amount: U.num(r[map.amount]),
        name: ((r[map.first] || '') + ' ' + (r[map.last] || '')).trim() });
      return c.day;
    }
    _row_premiumPay(r, map, info) { return this._payItem(r, map, info, this.premium); }
    _row_miscPay(r, map, info) { return this._payItem(r, map, info, this.misc); }

    finishFile() {
      const f = this.files[this.files.length - 1];
      if (!f) return;
      f.storeCount = f.stores.size;
      f.stores = [...f.stores];
      if (!isFinite(f.minDay)) { f.minDay = null; f.maxDay = null; }
    }
  }

  Ingestor.JUNK_NAME = JUNK_NAME;
  Ingestor.normStore = normStore;
  LCI.Ingestor = Ingestor;
})(typeof globalThis !== 'undefined' ? globalThis : self);
