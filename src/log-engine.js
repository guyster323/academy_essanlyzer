/* =========================================================
   STREAMING LOG PROCESSOR
   Handles CSV/TXT/LOG entries of arbitrary size (500MB+) without ever
   materializing the full file as one JS string. Only bounded derived
   artifacts (stats, head sample, alarm-context windows — optionally
   grouped per entity) are retained, so downstream AI prompt size stays
   constant regardless of source file size.
========================================================= */

export const LOG_EXT_ALLOW = ['csv', 'txt', 'log', 'tsv', 'dat'];
export const LOG_EXT_SKIP_NOTE = ['png', 'jpg', 'jpeg', 'gif', 'pdf', 'xlsx', 'xls', 'docx', 'pptx', 'exe', 'dll', 'bin', 'db'];
export const CHUNK_BYTES = 4 * 1024 * 1024;      // 4MB read chunks
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

/* ---- Byte-chunk sources: plain File/Blob and JSZip entries ---- */
export async function* fileByteChunks(file) {
  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK_BYTES);
    const buf = await slice.arrayBuffer();
    yield new Uint8Array(buf);
    offset += CHUNK_BYTES;
  }
}

// Wraps JSZip's event-based internalStream as an async-iterable, with
// backpressure (pause/resume) so we never buffer the whole entry at once.
export function zipEntryByteChunks(entry) {
  return {
    [Symbol.asyncIterator]() {
      const stream = entry.internalStream('uint8array');
      const queue = [];
      let waiter = null, ended = false, errored = null;
      stream.on('data', (chunk) => {
        queue.push(chunk);
        stream.pause();
        if (waiter) { const w = waiter; waiter = null; w(); }
      });
      stream.on('end', () => { ended = true; if (waiter) { const w = waiter; waiter = null; w(); } });
      stream.on('error', (e) => { errored = e; if (waiter) { const w = waiter; waiter = null; w(); } });
      stream.resume();
      return {
        async next() {
          while (queue.length === 0 && !ended && !errored) {
            await new Promise(res => { waiter = res; });
          }
          if (errored) throw errored;
          if (queue.length) {
            const chunk = queue.shift();
            stream.resume();
            return { value: chunk, done: false };
          }
          return { value: undefined, done: true };
        },
        async return() {
          ended = true;
          stream.pause();
          if (typeof stream.removeAllListeners === 'function') {
            // Do not leave an unhandled asynchronous stream error behind if
            // the probe stops after its bounded prefix. A no-op error
            // listener is safer than detaching the error channel entirely.
            stream.removeAllListeners('data');
            stream.removeAllListeners('end');
            stream.removeAllListeners('error');
            stream.on('error', () => {});
          }
          if (waiter) { const w = waiter; waiter = null; w(); }
          return { value: undefined, done: true };
        }
      };
    }
  };
}

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
    recentWindow: [],
    stats: {},
    derived: {
      label: null,
      alarmCount: 0,
      metricStats: {},
      reasonCounts: {},
      categoryCounts: {}
    }
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
    malformedRowCount: 0
  });
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

function recordDerivedResult(bucket, fmt, result) {
  if (!result) return;
  const derived = bucket.derived || (bucket.derived = {
    label: null, alarmCount: 0, metricStats: {}, reasonCounts: {}, categoryCounts: {}
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
}

function feedRowIntoBucket(acc, bucket, cells) {
  const fmt = acc.format;
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

  const derivedResult = typeof fmt.computeDerivedAlarm === 'function'
    ? fmt.computeDerivedAlarm(rowObj, acc, bucket)
    : null;
  recordDerivedResult(bucket, fmt, derivedResult);
  // Keep a file-level derived summary as well as the per-entity summary. The
  // hook is invoked only once for the target bucket, so grouped streams do
  // not accidentally share rolling baselines across physical entities.
  if (bucket !== acc) recordDerivedResult(acc, fmt, derivedResult);

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
    if (bucket.alarmSamples.length < ALARM_SAMPLE_CAP) {
      bucket.alarmSamples.push([...bucket.recentWindow]);
      bucket.alarmAnnotations.push(annotations);
    }
  }
  return isAlarm;
}

export function feedLine(acc, line) {
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

  const rawCells = fmt.parseDataRow(line, acc);
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

  const isAlarm = feedRowIntoBucket(acc, target, cells);
  if (target !== acc) {
    acc.rowCount++;
    if (isAlarm) acc.alarmCount++;
  }
}

export async function streamIntoSource(src, byteChunkIterable, onProgress) {
  const decoder = new TextDecoder(src.encoding === 'euc-kr' ? 'euc-kr' : 'utf-8', { fatal: false });
  const acc = makeAccumulator(src.format, src.entityFilter);
  let leftover = '';
  let processed = 0;

  for await (const chunk of byteChunkIterable) {
    processed += chunk.byteLength || chunk.length || 0;
    const text = decoder.decode(chunk, { stream: true });
    const combined = leftover + text;
    const lines = combined.split(/\r?\n/);
    leftover = lines.pop();
    for (const line of lines) { if (line.trim()) feedLine(acc, line); }
    src.processedBytes = processed;
    onProgress && onProgress();
  }
  const tail = decoder.decode();
  const finalCombined = leftover + tail;
  if (finalCombined.trim()) feedLine(acc, finalCombined);

  applyAccumulatorToSource(src, acc);
}

export function applyAccumulatorToSource(src, acc) {
  src.columns = acc.columns || [];
  src.delimiter = acc.delimiter || ',';
  src.rowCount = acc.rowCount;
  src.alarmCount = acc.alarmCount;
  src.malformedRowCount = acc.malformedRowCount || 0;
  src.entityColumn = acc.entityColumn;
  src.timestampColumn = acc.timestampColumn;
  src.groups = acc.groups; // null when the format has no groupable entity column
  src.derived = acc.derived;
  src.alarmAnnotations = acc.alarmAnnotations;
  if (acc.groups) {
    src.headSample = [];
    src.alarmSamples = [];
    src.stats = {};
  } else {
    src.headSample = acc.headSample;
    src.alarmSamples = acc.alarmSamples;
    src.stats = acc.stats;
  }
  src.score = scoreSource(src.name, src.columns.join(src.delimiter));
  src.status = 'ready';
}
