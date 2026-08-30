/**
 * P1 real-data verification: stream the extracted WDBESS1 rows from the
 * `_20250820_` NEXT_DAY file (trading day 2025-08-19) through the live
 * AEMO adapter and report whether a target-deviation derived alarm fires
 * in the 12:15–12:20 AEST window. Does not tune thresholds.
 *
 *   node scripts/verify-deviation-detection.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAccumulator, feedLine, applyAccumulatorToSource } from '../src/log-engine.js';
import { AEMO_MMS_FORMAT } from '../src/formats.js';
import { buildFigures } from '../src/figures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'tmp', 'p3', 'wdbess1_20250820.csv');
const OUT_PATH = path.join(ROOT, 'tmp', 'p3', 'p1-verification.json');

function inAestWindow(measurement, interval) {
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
}

function finiteNumber(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`missing ${CSV_PATH} — run scripts/measure-deviation-columns.mjs first`);
  }
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const acc = makeAccumulator(AEMO_MMS_FORMAT);
  const windowHits = [];
  let windowDevAlarms = 0;
  let windowMwAlarms = 0;
  let windowRows = 0;
  let minWindowDev = Infinity;
  let maxWindowDev = -Infinity;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const before = acc.groups?.WDBESS1?.derived?.alarmCount || 0;
    const beforeReasons = { ...(acc.groups?.WDBESS1?.derived?.reasonCounts || {}) };
    feedLine(acc, line);
    if (!line.startsWith('D,')) continue;
    const recent = acc.groups?.WDBESS1?.recentWindow;
    const row = recent && recent.length ? recent[recent.length - 1] : null;
    if (!row || row.FPP_UNITID !== 'WDBESS1') continue;
    const measurement = row.MEASUREMENT_DATETIME;
    const interval = row.INTERVAL_DATETIME;
    const dev = finiteNumber(row.DEVIATION_MW);
    if (!inAestWindow(measurement, interval)) continue;
    windowRows++;
    if (dev !== null) {
      if (dev < minWindowDev) minWindowDev = dev;
      if (dev > maxWindowDev) maxWindowDev = dev;
    }
    const after = acc.groups?.WDBESS1?.derived?.alarmCount || 0;
    const afterReasons = acc.groups?.WDBESS1?.derived?.reasonCounts || {};
    const fired = after > before;
    const newReasons = Object.keys(afterReasons).filter(k => (afterReasons[k] || 0) > (beforeReasons[k] || 0));
    const reason = newReasons.join(' | ');
    if (reason.includes('DEVIATION_MW')) windowDevAlarms++;
    if (reason.includes('MEASURED_MW')) windowMwAlarms++;
    windowHits.push({
      measurement,
      interval,
      measuredMw: finiteNumber(row.MEASURED_MW),
      scheduledMw: finiteNumber(row.SCHEDULED_MW),
      deviationMw: dev,
      derivedFired: fired,
      reasonCode: reason || null
    });
  }

  const src = { name: 'wdbess1_20250820.csv', encoding: 'utf-8', format: AEMO_MMS_FORMAT };
  applyAccumulatorToSource(src, acc);
  const derived = src.groups.WDBESS1.derived;
  const figures = buildFigures([{
    formatId: 'aemo-mms',
    seriesByEntity: src.seriesByEntity,
    entityFilter: 'WDBESS1'
  }]);
  const af6 = figures.find(f => f.id === 'A-F6');
  const af1 = figures.find(f => f.id === 'A-F1');

  const report = {
    source: path.relative(ROOT, CSV_PATH),
    rowCount: src.groups.WDBESS1.rowCount,
    seriesSignals: src.seriesByEntity.WDBESS1.signals,
    derived: {
      label: derived.label,
      alarmCount: derived.alarmCount,
      reasonCounts: derived.reasonCounts,
      categoryCounts: derived.categoryCounts,
      deviationAbs: derived.metricStats.deviationAbs || null,
      deviationRobustZ: derived.metricStats.deviationRobustZ || null,
      mwRobustZ: derived.metricStats.mwRobustZ || null
    },
    windowAest1215to1220: {
      rowCount: windowRows,
      minDeviationMw: Number.isFinite(minWindowDev) ? minWindowDev : null,
      maxDeviationMw: Number.isFinite(maxWindowDev) ? maxWindowDev : null,
      deviationRuleFires: windowDevAlarms,
      measuredMwRuleFires: windowMwAlarms,
      detected: windowDevAlarms > 0,
      fires: windowHits.filter(h => h.derivedFired)
    },
    figures: {
      'A-F1': {
        available: Boolean(af1?.available),
        unavailableReason: af1?.unavailableReason || null,
        eventDeltaMw: af1?.summaryStats?.eventDeltaMw ?? null
      },
      'A-F6': {
        available: Boolean(af6?.available),
        unavailableReason: af6?.unavailableReason || null,
        claim: af6?.claim || null,
        minDeviationMw: af6?.summaryStats?.minDeviationMw ?? null,
        maxDeviationMw: af6?.summaryStats?.maxDeviationMw ?? null,
        eventDeviationMw: af6?.summaryStats?.eventDeviationMw ?? null
      }
    }
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('wrote', OUT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
