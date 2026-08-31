/**
 * P3 measurement: how MEASURED_MW, SCHEDULED_MW, and DEVIATION_MW relate
 * on the Case A incident-day NEXT_DAY file. Streams only; does not change
 * detection rules. Writes tmp/p3/column-relation.json.
 *
 *   node scripts/measure-deviation-columns.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { zipEntryByteChunks } from '../src/log-engine.js';
import { parseDelimitedLine, TIMESTAMP_ASSUMPTIONS } from '../src/formats.js';
import { parseTimestampMs } from '../src/series-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INNER_ZIP = path.join(
  ROOT, 'tmp', 'p3', 'PUBLIC_NEXT_DAY_FPPMW_20250820_0000000477089848.zip'
);
const ENTRY_NAME = 'PUBLIC_NEXT_DAY_FPPMW_20250820_0000000477089848.CSV';
const OUT_PATH = path.join(ROOT, 'tmp', 'p3', 'column-relation.json');
const UNIT_CSV_PATH = path.join(ROOT, 'tmp', 'p3', 'wdbess1_20250820.csv');
const UNIT = 'WDBESS1';
const AEMO_COL_OFFSET = 4;

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

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - i) + sorted[hi] * (i - lo);
}

function median(sorted) {
  return quantile(sorted, 0.5);
}

function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((s, v) => s + v, 0);
  const mean = sum / values.length;
  const med = median(sorted);
  const absDev = values.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: med,
    mad: median(absDev),
    p01: quantile(sorted, 0.01),
    p05: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99)
  };
}

async function main() {
  if (!fs.existsSync(INNER_ZIP)) {
    throw new Error(`missing ${INNER_ZIP} — extract the 20250820 inner zip first`);
  }
  const blob = new DiskBlob(INNER_ZIP);
  const zipBytes = Buffer.allocUnsafe(blob.size);
  fs.readSync(blob.fd, zipBytes, 0, blob.size, 0);
  const zip = await JSZip.loadAsync(zipBytes);
  const entry = zip.file(ENTRY_NAME);
  if (!entry) throw new Error(`missing entry ${ENTRY_NAME}`);

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let leftover = '';
  let columns = null;
  let idx = {};
  let totalLines = 0;
  let dataRows = 0;
  let unitRows = 0;
  let missingDev = 0;
  let missingSched = 0;
  let missingMeas = 0;
  let bothFinite = 0;
  const absResidual = [];
  const residualBuckets = { exact: 0, le1e6: 0, le1e4: 0, le1e2: 0, le1e1: 0, gt1e1: 0 };
  const measured = [];
  const scheduled = [];
  const deviation = [];
  const computed = [];
  const absDeviation = [];
  const windowRows = [];
  const mismatchRows = [];
  const largeAbsDev = [];
  const tMinMax = { min: Infinity, max: -Infinity };
  let headerLine = null;
  let commentLine = null;
  const unitLines = [];

  // CSV timestamps are AEST wall-clock without a zone suffix. Do not use
  // Date.parse (local TZ). Match the AEMO 12:15–12:20 AEST interval by string.
  const inAestWindow = (measurement, interval) => {
    const m = String(measurement || '');
    const iv = String(interval || '');
    const measHit = m.startsWith('2025/08/19 12:15')
      || m.startsWith('2025/08/19 12:16')
      || m.startsWith('2025/08/19 12:17')
      || m.startsWith('2025/08/19 12:18')
      || m.startsWith('2025/08/19 12:19')
      || m === '2025/08/19 12:20:00';
    const intervalHit = iv === '2025/08/19 12:20:00' || iv.startsWith('2025/08/19 12:20');
    return measHit || intervalHit;
  };

  const flushLine = (line) => {
    if (!line) return;
    totalLines++;
    if (line.startsWith('C,')) {
      if (!commentLine) commentLine = line;
      return;
    }
    if (line.startsWith('I,')) {
      headerLine = line;
      const cells = parseDelimitedLine(line, ',') || [];
      columns = cells.slice(AEMO_COL_OFFSET);
      columns.forEach((c, i) => { idx[c] = i; });
      return;
    }
    if (!line.startsWith('D,') || !columns) return;
    dataRows++;
    if (!line.includes(UNIT)) return;
    const cells = parseDelimitedLine(line, ',');
    if (!cells) return;
    const row = cells.slice(AEMO_COL_OFFSET);
    const unit = (row[idx.FPP_UNITID] || '').trim();
    if (unit !== UNIT) return;
    unitLines.push(line);
    unitRows++;
    const meas = finiteNumber(row[idx.MEASURED_MW]);
    const sched = finiteNumber(row[idx.SCHEDULED_MW]);
    const dev = finiteNumber(row[idx.DEVIATION_MW]);
    const t = parseTimestampMs(
      row[idx.MEASUREMENT_DATETIME] || row[idx.INTERVAL_DATETIME],
      TIMESTAMP_ASSUMPTIONS['aemo-mms']
    );
    if (Number.isFinite(t)) {
      if (t < tMinMax.min) tMinMax.min = t;
      if (t > tMinMax.max) tMinMax.max = t;
    }
    if (meas === null) missingMeas++;
    if (sched === null) missingSched++;
    if (dev === null) missingDev++;
    if (meas !== null) measured.push(meas);
    if (sched !== null) scheduled.push(sched);
    if (dev !== null) {
      deviation.push(dev);
      absDeviation.push(Math.abs(dev));
    }
    const quality = finiteNumber(row[idx.MW_QUALITY_FLAG]);
    if (meas !== null && sched !== null) {
      const delta = meas - sched;
      computed.push(delta);
      if (dev !== null) {
        bothFinite++;
        const r = Math.abs(delta - dev);
        absResidual.push(r);
        if (r === 0) residualBuckets.exact++;
        else if (r <= 1e-6) residualBuckets.le1e6++;
        else if (r <= 1e-4) residualBuckets.le1e4++;
        else if (r <= 1e-2) residualBuckets.le1e2++;
        else if (r <= 0.1) residualBuckets.le1e1++;
        else {
          residualBuckets.gt1e1++;
          mismatchRows.push({
            measurement: row[idx.MEASUREMENT_DATETIME],
            interval: row[idx.INTERVAL_DATETIME],
            quality,
            measuredMw: meas,
            scheduledMw: sched,
            deviationMw: dev,
            measuredMinusScheduled: delta,
            absResidual: r
          });
        }
      }
    }
    if (dev !== null && Math.abs(dev) >= 50) {
      largeAbsDev.push({
        measurement: row[idx.MEASUREMENT_DATETIME],
        interval: row[idx.INTERVAL_DATETIME],
        quality,
        measuredMw: meas,
        scheduledMw: sched,
        deviationMw: dev
      });
    }
    if (inAestWindow(row[idx.MEASUREMENT_DATETIME], row[idx.INTERVAL_DATETIME])) {
      windowRows.push({
        measurement: row[idx.MEASUREMENT_DATETIME],
        interval: row[idx.INTERVAL_DATETIME],
        quality,
        measuredMw: meas,
        scheduledMw: sched,
        deviationMw: dev,
        measuredMinusScheduled: (meas !== null && sched !== null) ? meas - sched : null
      });
    }
  };

  for await (const chunk of zipEntryByteChunks(entry, blob)) {
    const text = decoder.decode(chunk, { stream: true });
    const combined = leftover + text;
    const lines = combined.split(/\r?\n/);
    leftover = lines.pop();
    for (const line of lines) flushLine(line.trim());
  }
  const tail = decoder.decode();
  flushLine((leftover + tail).trim());
  blob.close();

  const report = {
    source: {
      innerZip: path.relative(ROOT, INNER_ZIP),
      entry: ENTRY_NAME,
      unit: UNIT,
      headerLine,
      columns
    },
    counts: {
      totalLines,
      dataRows,
      unitRows,
      missingMeas,
      missingSched,
      missingDev,
      bothFinite
    },
    timeRange: {
      minIso: Number.isFinite(tMinMax.min) ? new Date(tMinMax.min).toISOString() : null,
      maxIso: Number.isFinite(tMinMax.max) ? new Date(tMinMax.max).toISOString() : null
    },
    identity: {
      description: 'MEASURED_MW − SCHEDULED_MW versus DEVIATION_MW',
      residualBuckets,
      residual: summarize(absResidual),
      maxAbsResidual: absResidual.length ? Math.max(...absResidual) : null
    },
    distributions: {
      measuredMw: summarize(measured),
      scheduledMw: summarize(scheduled),
      deviationMw: summarize(deviation),
      absDeviationMw: summarize(absDeviation),
      measuredMinusScheduled: summarize(computed)
    },
    mismatchesGt0p1Mw: {
      count: mismatchRows.length,
      rows: mismatchRows
    },
    absDeviationAtLeast50: {
      count: largeAbsDev.length,
      minDeviationMw: largeAbsDev.reduce((m, r) => Math.min(m, r.deviationMw), Infinity),
      maxDeviationMw: largeAbsDev.reduce((m, r) => Math.max(m, r.deviationMw), -Infinity),
      first: largeAbsDev[0] || null,
      last: largeAbsDev[largeAbsDev.length - 1] || null,
      mostNegative: largeAbsDev.reduce((b, r) => (!b || r.deviationMw < b.deviationMw) ? r : b, null),
      rowsEveryNth: largeAbsDev.filter((_, i) => i % Math.max(1, Math.floor(largeAbsDev.length / 12)) === 0)
    },
    windowAest1215to1220: {
      note: 'CSV AEST wall-clock MEASUREMENT_DATETIME 12:15–12:20 inclusive of 12:20:00, plus INTERVAL_DATETIME 12:20',
      rowCount: windowRows.length,
      deviationMw: summarize(windowRows.map(r => r.deviationMw).filter(v => v !== null)),
      measuredMinusScheduled: summarize(windowRows.map(r => r.measuredMinusScheduled).filter(v => v !== null)),
      minDeviationMw: windowRows.reduce((m, r) => (r.deviationMw !== null && r.deviationMw < m) ? r.deviationMw : m, Infinity),
      maxDeviationMw: windowRows.reduce((m, r) => (r.deviationMw !== null && r.deviationMw > m) ? r.deviationMw : m, -Infinity),
      minMeasuredMinusScheduled: windowRows.reduce((m, r) => (r.measuredMinusScheduled !== null && r.measuredMinusScheduled < m) ? r.measuredMinusScheduled : m, Infinity),
      sample: windowRows.filter((_, i) => i % 10 === 0 || i === windowRows.length - 1)
    }
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  const csvOut = [commentLine, headerLine, ...unitLines].filter(Boolean).join('\n') + '\n';
  fs.writeFileSync(UNIT_CSV_PATH, csvOut);
  console.log(JSON.stringify({
    counts: report.counts,
    identity: report.identity,
    distributions: report.distributions,
    mismatchCount: report.mismatchesGt0p1Mw.count,
    mismatchQuality: [...new Set(report.mismatchesGt0p1Mw.rows.map(r => r.quality))],
    absDeviationAtLeast50: {
      count: report.absDeviationAtLeast50.count,
      mostNegative: report.absDeviationAtLeast50.mostNegative,
      first: report.absDeviationAtLeast50.first
    },
    windowAest1215to1220: {
      rowCount: report.windowAest1215to1220.rowCount,
      minDeviationMw: report.windowAest1215to1220.minDeviationMw,
      maxDeviationMw: report.windowAest1215to1220.maxDeviationMw,
      sample: report.windowAest1215to1220.sample
    }
  }, null, 2));
  console.log('wrote', OUT_PATH);
  console.log('wrote', UNIT_CSV_PATH, 'lines', unitLines.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
