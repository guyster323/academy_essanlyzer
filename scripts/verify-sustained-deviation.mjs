/**
 * T1 real-data verification: stream WDBESS1 rows from the `_20250820_`
 * NEXT_DAY file (trading day 2025-08-19) through the live AEMO adapter and
 * list every window the sustained-deviation rule fires on. Does not tune
 * thresholds to a published event.
 *
 *   node scripts/verify-sustained-deviation.mjs
 *
 * Prefers tmp/p3/wdbess1_20250820.csv when present; otherwise streams the
 * inner zip and caches that unit CSV.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { zipEntryByteChunks, makeAccumulator, feedLine, applyAccumulatorToSource } from '../src/log-engine.js';
import { AEMO_MMS_FORMAT, parseDelimitedLine } from '../src/formats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INNER_ZIP = path.join(
  ROOT, 'tmp', 'p3', 'PUBLIC_NEXT_DAY_FPPMW_20250820_0000000477089848.zip'
);
const ENTRY_NAME = 'PUBLIC_NEXT_DAY_FPPMW_20250820_0000000477089848.CSV';
const UNIT_CSV_PATH = path.join(ROOT, 'tmp', 'p3', 'wdbess1_20250820.csv');
const OUT_PATH = path.join(ROOT, 'tmp', 'p3', 'sustained-verification.json');
const UNIT = 'WDBESS1';
const AEMO_COL_OFFSET = 4;
const SUSTAINED_CODE = 'DEVIATION_MW sustained deviation';

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

function finiteNumber(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

async function ensureUnitCsv() {
  if (fs.existsSync(UNIT_CSV_PATH)) {
    return fs.readFileSync(UNIT_CSV_PATH, 'utf8');
  }
  if (!fs.existsSync(INNER_ZIP)) {
    throw new Error(`missing ${INNER_ZIP} and ${UNIT_CSV_PATH}`);
  }
  const blob = new DiskBlob(INNER_ZIP);
  const zipBytes = Buffer.allocUnsafe(blob.size);
  fs.readSync(blob.fd, zipBytes, 0, blob.size, 0);
  const zip = await JSZip.loadAsync(zipBytes);
  const entry = zip.file(ENTRY_NAME);
  if (!entry) throw new Error(`missing entry ${ENTRY_NAME}`);

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let leftover = '';
  let headerLine = null;
  let commentLine = null;
  const unitLines = [];

  const flushLine = (line) => {
    if (!line) return;
    if (line.startsWith('C,')) {
      if (!commentLine) commentLine = line;
      return;
    }
    if (line.startsWith('I,')) {
      headerLine = line;
      return;
    }
    if (!line.startsWith('D,') || !headerLine) return;
    if (!line.includes(UNIT)) return;
    const cells = parseDelimitedLine(line, ',');
    if (!cells) return;
    const cols = (parseDelimitedLine(headerLine, ',') || []).slice(AEMO_COL_OFFSET);
    const row = cells.slice(AEMO_COL_OFFSET);
    const idx = cols.indexOf('FPP_UNITID');
    if (idx < 0 || (row[idx] || '').trim() !== UNIT) return;
    unitLines.push(line);
  };

  for await (const chunk of zipEntryByteChunks(entry, blob)) {
    const text = decoder.decode(chunk, { stream: true });
    const combined = leftover + text;
    const lines = combined.split(/\r?\n/);
    leftover = lines.pop();
    for (const line of lines) flushLine(line.trim());
  }
  flushLine((leftover + decoder.decode()).trim());
  blob.close();

  const text = [commentLine, headerLine, ...unitLines].filter(Boolean).join('\n') + '\n';
  fs.mkdirSync(path.dirname(UNIT_CSV_PATH), { recursive: true });
  fs.writeFileSync(UNIT_CSV_PATH, text);
  return text;
}

function parseRow(line, columns) {
  const cells = parseDelimitedLine(line, ',');
  if (!cells) return null;
  const row = cells.slice(AEMO_COL_OFFSET);
  const obj = {};
  columns.forEach((c, i) => { obj[c] = row[i]; });
  return obj;
}

function rulesOf(result) {
  return (result && result.details && result.details.rulesFired) || [];
}

async function main() {
  const text = await ensureUnitCsv();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const headerLine = lines.find(l => l.startsWith('I,'));
  if (!headerLine) throw new Error('no I-row header in unit CSV');
  const columns = (parseDelimitedLine(headerLine, ',') || []).slice(AEMO_COL_OFFSET);

  const bucket = {};
  const acc = {};
  const fires = [];
  const windows = [];
  const reasonTally = {};
  let rowCount = 0;
  let quality0Rows = 0;
  let quality0DuringRun = 0;
  let current = null;

  const closeWindow = () => {
    if (!current) return;
    windows.push(current);
    current = null;
  };

  const extendWindow = (fire) => {
    if (!current) {
      current = {
        start: fire.measurement,
        end: fire.measurement,
        intervalStart: fire.interval,
        intervalEnd: fire.interval,
        rows: 0,
        minDeviationMw: fire.deviationMw,
        maxDeviationMw: fire.deviationMw,
        minAbsDeviationMw: Math.abs(fire.deviationMw),
        maxAbsDeviationMw: Math.abs(fire.deviationMw),
        maxRunCount: fire.sustainedRunCount,
        reasonCodes: {}
      };
    }
    current.end = fire.measurement;
    current.intervalEnd = fire.interval;
    current.rows++;
    if (fire.deviationMw < current.minDeviationMw) current.minDeviationMw = fire.deviationMw;
    if (fire.deviationMw > current.maxDeviationMw) current.maxDeviationMw = fire.deviationMw;
    const abs = Math.abs(fire.deviationMw);
    if (abs < current.minAbsDeviationMw) current.minAbsDeviationMw = abs;
    if (abs > current.maxAbsDeviationMw) current.maxAbsDeviationMw = abs;
    if (fire.sustainedRunCount > current.maxRunCount) current.maxRunCount = fire.sustainedRunCount;
    current.reasonCodes[fire.reasonCode] = (current.reasonCodes[fire.reasonCode] || 0) + 1;
  };

  for (const line of lines) {
    if (!line.startsWith('D,')) continue;
    const row = parseRow(line, columns);
    if (!row || row.FPP_UNITID !== UNIT) continue;
    rowCount++;
    const quality = finiteNumber(row.MW_QUALITY_FLAG);
    if (quality === 0) quality0Rows++;
    const result = AEMO_MMS_FORMAT.computeDerivedAlarm(row, acc, bucket);
    const rules = rulesOf(result);
    const key = rules.length ? rules.join(' + ') : '(none)';
    reasonTally[key] = (reasonTally[key] || 0) + 1;
    if (quality === 0 && (result?.metrics?.sustainedRunCount || 0) > 0) quality0DuringRun++;
    if (!rules.includes(SUSTAINED_CODE)) {
      closeWindow();
      continue;
    }
    const fire = {
      measurement: row.MEASUREMENT_DATETIME,
      interval: row.INTERVAL_DATETIME,
      quality,
      measuredMw: finiteNumber(row.MEASURED_MW),
      scheduledMw: finiteNumber(row.SCHEDULED_MW),
      deviationMw: finiteNumber(row.DEVIATION_MW),
      sustainedRunCount: result.metrics.sustainedRunCount,
      reasonCode: result.reasonCode
    };
    fires.push(fire);
    extendWindow(fire);
  }
  closeWindow();

  const acc2 = makeAccumulator(AEMO_MMS_FORMAT);
  for (const line of lines) {
    if (!line.trim()) continue;
    feedLine(acc2, line);
  }
  const src = { name: 'wdbess1_20250820.csv', encoding: 'utf-8', format: AEMO_MMS_FORMAT };
  applyAccumulatorToSource(src, acc2);
  const derived = src.groups.WDBESS1.derived;

  const sustainedRowFires = fires.length;
  const windowCount = windows.length;
  const overDetect = windowCount >= 100 || sustainedRowFires >= 2000;

  const report = {
    source: path.relative(ROOT, UNIT_CSV_PATH),
    unit: UNIT,
    rowCount,
    quality0Rows,
    quality0DuringRun,
    thresholds: {
      absMw: 12,
      samples: 75,
      justification: 'p75 of incident-day WDBESS1 |DEVIATION_MW| (11.76 MW, rounded to 12) and one 5-minute AEMO dispatch interval at 4 s sampling. Not fitted to a published event.'
    },
    perRowReasonTally: reasonTally,
    engineReasonCounts: derived.reasonCounts,
    engineAlarmCount: derived.alarmCount,
    engineLabel: derived.label,
    engineWindows: src.sustainedWindows || [],
    engineWindowsDropped: src.sustainedWindowsDropped || 0,
    sustained: {
      rowFires: sustainedRowFires,
      windowCount,
      overDetect,
      overDetectNote: overDetect
        ? 'Volume looks like over-detection (windows >= 100 or row fires >= 2000). Thresholds were not raised to hide this.'
        : 'Window count is under 100 and row fires under 2000; not flagged as over-detection.',
      windows
    }
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    rowCount,
    quality0Rows,
    engineAlarmCount: derived.alarmCount,
    engineReasonCounts: derived.reasonCounts,
    sustainedRowFires,
    windowCount,
    overDetect,
    windows: windows.map(w => ({
      start: w.start,
      end: w.end,
      rows: w.rows,
      minDeviationMw: w.minDeviationMw,
      maxDeviationMw: w.maxDeviationMw,
      maxAbsDeviationMw: w.maxAbsDeviationMw,
      maxRunCount: w.maxRunCount
    }))
  }, null, 2));
  console.log('wrote', OUT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
