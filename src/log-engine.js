/* =========================================================
   STREAMING LOG PROCESSOR
   Handles CSV/TXT/LOG entries of arbitrary size (500MB+) without ever
   materializing the full file as one JS string. Only bounded derived
   artifacts (stats, head sample, alarm-context windows — optionally
   grouped per entity) are retained, so downstream AI prompt size stays
   constant regardless of source file size.
========================================================= */

import { zipEntryByteChunks, isJsZipUncompressedSizeMismatch } from './zip-stream.js';
import {
  MAX_SERIES_BUFFERS, MAX_SERIES_POINTS, createSeriesBuffer, pushSample, freezeSeries,
  parseTimestampMs
} from './series-engine.js';
import { normalizeResistanceEvents, resistanceEventsDroppedCount } from './forensics/lfp.js';
import {
  extendTimeRange, considerAlarmSample, finalizeBucketTime, rollupGroupTime,
  recordCategoryTime
} from './time-coverage.js';

export const LOG_EXT_ALLOW = ['csv', 'txt', 'log', 'tsv', 'dat'];
export const LOG_EXT_SKIP_NOTE = ['png', 'jpg', 'jpeg', 'gif', 'pdf', 'xlsx', 'xls', 'docx', 'pptx', 'exe', 'dll', 'bin', 'db'];
export const CHUNK_BYTES = 256 * 1024;           // small enough that a 3MB CSV paints progress
export const LINES_PER_YIELD = 2000;              // keep the UI thread responsive while feeding
// Per-chunk yield used to run in addition to LINES_PER_YIELD. On the System 6
// ZIP path inflate emits ~64KB chunks (~436 lines), so the per-chunk yield
// fired 44,086 times and LINES_PER_YIELD never did. Node profile of that
// stream: yieldWait 303s / 29% of 1039s (tmp/latency-runs/zip-sys6-yield0).
// Browser nested setTimeout(0) would clamp those 44,086 waits to ~4ms ≈ 176s
// (~21% of the Rank 4 850s). Dropping the per-chunk yield lets
// LINES_PER_YIELD actually fire (~9,624 times, ~75ms of LFP work each),
// which is still well inside the 180ms progress-bar render throttle.
export const HEAD_SAMPLE_CAP = 15;                // rows kept from file/group start
export const ALARM_SAMPLE_CAP = 40;               // alarm/anomaly context windows kept per file/group
export const CONTEXT_WINDOW = 5;                  // rows of lookback kept per alarm window
export const LARGE_FILE_WARN_BYTES = 150 * 1024 * 1024; // soft warning threshold (150MB)

/* ---- Prompt budget (enforced in pipeline.js blocksToPromptText) ----
   Keeps the AI request bounded regardless of how many sources/entities/
   alarms the user selects — truncation is always reported to the user and
   noted in the prompt itself, never applied silently.
   MAX_LOG_TEXT_CHARS must stay numerically in sync with
   server/lib/validation.js's MAX_LOG_TEXT_CHARS (separate modules/runtimes,
   so it can't be imported directly). */
export const MAX_SELECTED_SOURCES = 10;           // sources included per request
export const MAX_GROUPS_PER_SOURCE_IN_PROMPT = 10; // entity groups shown in detail per source
export const MAX_TOTAL_ALARM_CONTEXTS = 60;        // alarm-context windows across the whole request
export const MAX_LOG_TEXT_CHARS = 300_000;         // hard cap on the combined prompt text

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

export function avgOf(stat) {
  return stat.count ? (stat.sum / stat.count).toFixed(2) : '—';
}

export function scoreSource(name, headerLine) {
  let score = 0;
  const lname = name.toLowerCase();
  if (/bms|ess|pcs|ems|cell|alarm|fault|log/i.test(lname)) score += 2;
  if (headerLine) {
    if (/time|timestamp|date/i.test(headerLine)) score += 3;
    if (/volt|voltage|current|temp|soc|soh|alarm|fault|status/i.test(headerLine)) score += 2;
  }
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!LOG_EXT_ALLOW.includes(ext)) score -= 5;
  return score;
}

const persistedFileBytes = new WeakMap();

export function attachPersistedFileBytes(file, bytes) {
  if (file && bytes) persistedFileBytes.set(file, bytes);
}

export function getPersistedFileBytes(file) {
  return file ? persistedFileBytes.get(file) : undefined;
}

/* ---- Byte-chunk sources: plain File/Blob and JSZip entries ---- */
export async function* fileByteChunks(file) {
  const persisted = persistedFileBytes.get(file);
  if (persisted) {
    for (let offset = 0; offset < persisted.byteLength; offset += CHUNK_BYTES) {
      yield persisted.subarray(offset, Math.min(persisted.byteLength, offset + CHUNK_BYTES));
    }
    return;
  }
  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK_BYTES);
    const buf = await slice.arrayBuffer();
    yield new Uint8Array(buf);
    offset += CHUNK_BYTES;
  }
}

// Keep the public byte-source contract in this module while the ZIP-specific
// local-header/pako implementation stays isolated in zip-stream.js.
export { zipEntryByteChunks, isJsZipUncompressedSizeMismatch };

export function detectEncodingFromBytes(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch (e) {
    return 'euc-kr';
  }
}

/* ---- Core incremental accumulator, format- and entity-group-aware ---- */
function makeBucket() {
  const bucket = {
    rowCount: 0,
    alarmCount: 0,
    headSample: [],
    alarmSamples: [],
    alarmAnnotations: [],
    alarmSampleTimes: [],
    alarmDroppedCount: 0,
    dataTimeRange: null,
    evidenceTimeRange: null,
    timeCoverageRatio: null,
    alarmSampleTimeDistribution: [],
    recentWindow: [],
    stats: {},
    derived: {
      label: null,
      alarmCount: 0,
      metricStats: {},
      reasonCounts: {},
      categoryCounts: {},
      categoryTimeBuckets: []
    },
    resistanceEvents: []
  };
  // Adapter rolling state is intentionally non-enumerable so it cannot leak
  // into prompt blocks or history snapshots. Each bucket still owns only a
  // fixed-size window, never the full source.
  Object.defineProperty(bucket, '_derivedState', {
    value: Object.create(null), enumerable: false, writable: true
  });
  return bucket;
}

export function makeAccumulator(format, entityFilter = '') {
  return Object.assign(makeBucket(), {
    format,
    columns: null,
    colOffset: 0,
    delimiter: ',',
    alarmColumn: null,
    entityColumn: null,
    timestampColumn: null,
    entityFilter: (entityFilter || '').trim(),
    groups: null, // becomes {entityValue: bucket} once an entity column is recognized
    malformedRowCount: 0,
    _seriesAttached: 0
  });
}

function attachSeries(acc, bucket, entityKey) {
  if (bucket.series) return bucket.series;
  const fmt = acc.format;
  if (typeof fmt.extractSeriesSample !== 'function') return null;
  acc._seriesAttached = acc._seriesAttached || 0;
  if (acc._seriesAttached >= MAX_SERIES_BUFFERS) {
    // Prefer BESS-like names and buckets that already have derived alarms.
    if (!/bess|battery/i.test(entityKey || '') && !(bucket.derived && bucket.derived.alarmCount)) {
      return null;
    }
  }
  bucket.series = createSeriesBuffer({
    signals: fmt.seriesSignals || ['value'],
    maxPoints: MAX_SERIES_POINTS,
    binMode: fmt.seriesBinMode || 'adaptive'
  });
  acc._seriesAttached++;
  return bucket.series;
}

function updateNumericStats(stats, key, value) {
  if (!Number.isFinite(value)) return;
  if (!stats[key] && Object.keys(stats).length >= 50) return;
  if (!stats[key]) stats[key] = { min: value, max: value, sum: 0, count: 0 };
  const s = stats[key];
  if (value < s.min) s.min = value;
  if (value > s.max) s.max = value;
  s.sum += value;
  s.count++;
}

function recordDerivedResult(bucket, fmt, result, t) {
  if (!result) return;
  const derived = bucket.derived || (bucket.derived = {
    label: null, alarmCount: 0, metricStats: {}, reasonCounts: {}, categoryCounts: {},
    categoryTimeBuckets: []
  });
  if (fmt.derivedLabel) derived.label = fmt.derivedLabel;

  Object.entries(result.metrics || {}).forEach(([key, value]) => updateNumericStats(derived.metricStats, key, value));
  if (!result.alarm) return;

  derived.alarmCount++;
  const reason = result.reasonCode || '파생 이상 탐지';
  if (!derived.reasonCounts[reason] && Object.keys(derived.reasonCounts).length >= 20) {
    derived.reasonCounts['기타 파생 이상'] = (derived.reasonCounts['기타 파생 이상'] || 0) + 1;
  } else {
    derived.reasonCounts[reason] = (derived.reasonCounts[reason] || 0) + 1;
  }
  Object.entries(result.categories || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (!derived.categoryCounts[key] && Object.keys(derived.categoryCounts).length >= 20) return;
    if (!derived.categoryCounts[key]) derived.categoryCounts[key] = {};
    const counts = derived.categoryCounts[key];
    if (!counts[value] && Object.keys(counts).length >= 20) return;
    counts[value] = (counts[value] || 0) + 1;
  });
  if (result.categories) recordCategoryTime(derived, t, result.categories);
}

function markProfile(profile, key, startedAt) {
  if (profile) profile[key] += performance.now() - startedAt;
}

function feedRowIntoBucket(acc, bucket, cells, profile) {
  const fmt = acc.format;
  const tRest = profile ? performance.now() : 0;
  const rowObj = {};
  acc.columns.forEach((c, i) => {
    const val = cells[i] !== undefined ? cells[i] : '';
    rowObj[c] = val;
    if (c === acc.alarmColumn) return;
    if (fmt.isTimestampLikeColumn(c)) return; // avoid mis-parsing date strings as numbers
    const v = parseFloat(val);
    if (!isNaN(v)) {
      if (!bucket.stats[c]) bucket.stats[c] = { min: v, max: v, sum: 0, count: 0 };
      const s = bucket.stats[c];
      if (v < s.min) s.min = v;
      if (v > s.max) s.max = v;
      s.sum += v; s.count++;
    }
  });
  markProfile(profile, 'feedStatsMs', tRest);

  const tRow = acc.timestampColumn ? parseTimestampMs(rowObj[acc.timestampColumn]) : null;
  if (Number.isFinite(tRow)) {
    bucket.dataTimeRange = extendTimeRange(bucket.dataTimeRange, tRow);
    if (bucket !== acc) acc.dataTimeRange = extendTimeRange(acc.dataTimeRange, tRow);
  }

  const tDerived = profile ? performance.now() : 0;
  const derivedResult = typeof fmt.computeDerivedAlarm === 'function'
    ? fmt.computeDerivedAlarm(rowObj, acc, bucket)
    : null;
  recordDerivedResult(bucket, fmt, derivedResult, tRow);
  markProfile(profile, 'feedDerivedMs', tDerived);

  const tSeries = profile ? performance.now() : 0;
  const entityKey = acc.entityColumn ? (rowObj[acc.entityColumn] || '_entity') : (acc.entityFilter || '_file');
  const seriesBuf = attachSeries(acc, bucket, entityKey);
  if (seriesBuf && typeof fmt.extractSeriesSample === 'function') {
    const sample = fmt.extractSeriesSample(rowObj, acc, bucket);
    if (sample && Number.isFinite(sample.t)) pushSample(seriesBuf, entityKey, sample.t, sample.values);
  }
  markProfile(profile, 'feedSeriesMs', tSeries);

  const tForensics = profile ? performance.now() : 0;
  if (typeof fmt.collectForensics === 'function') fmt.collectForensics(rowObj, bucket);
  markProfile(profile, 'feedForensicsMs', tForensics);

  const tRest2 = profile ? performance.now() : 0;
  // Keep a file-level derived summary as well as the per-entity summary. The
  // hook is invoked only once for the target bucket, so grouped streams do
  // not accidentally share rolling baselines across physical entities.
  if (bucket !== acc) recordDerivedResult(acc, fmt, derivedResult, tRow);

  bucket.rowCount++;
  if (bucket.headSample.length < HEAD_SAMPLE_CAP) bucket.headSample.push(rowObj);

  bucket.recentWindow.push(rowObj);
  if (bucket.recentWindow.length > CONTEXT_WINDOW) bucket.recentWindow.shift();

  const staticAlarm = Boolean(
    acc.alarmColumn && fmt.isAlarmValue(rowObj[acc.alarmColumn], acc.alarmColumn)
  );
  const derivedAlarm = Boolean(derivedResult && derivedResult.alarm);
  const isAlarm = staticAlarm || derivedAlarm;
  const annotations = [];
  if (staticAlarm) {
    annotations.push({
      kind: 'flag',
      reason: `${acc.alarmColumn}=${rowObj[acc.alarmColumn]}`
    });
  }
  if (derivedAlarm) {
    annotations.push({
      kind: 'derived',
      reason: derivedResult.reason || '파생 이상 탐지',
      details: derivedResult.details || {}
    });
  }
  if (isAlarm) {
    bucket.alarmCount++;
    considerAlarmSample(bucket, [...bucket.recentWindow], annotations, tRow, ALARM_SAMPLE_CAP);
  }
  markProfile(profile, 'feedStatsMs', tRest2);
  return isAlarm;
}

export function feedLine(acc, line, profile) {
  if (!line) return;
  const fmt = acc.format;

  if (fmt.isCommentRow(line, acc)) return;

  if (fmt.isHeaderRow(line, acc)) {
    const { columns, colOffset, delimiter } = fmt.parseHeaderRow(line, acc);
    acc.columns = columns;
    acc.colOffset = colOffset;
    if (delimiter) acc.delimiter = delimiter;
    acc.alarmColumn = fmt.alarmColumnGuess(columns);
    acc.entityColumn = fmt.entityColumnGuess(columns);
    acc.timestampColumn = fmt.timestampColumnGuess(columns);
    if (acc.entityColumn) acc.groups = acc.groups || {};
    return;
  }

  if (!acc.columns || !fmt.isDataRow(line, acc)) return; // stray line — ignore defensively

  const tParse = profile ? performance.now() : 0;
  const rawCells = fmt.parseDataRow(line, acc);
  markProfile(profile, 'feedParseMs', tParse);
  if (rawCells === null) {
    // Malformed row (e.g. an unterminated quoted field) — counted, not
    // silently dropped, so the UI can surface it instead of quietly
    // under-reporting rows.
    acc.malformedRowCount = (acc.malformedRowCount || 0) + 1;
    return;
  }
  const cells = acc.colOffset ? rawCells.slice(acc.colOffset) : rawCells;

  let entityValue = null;
  if (acc.entityColumn) {
    const idx = acc.columns.indexOf(acc.entityColumn);
    entityValue = idx >= 0 ? (cells[idx] || '').trim() : '';
    if (acc.entityFilter) {
      if (!entityValue.toLowerCase().includes(acc.entityFilter.toLowerCase())) return; // filtered out before any bookkeeping
    }
  }

  const target = acc.entityColumn
    ? (acc.groups[entityValue] || (acc.groups[entityValue] = makeBucket()))
    : acc;

  const isAlarm = feedRowIntoBucket(acc, target, cells, profile);
  if (target !== acc) {
    acc.rowCount++;
    if (isAlarm) acc.alarmCount++;
  }
}

function emptyStreamProfile() {
  return {
    chunkCount: 0,
    lineCount: 0,
    nonemptyLineCount: 0,
    yieldCount: 0,
    inflateOrReadMs: 0,
    zipReadMs: 0,
    inflateMs: 0,
    decodeMs: 0,
    splitMs: 0,
    feedLineMs: 0,
    feedParseMs: 0,
    feedDerivedMs: 0,
    feedSeriesMs: 0,
    feedForensicsMs: 0,
    feedStatsMs: 0,
    progressMs: 0,
    yieldWaitMs: 0,
    applyMs: 0,
    bytes: 0
  };
}

/**
 * Optional 4th argument `{ profile }` accumulates per-phase wall time in
 * milliseconds (inflate/read, TextDecoder, split, feedLine, yield wait,
 * applyAccumulator). When set, feedLine also splits into parse / derived /
 * series / forensics / stats. Callers that omit it keep the original path;
 * the profiler is for the 6-4 ZIP-stream investigation and the later
 * feedLine breakdown in Report/latency-stream-profiles/. `yieldDelayMs`
 * overrides the setTimeout delay (default 0).
 */
export async function streamIntoSource(src, byteChunkIterable, onProgress, options) {
  const profile = options && options.profile ? options.profile : null;
  const yieldDelayMs = options && Number.isFinite(options.yieldDelayMs) ? options.yieldDelayMs : 0;
  if (profile) Object.assign(profile, { ...emptyStreamProfile(), ...profile });
  const decoder = new TextDecoder(src.encoding === 'euc-kr' ? 'euc-kr' : 'utf-8', { fatal: false });
  const acc = makeAccumulator(src.format, src.entityFilter);
  let leftover = '';
  let processed = 0;
  let sinceYield = 0;
  const yieldToUi = async () => {
    const tProgress = profile ? performance.now() : 0;
    src.processedBytes = processed;
    onProgress && onProgress();
    if (profile) profile.progressMs += performance.now() - tProgress;
    const tWait = profile ? performance.now() : 0;
    await new Promise(resolve => setTimeout(resolve, yieldDelayMs));
    if (profile) {
      profile.yieldWaitMs += performance.now() - tWait;
      profile.yieldCount += 1;
    }
    sinceYield = 0;
  };

  let tRead = profile ? performance.now() : 0;
  for await (const chunk of byteChunkIterable) {
    if (profile) {
      profile.inflateOrReadMs += performance.now() - tRead;
      profile.chunkCount += 1;
    }
    processed += chunk.byteLength || chunk.length || 0;
    src.processedBytes = processed;
    if (profile) profile.bytes = processed;
    const tDecode = profile ? performance.now() : 0;
    const text = decoder.decode(chunk, { stream: true });
    if (profile) profile.decodeMs += performance.now() - tDecode;
    const tSplit = profile ? performance.now() : 0;
    const combined = leftover + text;
    const lines = combined.split(/\r?\n/);
    leftover = lines.pop();
    if (profile) {
      profile.splitMs += performance.now() - tSplit;
      profile.lineCount += lines.length;
    }
    for (const line of lines) {
      if (line.trim()) {
        if (profile) {
          profile.nonemptyLineCount += 1;
          const tFeed = performance.now();
          feedLine(acc, line, profile);
          profile.feedLineMs += performance.now() - tFeed;
        } else {
          feedLine(acc, line);
        }
      }
      if (++sinceYield >= LINES_PER_YIELD) await yieldToUi();
    }
    if (profile) tRead = performance.now();
  }
  const tDecodeTail = profile ? performance.now() : 0;
  const tail = decoder.decode();
  if (profile) profile.decodeMs += performance.now() - tDecodeTail;
  const finalCombined = leftover + tail;
  if (finalCombined.trim()) {
    if (profile) {
      const tFeed = performance.now();
      feedLine(acc, finalCombined, profile);
      profile.feedLineMs += performance.now() - tFeed;
      profile.nonemptyLineCount += 1;
    } else {
      feedLine(acc, finalCombined);
    }
  }

  src.processedBytes = processed;
  onProgress && onProgress();
  const tApply = profile ? performance.now() : 0;
  applyAccumulatorToSource(src, acc);
  if (profile) profile.applyMs += performance.now() - tApply;
}

function freezeBucketEvidence(bucket, entityId) {
  const frozen = bucket?.series ? freezeSeries(bucket.series) : null;
  if (frozen) frozen.entityId = entityId;
  const resistanceEvents = Array.isArray(bucket?.resistanceEvents) ? bucket.resistanceEvents : [];
  normalizeResistanceEvents(resistanceEvents);
  return {
    series: frozen,
    resistanceEvents
  };
}

export function finalizeAccumulator(acc) {
  if (!acc) return acc;
  if (acc.groups) rollupGroupTime(acc);
  else finalizeBucketTime(acc);
  return acc;
}

export function applyAccumulatorToSource(src, acc) {
  finalizeAccumulator(acc);
  src.columns = acc.columns || [];
  src.delimiter = acc.delimiter || ',';
  src.rowCount = acc.rowCount;
  src.alarmCount = acc.alarmCount;
  src.malformedRowCount = acc.malformedRowCount || 0;
  src.droppedResistanceEvents = 0;
  src.entityColumn = acc.entityColumn;
  src.timestampColumn = acc.timestampColumn;
  src.dataTimeRange = acc.dataTimeRange || null;
  src.evidenceTimeRange = acc.evidenceTimeRange || null;
  src.timeCoverageRatio = Number.isFinite(acc.timeCoverageRatio) ? acc.timeCoverageRatio : null;
  src.alarmDroppedCount = acc.alarmDroppedCount || 0;
  src.alarmSampleTimeDistribution = acc.alarmSampleTimeDistribution || [];
  src.groups = acc.groups; // null when the format has no groupable entity column
  src.derived = acc.derived;
  src.alarmAnnotations = acc.alarmAnnotations;
  src.alarmSampleTimes = acc.alarmSampleTimes || [];
  src.seriesByEntity = {};
  src.resistanceEventsByEntity = {};
  if (acc.groups) {
    src.headSample = [];
    src.alarmSamples = [];
    src.stats = {};
    Object.entries(acc.groups).forEach(([id, bucket]) => {
      const ev = freezeBucketEvidence(bucket, id);
      if (ev.series) src.seriesByEntity[id] = ev.series;
      if (ev.resistanceEvents.length) src.resistanceEventsByEntity[id] = ev.resistanceEvents;
      src.droppedResistanceEvents += resistanceEventsDroppedCount(ev.resistanceEvents);
    });
  } else {
    src.headSample = acc.headSample;
    src.alarmSamples = acc.alarmSamples;
    src.stats = acc.stats;
    const ev = freezeBucketEvidence(acc, src.name || '_file');
    if (ev.series) src.seriesByEntity[ev.series.entityId] = ev.series;
    if (ev.resistanceEvents.length) src.resistanceEventsByEntity[ev.series?.entityId || '_file'] = ev.resistanceEvents;
    src.droppedResistanceEvents += resistanceEventsDroppedCount(ev.resistanceEvents);
  }
  src.score = scoreSource(src.name, src.columns.join(src.delimiter));
  src.status = 'ready';
}
