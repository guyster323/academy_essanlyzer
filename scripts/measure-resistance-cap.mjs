/**
 * Stream an LFP log through the same engine the UI uses, then compute
 * B-F1 / B-F4 / attribution from the retained resistance events.
 *
 *   node scripts/measure-resistance-cap.mjs --csv Log_sample/extracted/data_sys_6_stride80.csv
 *   node scripts/measure-resistance-cap.mjs --zip Log_sample/case_b_field_data.zip --entry field_data/data_sys_6.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { streamIntoSource, zipEntryByteChunks, CHUNK_BYTES } from '../src/log-engine.js';
import { detectFormat } from '../src/formats.js';
import { buildFigures } from '../src/figures.js';
import { detectAttributionConflict } from '../src/attribution-conflict.js';
import { normalizeResistanceEvents } from '../src/forensics/lfp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'resistance-cap');

function parseArgs(argv) {
  const out = { csv: null, zip: null, entry: 'field_data/data_sys_6.csv', label: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--csv') out.csv = next();
    else if (a === '--zip') out.zip = next();
    else if (a === '--entry') out.entry = next();
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

function largestInternalGap(events) {
  let gap = 0;
  let from = null;
  let to = null;
  for (let i = 1; i < events.length; i++) {
    const dt = events[i].t - events[i - 1].t;
    if (dt > gap) {
      gap = dt;
      from = events[i - 1].t;
      to = events[i].t;
    }
  }
  return {
    gapMs: gap,
    gapDays: gap / 86400000,
    from: from != null ? new Date(from).toISOString() : null,
    to: to != null ? new Date(to).toISOString() : null
  };
}

function summarize(src, wallMs) {
  const lists = Object.values(src.resistanceEventsByEntity || {});
  lists.forEach(list => normalizeResistanceEvents(list));
  const events = lists[0] || [];
  const block = {
    label: src.name || src.path,
    formatId: src.format?.id || 'lfp-cell-array',
    derived: src.derived,
    seriesByEntity: src.seriesByEntity,
    resistanceEventsByEntity: src.resistanceEventsByEntity,
    droppedResistanceEvents: src.droppedResistanceEvents
  };
  const figures = buildFigures([block]);
  const bf1 = figures.find(f => f.id === 'B-F1') || {};
  const bf4 = figures.find(f => f.id === 'B-F4') || {};
  const bf5 = figures.find(f => f.id === 'B-F5') || {};
  const conflict = detectAttributionConflict({ blocks: [block], figures });
  const span = src.dataTimeRange;
  const spanDays = span ? (span.maxMs - span.minMs) / 86400000 : null;
  const gap = largestInternalGap(events);
  return {
    capturedAt: new Date().toISOString(),
    wallMs: Math.round(wallMs),
    wallMin: Math.round(wallMs / 6000) / 10,
    rowCount: src.rowCount,
    derivedAlarmCount: src.derived?.alarmCount || 0,
    outlierCellVdev: src.derived?.categoryCounts?.outlierCell || {},
    droppedResistanceEvents: src.droppedResistanceEvents,
    resistanceEventYearCounts: src.resistanceEventYearCounts,
    resistanceEventTimeDistribution: src.resistanceEventTimeDistribution,
    eventCount: events.length,
    firstEventT: events[0] ? new Date(events[0].t).toISOString() : null,
    lastEventT: events.length ? new Date(events[events.length - 1].t).toISOString() : null,
    dataTimeRange: src.dataTimeRange,
    spanDays,
    largestGap: gap,
    gapFractionOfSpan: spanDays ? gap.gapDays / spanDays : null,
    bf1: {
      available: bf1.available,
      claim: bf1.claim,
      summaryStats: bf1.summaryStats
    },
    bf4: {
      available: bf4.available,
      unavailableReason: bf4.unavailableReason,
      claim: bf4.claim,
      summaryStats: bf4.summaryStats
    },
    bf5: {
      available: bf5.available,
      unavailableReason: bf5.unavailableReason
    },
    attributionConflict: {
      status: conflict.status,
      voltageResidual: conflict.voltageResidual,
      eventResistance: conflict.eventResistance
    }
  };
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(OUT_DIR, { recursive: true });
const wall0 = performance.now();
let src;
let blob;

if (args.csv) {
  const csvPath = path.resolve(args.csv);
  const format = await detectFromFirstChunk(nodeFileChunks(csvPath));
  src = { name: path.basename(csvPath), path: csvPath, encoding: 'utf-8', format };
  let lastLog = 0;
  await streamIntoSource(src, nodeFileChunks(csvPath), () => {
    const now = Date.now();
    if (now - lastLog > 15000) {
      lastLog = now;
      console.error(`csv rows=${src.rowCount || 0} bytes=${src.processedBytes || 0}`);
    }
  });
} else if (args.zip) {
  const zipPath = path.resolve(args.zip);
  blob = new DiskBlob(zipPath);
  const format = await detectFromFirstChunk(zipEntryByteChunks({ name: args.entry }, blob, { forceDirect: true }));
  src = { name: args.entry, path: args.entry, encoding: 'utf-8', format };
  let lastLog = 0;
  await streamIntoSource(src, zipEntryByteChunks({ name: args.entry }, blob, { forceDirect: true }), () => {
    const now = Date.now();
    if (now - lastLog > 15000) {
      lastLog = now;
      const pct = src.sizeBytes ? Math.round(100 * (src.processedBytes || 0) / src.sizeBytes) : 0;
      console.error(`zip ${pct}% rows=${src.rowCount || 0} droppedR=${src.droppedResistanceEvents || 0}`);
    }
  });
} else {
  throw new Error('pass --csv or --zip');
}

if (blob) blob.close();
const rec = summarize(src, performance.now() - wall0);
const label = args.label
  || (args.csv ? `csv-${path.basename(args.csv)}` : `zip-${args.entry.replace(/[\\/]/g, '_')}`);
const outPath = path.join(OUT_DIR, `${label}.json`.replace(/[^\w.-]+/g, '_'));
fs.writeFileSync(outPath, JSON.stringify(rec, null, 2));
console.log(JSON.stringify(rec, null, 2));
console.error(`wrote ${outPath}`);
