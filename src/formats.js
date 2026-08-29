/* =========================================================
   LOG FORMAT ADAPTERS
   The streaming engine (log-engine.js) is format-agnostic; each adapter
   tells it how to recognize comment/header/data rows, where the real
   columns start, which column (if any) identifies a groupable entity
   (e.g. a market participant / BESS unit), which column is the primary
   timestamp, and what counts as an "alarm" row.
========================================================= */

import { parseTimestampMs } from './series-engine.js';
import { considerResistanceEvent, snapshotFromRow } from './forensics/lfp.js';

export function detectDelimiter(sampleLine) {
  const candidates = [',', '\t', ';', '|'];
  let best = ',', bestCount = -1;
  candidates.forEach(d => {
    const count = sampleLine.split(d).length - 1;
    if (count > bestCount) { bestCount = count; best = d; }
  });
  return bestCount > 0 ? best : ',';
}

/**
 * RFC4180-ish single-line CSV/TSV cell splitter: a quoted field may contain
 * the delimiter verbatim, and `""` inside a quoted field is an escaped `"`.
 * Multi-line quoted fields are out of scope (the streaming engine splits on
 * newlines before this ever runs) — a line with an unterminated quote is
 * reported as malformed (returns null) rather than silently misparsed.
 * Unquoted cells are trimmed; quoted cell content is preserved verbatim.
 */
export function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  let cellWasQuoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' && cur.length === 0 && !cellWasQuoted) {
      inQuotes = true;
      cellWasQuoted = true;
      continue;
    }
    if (c === delimiter) {
      cells.push(cellWasQuoted ? cur : cur.trim());
      cur = '';
      cellWasQuoted = false;
      continue;
    }
    cur += c;
  }
  if (inQuotes) return null; // unterminated quoted field — likely spans a newline, unsupported
  cells.push(cellWasQuoted ? cur : cur.trim());
  return cells;
}

function finiteNumber(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values, center) {
  if (values.length < 2) return 0;
  const avg = center === null || center === undefined ? mean(values) : center;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length);
}

function medianAbsoluteDeviation(values, center) {
  if (!values.length) return 0;
  const c = center === null || center === undefined ? median(values) : center;
  return median(values.map(value => Math.abs(value - c))) || 0;
}

function getDerivedState(bucket, key) {
  if (!bucket._derivedState) {
    Object.defineProperty(bucket, '_derivedState', {
      value: Object.create(null), enumerable: false, writable: true
    });
  }
  if (!bucket._derivedState[key]) bucket._derivedState[key] = Object.create(null);
  return bucket._derivedState[key];
}

// Operational states that a free-text "status"-named column may legitimately
// hold without indicating an alarm. Only applied when no dedicated
// alarm/fault column exists — see alarmColumnGuess below.
const NORMAL_STATUS_VALUES = new Set(['OK', 'NORMAL', 'CHARGING', 'DISCHARGING', 'IDLE', 'STANDBY', 'RUNNING', 'READY', '0']);

function isStatusOnlyColumn(columnName) {
  const c = columnName || '';
  return /status/i.test(c) && !/alarm|fault/i.test(c);
}

/* ---- Generic single-header-row CSV/TSV (typical BMS/EMS export) ---- */
export const GENERIC_FORMAT = {
  id: 'generic',
  label: '일반 CSV/TSV',
  isCommentRow: () => false,
  isHeaderRow: (line, acc) => acc.columns === null,
  isDataRow: (line, acc) => acc.columns !== null,
  parseHeaderRow(line) {
    const delimiter = detectDelimiter(line);
    const cells = parseDelimitedLine(line, delimiter);
    return { columns: cells || [], colOffset: 0, delimiter };
  },
  parseDataRow(line, acc) {
    return parseDelimitedLine(line, acc.delimiter);
  },
  entityColumnGuess: () => null,
  timestampColumnGuess: (columns) => columns.find(c => /^(timestamp|time|date)/i.test(c)) || null,
  isTimestampLikeColumn: (c) => /^(timestamp|time|date)/i.test(c),
  // Prefer an explicit alarm/fault column over a generic status column — a
  // status column reflects normal operating state most of the time, while
  // an alarm/fault column's non-zero values are inherently exceptional.
  alarmColumnGuess: (columns) => columns.find(c => /alarm|fault/i.test(c)) || columns.find(c => /status/i.test(c)) || null,
  isAlarmValue(v, columnName) {
    const s = (v || '').trim();
    if (!s) return false;
    if (isStatusOnlyColumn(columnName)) {
      // Free-text operational status: only values outside the known-normal
      // set count as an alarm (so "Charging"/"Idle"/... don't get flagged).
      return !NORMAL_STATUS_VALUES.has(s.toUpperCase());
    }
    // Dedicated alarm/fault code column: any non-zero/non-OK/NORMAL value is
    // itself an alarm code (e.g. "OV001"), so keep the strict rule.
    return s !== '0' && s.toUpperCase() !== 'OK' && s.toUpperCase() !== 'NORMAL';
  },
  seriesBinMode: 'adaptive',
  seriesSignals: ['value'],
  extractSeriesSample(rowObj, acc) {
    const tsCol = acc.timestampColumn || (acc.columns || []).find(c => /^(timestamp|time|date)/i.test(c));
    const t = parseTimestampMs(tsCol ? rowObj[tsCol] : null);
    if (t == null) return null;
    const skip = new Set([tsCol, acc.alarmColumn].filter(Boolean));
    const col = (acc.columns || []).find(c => !skip.has(c) && finiteNumber(rowObj[c]) != null);
    if (!col) return null;
    return { t, values: { value: finiteNumber(rowObj[col]) } };
  }
};

/* ---- AEMO MMS standard report CSV (C=comment / I=header / D=data rows) ----
   Real columns start at field index 4 (RECORDTYPE, DATA_STREAM, TABLE, VERSION
   prefix fields precede them) — a fixed, well-known layout across AEMO MMS
   CSV extracts, e.g.:
     C,SETP.WORLD,NEXT_DAY_FPPMW,AEMO,PUBLIC,2025/08/17,...
     I,FPP,UNIT_MW,1,INTERVAL_DATETIME,MEASUREMENT_DATETIME,FPP_UNITID,...
     D,FPP,UNIT_MW,1,"2025/08/16 04:05:00","2025/08/16 04:00:04",ADPBA1,...
*/
const AEMO_COL_OFFSET = 4;

export const AEMO_MMS_FORMAT = {
  id: 'aemo-mms',
  label: 'AEMO MMS 리포트',
  isCommentRow: (line) => line.startsWith('C,'),
  isHeaderRow: (line) => line.startsWith('I,'),
  isDataRow: (line) => line.startsWith('D,'),
  parseHeaderRow(line) {
    const cells = parseDelimitedLine(line, ',') || [];
    return { columns: cells.slice(AEMO_COL_OFFSET), colOffset: AEMO_COL_OFFSET, delimiter: ',' };
  },
  parseDataRow(line) {
    return parseDelimitedLine(line, ',');
  },
  entityColumnGuess(columns) {
    if (columns.includes('FPP_UNITID')) return 'FPP_UNITID';
    if (columns.includes('PARTICIPANTID')) return 'PARTICIPANTID';
    return null;
  },
  timestampColumnGuess(columns) {
    if (columns.includes('MEASUREMENT_DATETIME')) return 'MEASUREMENT_DATETIME';
    if (columns.includes('INTERVAL_DATETIME')) return 'INTERVAL_DATETIME';
    return null;
  },
  isTimestampLikeColumn: (c) => /DATETIME/i.test(c),
  alarmColumnGuess: (columns) => (columns.includes('MW_QUALITY_FLAG') ? 'MW_QUALITY_FLAG' : null),
  isAlarmValue(v) {
    const s = (v || '').trim();
    return !!s && s !== '1'; // 1=정상, 2=대체/추정치, 0=불량
  },
  derivedLabel: 'MEASURED_MW 독립 통계 이상탐지 (rolling mean/std·MAD z-score·ramp)',
  computeDerivedAlarm(rowObj, acc, bucket) {
    const measuredMw = finiteNumber(rowObj.MEASURED_MW);
    if (measuredMw === null) return null;

    const state = getDerivedState(bucket, 'aemoMw');
    const values = state.values || (state.values = []);
    const deltas = state.deltas || (state.deltas = []);
    const previous = state.previous;
    const rollingMean = mean(values);
    const rollingMedian = median(values);
    const rollingStd = standardDeviation(values, rollingMean);
    const rollingMad = medianAbsoluteDeviation(values, rollingMedian);
    const deltaMw = previous === undefined ? null : measuredMw - previous;
    const deltaAbs = deltaMw === null ? null : Math.abs(deltaMw);
    const typicalDelta = median(deltas);

    // The floors prevent a flat baseline from making every tiny numerical
    // jitter look extreme. The decision still requires a material MW change
    // and a robust/statistical or ramp signal.
    const robustScale = Math.max(1.4826 * rollingMad, 0.5);
    const stdScale = Math.max(rollingStd, 0.5);
    const rampScale = Math.max(1.4826 * (typicalDelta || 0), 0.5);
    const deviationFromMedian = rollingMedian === null ? 0 : Math.abs(measuredMw - rollingMedian);
    const deviationFromMean = rollingMean === null ? 0 : Math.abs(measuredMw - rollingMean);
    const mwRobustZ = rollingMedian === null ? 0 : deviationFromMedian / robustScale;
    const mwStdZ = rollingMean === null ? 0 : deviationFromMean / stdScale;
    const mwRampScore = deltaAbs === null ? 0 : deltaAbs / rampScale;
    const enoughBaseline = values.length >= 8;
    const statisticalAlarm = enoughBaseline && deviationFromMedian >= 5 && (mwRobustZ >= 3 || mwStdZ >= 3);
    const rampAlarm = enoughBaseline && deltaAbs !== null && deltaAbs >= 5 && mwRampScore >= 6;
    const alarm = statisticalAlarm || rampAlarm;

    if (deltaAbs !== null) {
      deltas.push(deltaAbs);
      if (deltas.length > 15) deltas.shift();
    }
    values.push(measuredMw);
    if (values.length > 15) values.shift();
    state.previous = measuredMw;

    return {
      alarm,
      reasonCode: 'MEASURED_MW statistical/ramp anomaly',
      reason: alarm
        ? `MEASURED_MW 독립 이상 (robust z=${mwRobustZ.toFixed(2)}, ramp=${mwRampScore.toFixed(2)})`
        : '',
      metrics: {
        measuredMw,
        rollingMean: rollingMean === null ? measuredMw : rollingMean,
        rollingStd,
        mwRobustZ,
        mwStdZ,
        deltaMw: deltaMw === null ? 0 : deltaMw,
        mwRampScore
      },
      categories: { signal: 'MEASURED_MW' },
      details: {
        deviationMw: deviationFromMedian,
        rollingMean: rollingMean === null ? measuredMw : rollingMean,
        rollingStd,
        robustZ: mwRobustZ,
        rampScore: mwRampScore,
        evidenceTier: 'Derived'
      }
    };
  },
  seriesBinMode: 'adaptive',
  seriesSignals: ['mw', 'quality', 'deltaMw'],
  extractSeriesSample(rowObj, acc, bucket) {
    const t = parseTimestampMs(rowObj.MEASUREMENT_DATETIME || rowObj.INTERVAL_DATETIME);
    const mw = finiteNumber(rowObj.MEASURED_MW);
    if (t == null || mw == null) return null;
    const quality = finiteNumber(rowObj.MW_QUALITY_FLAG);
    const prev = bucket && bucket._seriesPrevMw;
    const deltaMw = prev === undefined ? 0 : mw - prev;
    if (bucket) bucket._seriesPrevMw = mw;
    return { t, values: { mw, quality: quality == null ? 1 : quality, deltaMw } };
  }
};

const LFP_CELL_COUNT = 8;
const LFP_CELL_COLUMNS = Array.from({ length: LFP_CELL_COUNT }, (_, i) => `U_Cell_${i + 1}`);
const LFP_CELL_VDEV_THRESHOLD = 0.03;
const LFP_CLOSURE_ERROR_THRESHOLD = 0.5;

function normalizedColumnName(column) {
  return String(column || '').replace(/^\uFEFF/, '').trim().toUpperCase();
}

export function isLfpCellArrayHeader(columns) {
  const normalized = new Set((columns || []).map(normalizedColumnName));
  const hasTimestamp = normalized.has('TIMESTAMP');
  const hasPackVoltage = normalized.has('U_BATTERY');
  return hasTimestamp && hasPackVoltage && LFP_CELL_COLUMNS.every(c => normalized.has(c.toUpperCase()));
}

/* ---- TU Darmstadt/MIT LFP field CSV: one file is one 8-cell system ---- */
export const LFP_CELL_ARRAY_FORMAT = {
  id: 'lfp-cell-array',
  label: 'LFP cell-array 필드 데이터',
  isCommentRow: () => false,
  isHeaderRow: (line, acc) => acc.columns === null,
  isDataRow: (line, acc) => acc.columns !== null,
  parseHeaderRow(line) {
    const delimiter = detectDelimiter(line);
    const cells = parseDelimitedLine(line, delimiter);
    return { columns: cells || [], colOffset: 0, delimiter };
  },
  parseDataRow(line, acc) {
    return parseDelimitedLine(line, acc.delimiter);
  },
  entityColumnGuess: () => null,
  timestampColumnGuess(columns) {
    return columns.find(c => normalizedColumnName(c) === 'TIMESTAMP') || null;
  },
  isTimestampLikeColumn: (c) => normalizedColumnName(c) === 'TIMESTAMP',
  alarmColumnGuess: () => null,
  isAlarmValue: () => false,
  derivedLabel: 'cross-cell Vdev / robust z-score / voltage closure 파생탐지',
  computeDerivedAlarm(rowObj) {
    const cells = LFP_CELL_COLUMNS.map(column => finiteNumber(rowObj[column]));
    if (cells.some(value => value === null)) return null;

    const vdev = cells.map((value, index) => {
      const peers = cells.filter((_, peerIndex) => peerIndex !== index);
      return value - median(peers);
    });
    const vdevCenter = median(vdev) || 0;
    const vdevMad = medianAbsoluteDeviation(vdev, vdevCenter);
    const vdevScale = Math.max(1.4826 * vdevMad, 0.005);
    const absVdev = vdev.map(value => Math.abs(value - vdevCenter));
    const outlierIndex = absVdev.reduce((best, value, index) => value > absVdev[best] ? index : best, 0);
    const maxAbsVdev = absVdev[outlierIndex];
    const maxRobustZ = maxAbsVdev / vdevScale;
    const voltageAlarm = maxAbsVdev >= Math.max(LFP_CELL_VDEV_THRESHOLD, 3 * vdevScale);

    const packVoltage = finiteNumber(rowObj.U_Battery);
    const voltageClosureError = packVoltage === null ? null : packVoltage - cells.reduce((sum, value) => sum + value, 0);
    const closureAlarm = voltageClosureError !== null && Math.abs(voltageClosureError) > LFP_CLOSURE_ERROR_THRESHOLD;
    const alarm = voltageAlarm || closureAlarm;
    const outlierCell = `Cell ${outlierIndex + 1}`;
    const reasons = [];
    if (voltageAlarm) reasons.push(`${outlierCell} Vdev=${vdev[outlierIndex].toFixed(4)}V (robust z=${maxRobustZ.toFixed(2)})`);
    if (closureAlarm) reasons.push(`voltage closure error=${voltageClosureError.toFixed(4)}V`);
    const metrics = {
      maxAbsVdev,
      maxRobustZ,
      voltageRange: Math.max(...cells) - Math.min(...cells)
    };
    vdev.forEach((value, index) => { metrics[`vdevCell${index + 1}`] = value; });
    if (voltageClosureError !== null) metrics.voltageClosureError = voltageClosureError;

    return {
      alarm,
      reasonCode: voltageAlarm && closureAlarm
        ? 'cross-cell Vdev + voltage closure anomaly'
        : (voltageAlarm ? 'cross-cell Vdev anomaly' : 'voltage closure anomaly'),
      reason: alarm ? `cross-cell 파생 이상: ${reasons.join('; ')}` : '',
      metrics,
      categories: voltageAlarm ? { outlierCell } : {},
      details: {
        outlierCell,
        vdev: vdev[outlierIndex],
        robustZ: maxRobustZ,
        vdevs: Object.fromEntries(vdev.map((value, index) => [`Cell ${index + 1}`, value])),
        voltageClosureError,
        evidenceTier: 'Derived'
      }
    };
  },
  seriesBinMode: 'day',
  seriesSignals: ['vRange', 'vStd', 'i', 'soc', 'tMean', 'vdevMax'],
  extractSeriesSample(rowObj) {
    const t = parseTimestampMs(rowObj.Timestamp);
    const cells = LFP_CELL_COLUMNS.map(column => finiteNumber(rowObj[column]));
    if (t == null || cells.some(v => v == null)) return null;
    const meanV = cells.reduce((s, v) => s + v, 0) / cells.length;
    const vStd = Math.sqrt(cells.reduce((s, v) => s + (v - meanV) ** 2, 0) / cells.length);
    const vRange = Math.max(...cells) - Math.min(...cells);
    const vdev = cells.map((value, index) => {
      const peers = cells.filter((_, peerIndex) => peerIndex !== index);
      return Math.abs(value - median(peers));
    });
    const i = finiteNumber(rowObj.I_Battery);
    const soc = finiteNumber(rowObj.SOC_Battery);
    let tSum = 0;
    let tN = 0;
    for (let k = 1; k <= 4; k++) {
      const tv = finiteNumber(rowObj[`T_${k}`] ?? rowObj[`Temp_${k}`]);
      if (tv != null) { tSum += tv; tN++; }
    }
    return {
      t,
      values: {
        vRange,
        vStd,
        i: i == null ? 0 : i,
        soc: soc == null ? 0 : soc,
        tMean: tN ? tSum / tN : 0,
        vdevMax: Math.max(...vdev)
      }
    };
  },
  collectForensics(rowObj, bucket) {
    const t = parseTimestampMs(rowObj.Timestamp);
    const snap = snapshotFromRow(rowObj);
    if (t == null || !snap) return;
    const curr = { t, ...snap };
    const prev = bucket._lfpPrev;
    if (!bucket.resistanceEvents) bucket.resistanceEvents = [];
    considerResistanceEvent(prev, curr, bucket.resistanceEvents);
    bucket._lfpPrev = curr;
  }
};

const KNOWN_FORMATS = [AEMO_MMS_FORMAT, LFP_CELL_ARRAY_FORMAT, GENERIC_FORMAT];

/** Given the first few non-empty raw lines of a source, pick the best-fit format adapter. */
export function detectFormat(firstLines) {
  const l0 = (firstLines[0] || '').trim().replace(/^\uFEFF/, '');
  const l1 = (firstLines[1] || '').trim().replace(/^\uFEFF/, '');
  if (AEMO_MMS_FORMAT.isCommentRow(l0) && AEMO_MMS_FORMAT.isHeaderRow(l1)) return AEMO_MMS_FORMAT;
  const headerCells = parseDelimitedLine(l0, detectDelimiter(l0));
  if (headerCells && isLfpCellArrayHeader(headerCells)) return LFP_CELL_ARRAY_FORMAT;
  return GENERIC_FORMAT;
}

export function formatById(id) {
  return KNOWN_FORMATS.find(f => f.id === id) || GENERIC_FORMAT;
}
