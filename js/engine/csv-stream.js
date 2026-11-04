/*
 * csv-stream.js — incremental RFC-4180 CSV parser.
 * Feed decoded text chunks with push(); rows are emitted through onRow(fields[]).
 * Quoted fields may contain commas, doubled quotes and newlines, and may span chunks.
 * Delimiter is auto-detected from the header line (comma, semicolon, tab or pipe).
 */
(function (G) {
  const LCI = (G.LCI = G.LCI || {});

  function splitQuoted(line, delim) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  function countQuotes(s) { let n = 0, i = -1; while ((i = s.indexOf('"', i + 1)) !== -1) n++; return n; }

  class CsvStream {
    constructor(onRow) {
      this.onRow = onRow;
      this.buf = '';
      this.pending = '';   // a logical row still inside an open quote
      this.delim = null;
      this.lines = 0;
    }
    _line(line) {
      if (this.pending) { line = this.pending + '\n' + line; this.pending = ''; }
      if (line.indexOf('"') >= 0 && countQuotes(line) % 2 === 1) { this.pending = line; return; }
      if (this.delim === null) {
        line = line.replace(/^﻿/, '');
        const cands = [',', ';', '\t', '|'];
        let best = ',', bc = -1;
        for (const d of cands) { const c = line.split(d).length; if (c > bc) { bc = c; best = d; } }
        this.delim = best;
      }
      if (line === '' ) return;
      this.lines++;
      const f = line.indexOf('"') >= 0 ? splitQuoted(line, this.delim) : line.split(this.delim);
      this.onRow(f);
    }
    push(text) {
      let s = this.buf + text;
      let start = 0, i;
      while ((i = s.indexOf('\n', start)) !== -1) {
        let end = i;
        if (end > start && s.charCodeAt(end - 1) === 13) end--;
        this._line(s.slice(start, end));
        start = i + 1;
      }
      this.buf = s.slice(start);
    }
    end() {
      if (this.buf) { const b = this.buf.replace(/\r$/, ''); this.buf = ''; this._line(b); }
      if (this.pending) { const p = this.pending; this.pending = ''; this.onRow(splitQuoted(p, this.delim || ',')); }
    }
  }

  LCI.CsvStream = CsvStream;
  LCI.splitQuoted = splitQuoted;
})(typeof globalThis !== 'undefined' ? globalThis : self);
