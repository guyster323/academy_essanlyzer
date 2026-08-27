/**
 * Bounded streaming time series. Every entity keeps a fixed number of
 * min/max/mean bins so a multi-million-row source never retains raw rows.
 * Frozen series stay in the browser; they are not copied into AI prompts.
 */

export const MAX_SERIES_POINTS = 2000;
export const MAX_SERIES_ENTITIES = 8;      // figures / A-F4 display cap
export const MAX_SERIES_BUFFERS = 32;      // stored during streaming
export const MAX_SERIES_SIGNALS = 12;
export const MAX_RESISTANCE_EVENTS = 4000;
export const MAX_EVIDENCE_ROWS = 80;
export const FIGURE_PNG_MAX_PX = { width: 1200, height: 480 };

export function parseTimestampMs(value) {
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

export function calendarBinStart(tsMs) {
  const d = new Date(tsMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function emptyStats(signals) {
  const min = {};
  const max = {};
  const mean = {};
  for (const name of signals) {
    min[name] = Infinity;
    max[name] = -Infinity;
    mean[name] = 0;
  }
  return { min, max, mean };
}

function applyValues(stats, values, signals, countBefore) {
  const nextCount = countBefore + 1;
  for (const name of signals) {
    const v = values[name];
    if (!Number.isFinite(v)) continue;
    if (v < stats.min[name]) stats.min[name] = v;
    if (v > stats.max[name]) stats.max[name] = v;
    stats.mean[name] = (stats.mean[name] * countBefore + v) / nextCount;
  }
  return nextCount;
}

function finiteStats(stats, signals) {
  for (const name of signals) {
    if (!Number.isFinite(stats.min[name])) stats.min[name] = 0;
    if (!Number.isFinite(stats.max[name])) stats.max[name] = 0;
  }
  return stats;
}

function mergeBins(a, b, signals) {
  const count = (a.count || 1) + (b.count || 1);
  const min = {};
  const max = {};
  const mean = {};
  for (const name of signals) {
    min[name] = Math.min(a.min[name], b.min[name]);
    max[name] = Math.max(a.max[name], b.max[name]);
    mean[name] = ((a.mean[name] * (a.count || 1)) + (b.mean[name] * (b.count || 1))) / count;
  }
  return { t: a.t, count, min, max, mean };
}

function pairwiseMerge(bins, signals) {
  const out = [];
  for (let i = 0; i < bins.length; i += 2) {
    if (i + 1 >= bins.length) out.push(bins[i]);
    else out.push(mergeBins(bins[i], bins[i + 1], signals));
  }
  return out;
}

/**
 * Reduce an already-frozen point list `{t, values}[]` to at most maxPoints
 * min/max/mean bins. Used by tests and by forensic helpers that receive
 * dense fixture points.
 */
export function downsampleMinMaxMean(points, maxPoints = MAX_SERIES_POINTS) {
  const cap = Math.max(2, maxPoints | 0);
  if (!Array.isArray(points) || points.length === 0) return [];
  const signalSet = new Set();
  points.forEach(p => Object.keys(p.values || {}).forEach(k => signalSet.add(k)));
  const signals = [...signalSet].slice(0, MAX_SERIES_SIGNALS);
  let bins = points.map(p => {
    const stats = emptyStats(signals);
    applyValues(stats, p.values || {}, signals, 0);
    return { t: p.t, count: 1, ...finiteStats(stats, signals) };
  });
  while (bins.length > cap) bins = pairwiseMerge(bins, signals);
  return bins;
}

export function createSeriesBuffer({ signals = ['value'], maxPoints = MAX_SERIES_POINTS, binMode = 'adaptive' } = {}) {
  const names = (signals || ['value']).filter(Boolean).slice(0, MAX_SERIES_SIGNALS);
  return {
    signals: names.length ? names : ['value'],
    maxPoints: Math.max(2, maxPoints | 0),
    binMode: binMode === 'day' ? 'day' : 'adaptive',
    bins: [],
    sampleCount: 0
  };
}

function updateBin(bin, values, signals) {
  bin.count = applyValues(bin, values, signals, bin.count || 0);
  finiteStats(bin, signals);
}

export function pushSample(buffer, entityId, tsMs, values) {
  if (!buffer || !Number.isFinite(tsMs) || !values) return false;
  buffer.entityId = entityId;
  buffer.sampleCount = (buffer.sampleCount || 0) + 1;
  const signals = buffer.signals;
  if (buffer.binMode === 'day') {
    const t0 = calendarBinStart(tsMs);
    const last = buffer.bins[buffer.bins.length - 1];
    if (last && last.t === t0) {
      updateBin(last, values, signals);
      return true;
    }
    const stats = emptyStats(signals);
    applyValues(stats, values, signals, 0);
    buffer.bins.push({ t: t0, count: 1, ...finiteStats(stats, signals) });
    if (buffer.bins.length > buffer.maxPoints) {
      buffer.bins = pairwiseMerge(buffer.bins, signals);
    }
    return true;
  }

  const last = buffer.bins[buffer.bins.length - 1];
  // Coalesce exact-duplicate timestamps (AEMO sometimes repeats a stamp).
  if (last && last.t === tsMs) {
    updateBin(last, values, signals);
    return true;
  }
  const stats = emptyStats(signals);
  applyValues(stats, values, signals, 0);
  buffer.bins.push({ t: tsMs, count: 1, ...finiteStats(stats, signals) });
  if (buffer.bins.length > buffer.maxPoints) {
    buffer.bins = pairwiseMerge(buffer.bins, signals);
  }
  return true;
}

export function freezeSeries(buffer) {
  if (!buffer) return null;
  return {
    entityId: buffer.entityId || '_file',
    binMode: buffer.binMode,
    signals: [...buffer.signals],
    sampleCount: buffer.sampleCount || 0,
    bins: buffer.bins.map(bin => ({
      t: bin.t,
      count: bin.count,
      min: { ...bin.min },
      max: { ...bin.max },
      mean: { ...bin.mean }
    }))
  };
}

export function binsToXY(frozen, signal, which = 'mean') {
  const t = [];
  const y = [];
  const lo = [];
  const hi = [];
  if (!frozen || !Array.isArray(frozen.bins)) return { t, y, lo, hi };
  frozen.bins.forEach(bin => {
    const v = bin[which] ? bin[which][signal] : undefined;
    const fallback = bin.mean ? bin.mean[signal] : undefined;
    const value = Number.isFinite(v) ? v : fallback;
    if (!Number.isFinite(bin.t) || !Number.isFinite(value)) return;
    t.push(bin.t);
    y.push(value);
    lo.push(Number.isFinite(bin.min?.[signal]) ? bin.min[signal] : value);
    hi.push(Number.isFinite(bin.max?.[signal]) ? bin.max[signal] : value);
  });
  return { t, y, lo, hi };
}

export function primaryRange(frozen, signal) {
  if (!frozen?.bins?.length) return 0;
  let min = Infinity;
  let max = -Infinity;
  frozen.bins.forEach(bin => {
    const lo = bin.min?.[signal];
    const hi = bin.max?.[signal];
    if (Number.isFinite(lo)) min = Math.min(min, lo);
    if (Number.isFinite(hi)) max = Math.max(max, hi);
  });
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
}

export function pickTopEntities(seriesByEntity, { primarySignal, limit = MAX_SERIES_ENTITIES } = {}) {
  const entries = Object.entries(seriesByEntity || {}).filter(([, s]) => s && s.bins && s.bins.length);
  entries.sort((a, b) => primaryRange(b[1], primarySignal) - primaryRange(a[1], primarySignal)
    || (b[1].sampleCount || 0) - (a[1].sampleCount || 0));
  const out = {};
  entries.slice(0, limit).forEach(([id, series]) => { out[id] = series; });
  return out;
}

export function pointsFromPairs(pairs, signal = 'mw') {
  return (pairs || []).map(([t, v]) => ({ t, values: { [signal]: v } }));
}

export function frozenFromPairs(entityId, pairs, signal = 'mw', maxPoints = MAX_SERIES_POINTS) {
  const buffer = createSeriesBuffer({ signals: [signal], maxPoints, binMode: 'adaptive' });
  (pairs || []).forEach(([t, v]) => pushSample(buffer, entityId, t, { [signal]: v }));
  return freezeSeries(buffer);
}
