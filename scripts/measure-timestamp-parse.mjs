/**
 * T1 measurement: naive Date.parse vs format-specific assumptions.
 * Records the machine-local "before" instant and the AEST/UTC "after"
 * instants for the Case A wall-clock string, then (when the zip is
 * present) streams a handful of incident-day D-rows.
 *
 *   node scripts/measure-timestamp-parse.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { parseTimestampMs } from '../src/series-engine.js';
import { TIMESTAMP_ASSUMPTIONS, parseDelimitedLine } from '../src/formats.js';
import { zipEntryByteChunks } from '../src/log-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CASE_A_ZIP = path.join(ROOT, 'Log_sample', 'case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip');
const UNIT_CSV = path.join(ROOT, 'tmp', 'p3', 'wdbess1_20250820.csv');
const INNER_ZIP = path.join(ROOT, 'tmp', 'p3', 'PUBLIC_NEXT_DAY_FPPMW_20250820_0000000477089848.zip');
const OUT_PATH = path.join(ROOT, 'tmp', 'timestamp-parse', 'before-after.json');

function oldParseTimestampMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const s = String(value).trim();
  if (!s) return null;
  const normalized = s.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function sampleFromText(text, source) {
  const lines = text.split(/\r?\n/);
  const header = lines.find(l => l.startsWith('I,'));
  const headerCells = parseDelimitedLine(header, ',') || [];
  const cols = headerCells.slice(4);
  const measIdx = cols.indexOf('MEASUREMENT_DATETIME');
  const unitIdx = cols.indexOf('FPP_UNITID');
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('D,')) continue;
    const cells = parseDelimitedLine(line, ',');
    if (!cells) continue;
    const rest = cells.slice(4);
    const unit = rest[unitIdx];
    if (unit !== 'WDBESS1') continue;
    const wall = rest[measIdx];
    rows.push({
      unit,
      wall,
      before: iso(oldParseTimestampMs(wall)),
      afterAest: iso(parseTimestampMs(wall, TIMESTAMP_ASSUMPTIONS['aemo-mms'])),
      afterUtc: iso(parseTimestampMs(wall, TIMESTAMP_ASSUMPTIONS.generic))
    });
    if (rows.length >= 8) break;
  }
  return { source, rows };
}

class DiskBlob {
  constructor(filePath) {
    this.filePath = filePath;
    this.size = fs.statSync(filePath).size;
    this.fd = fs.openSync(filePath, 'r');
  }
  slice(start, end) {
    const length = (end === undefined ? this.size : end) - start;
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

async function sampleFromInnerZip(zipPath) {
  const blob = new DiskBlob(zipPath);
  const zipBytes = Buffer.allocUnsafe(blob.size);
  fs.readSync(blob.fd, zipBytes, 0, blob.size, 0);
  const zip = await JSZip.loadAsync(zipBytes);
  const entry = zip.file(/\.csv$/i)[0];
  if (!entry) {
    blob.close();
    return { source: zipPath, rows: [] };
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let leftover = '';
  let header = null;
  let measIdx = -1;
  let unitIdx = -1;
  const rows = [];
  const flush = (line) => {
    if (!line) return false;
    if (line.startsWith('I,')) {
      header = line;
      const cols = (parseDelimitedLine(header, ',') || []).slice(4);
      measIdx = cols.indexOf('MEASUREMENT_DATETIME');
      unitIdx = cols.indexOf('FPP_UNITID');
      return false;
    }
    if (!line.startsWith('D,') || measIdx < 0) return false;
    const cells = parseDelimitedLine(line, ',');
    if (!cells) return false;
    const rest = cells.slice(4);
    if ((rest[unitIdx] || '').trim() !== 'WDBESS1') return false;
    const wall = rest[measIdx];
    rows.push({
      unit: 'WDBESS1',
      wall,
      before: iso(oldParseTimestampMs(wall)),
      afterAest: iso(parseTimestampMs(wall, TIMESTAMP_ASSUMPTIONS['aemo-mms'])),
      afterUtc: iso(parseTimestampMs(wall, TIMESTAMP_ASSUMPTIONS.generic))
    });
    return rows.length >= 8;
  };
  for await (const chunk of zipEntryByteChunks(entry, blob)) {
    const text = decoder.decode(chunk, { stream: true });
    const combined = leftover + text;
    const lines = combined.split(/\r?\n/);
    leftover = lines.pop();
    for (const line of lines) {
      if (flush(line.trim())) {
        blob.close();
        return { source: zipPath + '!' + entry.name, rows };
      }
    }
  }
  flush((leftover + decoder.decode()).trim());
  blob.close();
  return { source: zipPath + '!' + entry.name, rows };
}

async function sampleIncidentRows() {
  if (fs.existsSync(UNIT_CSV)) {
    return sampleFromText(fs.readFileSync(UNIT_CSV, 'utf8'), UNIT_CSV);
  }
  if (fs.existsSync(INNER_ZIP)) return sampleFromInnerZip(INNER_ZIP);
  return { source: null, rows: [], note: `missing ${INNER_ZIP}` };
}

const wall = '2025/08/19 12:15:00';
const beforeMs = oldParseTimestampMs(wall);
const afterAestMs = parseTimestampMs(wall, TIMESTAMP_ASSUMPTIONS['aemo-mms']);
const afterLfpMs = parseTimestampMs(wall, TIMESTAMP_ASSUMPTIONS['lfp-cell-array']);
const sample = await sampleIncidentRows();
const report = {
  machineTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  machineOffsetMinutes: -new Date().getTimezoneOffset(),
  canonical: {
    wall,
    beforeLocalDateParse: iso(beforeMs),
    afterAemoAssumedAest: iso(afterAestMs),
    afterLfpAssumedUtc: iso(afterLfpMs),
    shiftMs: afterAestMs - beforeMs,
    expectedIfKst: '2025-08-19T03:15:00.000Z',
    expectedIfAest: '2025-08-19T02:15:00.000Z'
  },
  zonedUnchanged: {
    input: '2025-08-19T12:15:00Z',
    before: iso(oldParseTimestampMs('2025-08-19T12:15:00Z')),
    after: iso(parseTimestampMs('2025-08-19T12:15:00Z', TIMESTAMP_ASSUMPTIONS['aemo-mms']))
  },
  epochUnchanged: {
    input: 1700000000000,
    before: oldParseTimestampMs(1700000000000),
    after: parseTimestampMs(1700000000000, TIMESTAMP_ASSUMPTIONS['aemo-mms'])
  },
  incidentDaySample: sample
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`wrote ${OUT_PATH}`);
