/**
 * Time-horizon helpers: data span vs alarm-evidence span, bounded histograms,
 * and capped alarm-context retention. Two timestamps per bucket (min/max) —
 * no extra memory beyond the existing sample cap.
 */

export const TIME_COVERAGE_WARN_RATIO = 0.2;
export const ALARM_TIME_BUCKETS = 8;
export const MAX_CATEGORY_TIME_BUCKETS = 24;

export function isoFromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function makeTimeRange(minMs, maxMs) {
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null;
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return { minMs: lo, maxMs: hi, min: isoFromMs(lo), max: isoFromMs(hi) };
}

export function extendTimeRange(range, t) {
  if (!Number.isFinite(t)) return range || null;
  if (!range) return makeTimeRange(t, t);
  if (t < range.minMs) return makeTimeRange(t, range.maxMs);
  if (t > range.maxMs) return makeTimeRange(range.minMs, t);
  return range;
}

export function mergeTimeRange(a, b) {
  if (!a) return b ? { minMs: b.minMs, maxMs: b.maxMs, min: b.min, max: b.max } : null;
  if (!b) return { minMs: a.minMs, maxMs: a.maxMs, min: a.min, max: a.max };
  return makeTimeRange(Math.min(a.minMs, b.minMs), Math.max(a.maxMs, b.maxMs));
}

export function spanMs(range) {
  if (!range || !Number.isFinite(range.minMs) || !Number.isFinite(range.maxMs)) return null;
  return Math.max(0, range.maxMs - range.minMs);
}

/** evidenceSpan / dataSpan, clamped to [0, 1]. null when the data span is unknown. */
export function coverageRatio(evidenceRange, dataRange) {
  const data = spanMs(dataRange);
  if (data == null) return null;
  if (data === 0) return spanMs(evidenceRange) == null ? 0 : 1;
  const evidence = spanMs(evidenceRange);
  if (evidence == null) return 0;
  return Math.min(1, evidence / data);
}

export function isLowTimeCoverage(ratio) {
  return Number.isFinite(ratio) && ratio < TIME_COVERAGE_WARN_RATIO;
}

export function formatTimeRange(range) {
  if (!range || !range.min || !range.max) return '미상';
  const a = range.min.slice(0, 10);
  const b = range.max.slice(0, 10);
  return a === b ? a : `${a} ~ ${b}`;
}

export function formatCoveragePct(ratio) {
  if (!Number.isFinite(ratio)) return '미상';
  const pct = Math.round(ratio * 1000) / 10;
  return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
}

export function evidenceRangeFromTimes(times) {
  let min = Infinity;
  let max = -Infinity;
  for (const t of times || []) {
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min)) return null;
  return makeTimeRange(min, max);
}

/**
 * Equal-width histogram of kept sample times over the DATA span (not the
 * evidence hull). Empty later buckets are the point — they show head bias.
 */
export function histogramTimes(times, dataRange, nBuckets = ALARM_TIME_BUCKETS) {
  const n = Math.max(1, nBuckets | 0);
  if (!dataRange || !Number.isFinite(dataRange.minMs) || !Number.isFinite(dataRange.maxMs)) {
    return [];
  }
  const span = Math.max(1, dataRange.maxMs - dataRange.minMs);
  const buckets = Array.from({ length: n }, (_, i) => {
    const startMs = dataRange.minMs + (span * i) / n;
    const endMs = i === n - 1 ? dataRange.maxMs : dataRange.minMs + (span * (i + 1)) / n;
    return {
      startMs,
      endMs,
      start: isoFromMs(startMs),
      end: isoFromMs(endMs),
      count: 0
    };
  });
  for (const t of times || []) {
    if (!Number.isFinite(t)) continue;
    let idx = Math.floor(((t - dataRange.minMs) / span) * n);
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;
    buckets[idx].count++;
  }
  return buckets;
}

/**
 * Retain at most `cap` alarm-context windows with even coverage across the
 * observed time span. Overflows are counted (never silent). The caller
 * supplies the full CONTEXT_WINDOW snapshot — this never thins it.
 *
 * Once full, drop the most redundant of (kept ∪ new): the point with the
 * smallest nearest-neighbor gap. Unique endpoints that extend the span
 * survive; a late sample can replace an early cluster. Not a copy of the
 * resistance-event baseline+recent ring — that keeps early+late, this
 * spreads across the whole span.
 */
export function considerAlarmSample(bucket, window, annotations, t, cap) {
  if (!bucket.alarmSamples) bucket.alarmSamples = [];
  if (!bucket.alarmAnnotations) bucket.alarmAnnotations = [];
  if (!bucket.alarmSampleTimes) bucket.alarmSampleTimes = [];
  if (typeof bucket.alarmDroppedCount !== 'number') bucket.alarmDroppedCount = 0;

  const samples = bucket.alarmSamples;
  const notes = bucket.alarmAnnotations;
  const times = bucket.alarmSampleTimes;

  if (samples.length < cap) {
    samples.push(window);
    notes.push(annotations);
    times.push(Number.isFinite(t) ? t : null);
    return;
  }

  bucket.alarmDroppedCount += 1;

  if (!Number.isFinite(t)) return;

  const dateless = times.findIndex(x => !Number.isFinite(x));
  if (dateless >= 0) {
    samples[dateless] = window;
    notes[dateless] = annotations;
    times[dateless] = t;
    return;
  }

  const pts = times.map((tt, i) => ({ t: tt, i }));
  pts.push({ t, i: -1 });
  pts.sort((a, b) => a.t - b.t || a.i - b.i);

  let dropK = 0;
  let bestRedundancy = Infinity;
  for (let k = 0; k < pts.length; k++) {
    const prev = k > 0 ? pts[k - 1].t : null;
    const next = k < pts.length - 1 ? pts[k + 1].t : null;
    // Unique endpoints own the span; dropping one shrinks coverage. Always
    // prefer to drop an interior cluster point instead.
    const nn = (prev == null || next == null)
      ? Infinity
      : Math.min(pts[k].t - prev, next - pts[k].t);
    if (nn < bestRedundancy || (nn === bestRedundancy && k > dropK)) {
      bestRedundancy = nn;
      dropK = k;
    }
  }
  const drop = pts[dropK];
  if (drop.i === -1) return;
  samples[drop.i] = window;
  notes[drop.i] = annotations;
  times[drop.i] = t;
}

export function sortAlarmSamplesByTime(bucket) {
  const n = bucket.alarmSamples?.length || 0;
  if (n < 2) return;
  const times = bucket.alarmSampleTimes || [];
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ta = times[a];
    const tb = times[b];
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    if (Number.isFinite(ta)) return -1;
    if (Number.isFinite(tb)) return 1;
    return a - b;
  });
  bucket.alarmSamples = order.map(i => bucket.alarmSamples[i]);
  bucket.alarmAnnotations = order.map(i => (bucket.alarmAnnotations || [])[i]);
  bucket.alarmSampleTimes = order.map(i => times[i]);
}

export function finalizeBucketTime(bucket) {
  if (!bucket) return;
  sortAlarmSamplesByTime(bucket);
  bucket.evidenceTimeRange = evidenceRangeFromTimes(bucket.alarmSampleTimes);
  bucket.timeCoverageRatio = coverageRatio(bucket.evidenceTimeRange, bucket.dataTimeRange);
  bucket.alarmSampleTimeDistribution = histogramTimes(bucket.alarmSampleTimes, bucket.dataTimeRange);
}

export function rollupGroupTime(acc) {
  if (!acc?.groups) return;
  let data = acc.dataTimeRange;
  const times = [];
  let dropped = 0;
  Object.values(acc.groups).forEach(group => {
    finalizeBucketTime(group);
    data = mergeTimeRange(data, group.dataTimeRange);
    if (Array.isArray(group.alarmSampleTimes)) times.push(...group.alarmSampleTimes);
    dropped += group.alarmDroppedCount || 0;
  });
  acc.dataTimeRange = data;
  acc.evidenceTimeRange = evidenceRangeFromTimes(times);
  acc.alarmDroppedCount = dropped;
  acc.timeCoverageRatio = coverageRatio(acc.evidenceTimeRange, acc.dataTimeRange);
  acc.alarmSampleTimeDistribution = histogramTimes(times, acc.dataTimeRange);
}

/** Min/max t from a figure whose x-axis is actually time (not Cell index etc.). */
export function figureCoveredTimeRange(fig) {
  if (!fig || fig.xLabel !== '시간') return null;
  let min = Infinity;
  let max = -Infinity;
  for (const series of fig.series || []) {
    for (const t of series.t || []) {
      if (!Number.isFinite(t)) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  return makeTimeRange(min, max);
}

export function buildTimeCoverageNote(details) {
  const items = Array.isArray(details) ? details : [];
  if (!items.length) return '';
  const parts = items.map(d => {
    const pct = formatCoveragePct(d.ratio);
    return `${d.sourceFile || '출처'}: 근거 ${formatTimeRange(d.evidenceTimeRange)} / 데이터 ${formatTimeRange(d.dataTimeRange)} (${pct})`;
  });
  return `[참고: 알람 근거 시간 범위가 데이터 전체 구간의 일부만 덮습니다 — ${parts.join('; ')}. 이 구간 밖의 거동에 대한 판단은 "추가 확인 필요"로 명시하십시오.]`;
}
