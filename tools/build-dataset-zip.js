#!/usr/bin/env node
/*
 * build-dataset-zip.js — package a folder of CSV exports into dataset ZIP(s) for datasets/.
 *
 *   node tools/build-dataset-zip.js <source-folder> <out-base-name> [--max-mb 95]
 *
 * Reads the source folder (never modifies it), deflates every file at level 9 and writes standard ZIP
 * archives. If the total would exceed --max-mb (GitHub rejects files over 100 MB), files are packed into
 * several self-contained parts: <out>.part1.zip, <out>.part2.zip … — list all parts in the manifest.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function writeZip(outFile, entries) {
  const fd = fs.openSync(outFile, 'w');
  let offset = 0;
  const central = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const t = dosTime(e.mtime);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(t.time, 10); h.writeUInt16LE(t.date, 12); h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.data.length, 18); h.writeUInt32LE(e.size, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    fs.writeSync(fd, h); fs.writeSync(fd, name); fs.writeSync(fd, e.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(t.time, 12); c.writeUInt16LE(t.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.data.length, 20);
    c.writeUInt32LE(e.size, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, name]));
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeSync(fd, cd); fs.writeSync(fd, end);
  fs.closeSync(fd);
  return offset + cd.length + 22;
}

function main() {
  const [src, outBase] = process.argv.slice(2);
  const mi = process.argv.indexOf('--max-mb');
  const maxBytes = (mi > 0 ? +process.argv[mi + 1] : 95) * 1024 * 1024;
  if (!src || !outBase) { console.error('usage: build-dataset-zip.js <source-folder> <out-base> [--max-mb 95]'); process.exit(2); }
  const files = walk(src).sort();
  const entries = [];
  for (const f of files) {
    const raw = fs.readFileSync(f);
    const data = zlib.deflateRawSync(raw, { level: 9 });
    entries.push({ name: path.relative(src, f).replace(/\\/g, '/'), size: raw.length, crc: zlib.crc32(raw), data, mtime: fs.statSync(f).mtime });
    process.stderr.write(`${(data.length / 1e6).toFixed(1)} MB  ${path.relative(src, f)}\n`);
  }
  const total = entries.reduce((s, e) => s + e.data.length + 76 + e.name.length * 2, 22);
  const parts = [];
  if (total <= maxBytes) parts.push(entries);
  else {
    // Greedy bin-packing, largest first; keeps each part a complete, independently valid ZIP.
    const sorted = entries.slice().sort((a, b) => b.data.length - a.data.length);
    for (const e of sorted) {
      const need = e.data.length + 76 + e.name.length * 2;
      let bin = parts.find((p) => p.size + need <= maxBytes);
      if (!bin) { bin = []; bin.size = 22; parts.push(bin); }
      bin.push(e); bin.size += need;
    }
  }
  const written = [];
  parts.forEach((p, i) => {
    const out = parts.length === 1 ? outBase + '.zip' : `${outBase}.part${i + 1}.zip`;
    const bytes = writeZip(out, p.sort((a, b) => (a.name < b.name ? -1 : 1)));
    written.push({ file: path.basename(out), bytes, entries: p.length });
    console.log(`${out}  ${(bytes / 1048576).toFixed(1)} MiB  ${p.length} files`);
  });
  console.log(JSON.stringify(written));
}
main();
