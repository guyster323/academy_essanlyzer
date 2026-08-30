/**
 * Node-side per-phase profile of streamIntoSource. Does not change production
 * scheduling. Used for task 6-4; results go to tmp/latency-runs/.
 *
 *   node scripts/profile-stream.mjs --csv Log_sample/extracted/data_sys_6_stride80.csv
 *   node scripts/profile-stream.mjs --zip Log_sample/case_b_field_data.zip --entry field_data/data_sys_6.csv
 *   node scripts/profile-stream.mjs --csv ... --yield-ms 4
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { streamIntoSource, zipEntryByteChunks, CHUNK_BYTES } from '../src/log-engine.js';
import { detectFormat } from '../src/formats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'latency-runs');

function parseArgs(argv) {
  const out = { csv: null, zip: null, entry: 'field_data/data_sys_6.csv', yieldMs: 0, label: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--csv') out.csv = next();
    else if (a === '--zip') out.zip = next();
    else if (a === '--entry') out.entry = next();
    else if (a === '--yield-ms') out.yieldMs = Number(next());
    else if (a === '--label') out.label = next();
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

class DiskBlob {
  constructor(filePath) {
    this.filePath = filePath;
    this.size = fs.statSync(filePath).size;
    this.fd = fs.openSync(filePath, 'r');
  }
  slice(start, end) {
    const length = end - start;
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(this.fd, buf, 0, length, start);
    const bytes = buf.subarray(0, bytesRead);
    return {
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
  }
  close() {
    fs.closeSync(this.fd);
  }
}

async function* nodeFileChunks(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fd.stat();
    let offset = 0;
    while (offset < stat.size) {
      const length = Math.min(CHUNK_BYTES, stat.size - offset);
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fd.read(buf, 0, length, offset);
      offset += bytesRead;
      yield new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    }
  } finally {
    await fd.close();
  }
}

async function detectFromFirstChunk(chunkIterable) {
  const parts = [];
  let total = 0;
  for await (const chunk of chunkIterable) {
    parts.push(chunk);
    total += chunk.byteLength;
    if (total >= 64 * 1024) break;
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.byteLength; }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  return detectFormat(lines);
}

function pct(part, total) {
  if (!total) return '0.0';
  return ((part / total) * 100).toFixed(1);
}

function report(label, profile, wallMs) {
  // zipReadMs/inflateMs are a breakdown of inflateOrReadMs (time spent
  // waiting on the byte iterable), so they are not added into accounted.
  // feedParseMs/feedDerivedMs/feedSeriesMs/feedForensicsMs/feedStatsMs
  // likewise break down feedLineMs.
  const phases = [
    'inflateOrReadMs', 'zipReadMs', 'inflateMs', 'decodeMs', 'splitMs',
    'feedLineMs', 'feedParseMs', 'feedDerivedMs', 'feedSeriesMs', 'feedForensicsMs', 'feedStatsMs',
    'progressMs', 'yieldWaitMs', 'applyMs'
  ];
  const accountedKeys = ['inflateOrReadMs', 'decodeMs', 'splitMs', 'feedLineMs', 'progressMs', 'yieldWaitMs', 'applyMs'];
  const accounted = accountedKeys.reduce((s, k) => s + (profile[k] || 0), 0);
  const rows = phases.map(k => ({
    phase: k,
    ms: Math.round(profile[k] || 0),
    pct: pct(profile[k] || 0, wallMs)
  }));
  const rec = {
    label,
    wall_ms: Math.round(wallMs),
    wall_s: Math.round(wallMs / 100) / 10,
    accounted_ms: Math.round(accounted),
    accounted_pct: pct(accounted, wallMs),
    bytes: profile.bytes,
    chunkCount: profile.chunkCount,
    lineCount: profile.lineCount,
    nonemptyLineCount: profile.nonemptyLineCount,
    yieldCount: profile.yieldCount,
    mb_per_s: profile.bytes ? ((profile.bytes / (1024 * 1024)) / (wallMs / 1000)).toFixed(2) : null,
    phases: rows,
    profile
  };
  console.log(JSON.stringify(rec, null, 2));
  return rec;
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(OUT_DIR, { recursive: true });

const profile = {};
const options = { profile, yieldDelayMs: args.yieldMs };
const wall0 = performance.now();
let rec;

if (args.csv) {
  const csvPath = path.resolve(args.csv);
  const format = await detectFromFirstChunk(nodeFileChunks(csvPath));
  const src = { name: path.basename(csvPath), encoding: 'utf-8', format };
  await streamIntoSource(src, nodeFileChunks(csvPath), null, options);
  rec = report(args.label || `csv-${path.basename(csvPath)}-yield${args.yieldMs}`, profile, performance.now() - wall0);
  rec.rowCount = src.rowCount;
  rec.alarmCount = src.alarmCount;
  rec.derivedAlarmCount = src.derived?.alarmCount || 0;
  rec.formatId = format.id;
} else if (args.zip) {
  const zipPath = path.resolve(args.zip);
  const blob = new DiskBlob(zipPath);
  try {
    const format = await detectFromFirstChunk(zipEntryByteChunks({ name: args.entry }, blob, { forceDirect: true }));
    const src = { name: args.entry, encoding: 'utf-8', format };
    await streamIntoSource(src, zipEntryByteChunks({ name: args.entry }, blob, { forceDirect: true, profile }), null, options);
    rec = report(args.label || `zip-${args.entry.replace(/[\\/]/g, '_')}-yield${args.yieldMs}`, profile, performance.now() - wall0);
    rec.rowCount = src.rowCount;
    rec.alarmCount = src.alarmCount;
    rec.derivedAlarmCount = src.derived?.alarmCount || 0;
    rec.formatId = format.id;
    rec.zipBytes = blob.size;
  } finally {
    blob.close();
  }
} else {
  throw new Error('pass --csv or --zip');
}

const outPath = path.join(OUT_DIR, `${rec.label}.profile.json`.replace(/[^\w.-]+/g, '_'));
fs.writeFileSync(outPath, JSON.stringify(rec, null, 2));
console.log(`wrote ${outPath}`);
