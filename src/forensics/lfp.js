import { MAX_RESISTANCE_EVENTS } from '../series-engine.js';

export const LFP_DI_THRESHOLD = 5;
export const LFP_I_ABS_MIN = 2;
export const LFP_LOOKBACK = 8;

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function linreg(xs, ys) {
  const n = xs.length;
  if (n < 3) return { slope: 0, intercept: 0, sse: Infinity };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  const den = n * sxx - sx * sx;
  const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (slope * xs[i] + intercept);
    sse += e * e;
  }
  return { slope, intercept, sse };
}

export function eventResistance(cellsBefore, cellsAfter, dI) {
  if (!Number.isFinite(dI) || dI === 0) return null;
  return cellsBefore.map((v, i) => {
    const a = cellsAfter[i];
    if (!Number.isFinite(v) || !Number.isFinite(a)) return null;
    return -(a - v) / dI;
  });
}

/**
 * Frozen prefix so early-life behaviour survives span-wide thinning.
 * Far smaller than the old 2000-event half: degradation still needs a
 * start-of-life sample, not four days of one operating cluster.
 */
export const RESISTANCE_TIME_BINS = 64;
export const RESISTANCE_PER_BIN = 58;
export const RESISTANCE_BASELINE_KEEP = MAX_RESISTANCE_EVENTS
  - RESISTANCE_TIME_BINS * RESISTANCE_PER_BIN;
export const RESISTANCE_RETENTION_POLICY = '초기 기준선+전 구간 분산 유지';
const RESISTANCE_BIN_WIDTH_MS = 24 * 3600 * 1000;

export function resistanceEventsDroppedCount(events) {
  return Number(events?.droppedCount) || 0;
}

export function resistanceEventYearCounts(events) {
  const counts = {};
  for (const ev of events || []) {
    if (!Number.isFinite(ev?.t)) continue;
    const y = String(new Date(ev.t).getUTCFullYear());
    counts[y] = (counts[y] || 0) + 1;
  }
  return counts;
}

export function formatResistanceYearCounts(counts) {
  if (!counts || typeof counts !== 'object') return '';
  return Object.keys(counts).sort().map(y => `${y}:${counts[y]}`).join(' ');
}

export function formatResistanceDropNote(droppedCount, yearCounts) {
  const n = Number(droppedCount) || 0;
  if (!n) return '';
  const years = formatResistanceYearCounts(yearCounts);
  const extra = years ? `; ${years}` : '';
  return `저항 이벤트 ${n.toLocaleString()}건 생략(${RESISTANCE_RETENTION_POLICY}${extra})`;
}

function thinKeepSpread(list, keep) {
  const n = list.length;
  if (!n) return [];
  if (n <= keep) return list.slice();
  if (keep <= 1) return [list[0]];
  const out = new Array(keep);
  const last = keep - 1;
  const span = n - 1;
  for (let i = 0; i < last; i++) out[i] = list[Math.floor((i * span) / last)];
  out[last] = list[span];
  return out;
}

function pairwiseMergeEventBins(bins, perBin) {
  const out = [];
  for (let i = 0; i < bins.length; i += 2) {
    if (i + 1 >= bins.length) out.push(thinKeepSpread(bins[i], perBin));
    else out.push(thinKeepSpread(bins[i].concat(bins[i + 1]), perBin));
  }
  return out;
}

function insertIntoBin(bin, event, perBin) {
  const n = bin.length;
  const t = event.t;
  if (n === 0 || !Number.isFinite(t) || !Number.isFinite(bin[n - 1]?.t) || t >= bin[n - 1].t) {
    bin.push(event);
  } else {
    let i = n;
    while (i > 0 && Number.isFinite(bin[i - 1]?.t) && bin[i - 1].t > t) i--;
    bin.splice(i, 0, event);
  }
  if (bin.length > perBin) {
    const next = thinKeepSpread(bin, perBin);
    bin.length = 0;
    for (let i = 0; i < next.length; i++) bin.push(next[i]);
  }
}

function compactEventBins(cap) {
  while (cap.bins.length > RESISTANCE_TIME_BINS) {
    cap.bins = pairwiseMergeEventBins(cap.bins, RESISTANCE_PER_BIN);
    cap.width *= 2;
  }
}

function placeEventInCap(cap, event) {
  const t = event.t;
  if (!Number.isFinite(t)) {
    insertIntoBin(cap.bins[0] || (cap.bins[0] = []), event, RESISTANCE_PER_BIN);
    return;
  }
  if (t < cap.origin) {
    const steps = Math.ceil((cap.origin - t) / cap.width);
    const prepend = Math.min(Math.max(0, steps), RESISTANCE_TIME_BINS);
    cap.origin -= prepend * cap.width;
    for (let i = 0; i < prepend; i++) cap.bins.unshift([]);
    compactEventBins(cap);
  }
  let idx = Math.floor((t - cap.origin) / cap.width);
  if (idx < 0) idx = 0;
  while (idx >= RESISTANCE_TIME_BINS) {
    cap.bins = pairwiseMergeEventBins(cap.bins, RESISTANCE_PER_BIN);
    cap.width *= 2;
    idx = Math.floor((t - cap.origin) / cap.width);
    if (idx < 0) idx = 0;
  }
  while (cap.bins.length <= idx) cap.bins.push([]);
  insertIntoBin(cap.bins[idx], event, RESISTANCE_PER_BIN);
}

function flattenCap(cap) {
  const kept = cap.baseline.concat(cap.bins.flat());
  kept.sort((a, b) => {
    const ta = a?.t;
    const tb = b?.t;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return 0;
  });
  return kept;
}

function capKeptCount(cap) {
  let n = cap.baseline.length;
  for (const bin of cap.bins) n += bin.length;
  return n;
}

function initResistanceCap(events) {
  const origin = Number.isFinite(events[0]?.t) ? events[0].t : 0;
  const cap = {
    origin,
    width: RESISTANCE_BIN_WIDTH_MS,
    bins: [[]],
    baseline: events.slice(0, Math.min(RESISTANCE_BASELINE_KEEP, events.length))
  };
  Object.defineProperty(events, '_cap', {
    value: cap, enumerable: false, configurable: true, writable: true
  });
  for (let i = cap.baseline.length; i < events.length; i++) placeEventInCap(cap, events[i]);
  events._dirty = true;
  return cap;
}

/**
 * Flatten the width-doubling bins so callers see chronological order.
 * Idempotent when not dirty. outlierCellByResistance depends on this.
 */
export function normalizeResistanceEvents(events) {
  if (!Array.isArray(events)) return events;
  if (!events._dirty && !events._cap) {
    events.yearCounts = resistanceEventYearCounts(events);
    return events;
  }
  if (events._cap && events._dirty) {
    const kept = flattenCap(events._cap);
    events.length = 0;
    for (let i = 0; i < kept.length; i++) events.push(kept[i]);
    events._dirty = false;
  }
  if (Number.isFinite(events.seenCount)) {
    events.droppedCount = Math.max(0, events.seenCount - events.length);
  }
  events.yearCounts = resistanceEventYearCounts(events);
  return events;
}

function appendCappedResistanceEvent(events, event) {
  if (typeof events.droppedCount !== 'number') events.droppedCount = 0;
  events.seenCount = (events.seenCount || 0) + 1;
  // Once the span-wide cap is active, never return to the unbounded push
  // path — normalize may leave length slightly under MAX_RESISTANCE_EVENTS.
  if (!events._cap && events.length < MAX_RESISTANCE_EVENTS) {
    events.push(event);
    return;
  }
  const cap = events._cap || initResistanceCap(events);
  placeEventInCap(cap, event);
  events._dirty = true;
  events.droppedCount = events.seenCount - capKeptCount(cap);
}

/**
 * prev/curr: { t, i, cells[8], soc, tMean, bal[8]|null }
 * Mutates `events` (capped). Never drops |I|>1000 A samples — flags them.
 * Overflow is counted on `events.droppedCount` (never silent).
 */
export function considerResistanceEvent(prev, curr, events) {
  if (!prev || !curr) return null;
  if (!Number.isFinite(prev.i) || !Number.isFinite(curr.i)) return null;
  const dI = curr.i - prev.i;
  if (Math.abs(dI) < LFP_DI_THRESHOLD) return null;
  if (Math.abs(prev.i) < LFP_I_ABS_MIN && Math.abs(curr.i) < LFP_I_ABS_MIN) return null;
  if (!Array.isArray(prev.cells) || !Array.isArray(curr.cells)) return null;
  const r = eventResistance(prev.cells, curr.cells, dI);
  if (!r || r.every(v => v == null)) return null;
  const event = {
    t: curr.t,
    dI,
    i: curr.i,
    r,
    soc: curr.soc,
    tMean: curr.tMean,
    bal: curr.bal || null,
    highCurrent: Math.abs(curr.i) > 1000 || Math.abs(prev.i) > 1000
  };
  if (Array.isArray(events)) appendCappedResistanceEvent(events, event);
  return event;
}

export function resistanceSeriesByCell(events) {
  const cells = Array.from({ length: 8 }, () => []);
  (events || []).forEach(ev => {
    if (!ev?.r) return;
    ev.r.forEach((value, i) => {
      if (Number.isFinite(value)) cells[i].push({ t: ev.t, r: value, soc: ev.soc, tMean: ev.tMean, i: ev.i });
    });
  });
  return cells;
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i];
}

/** Level-1 operating-point matching: keep events whose SOC/T/I sit near the cohort median. */
export function binMatch(events, { socTol = 15, tTol = 15, iTol = 25 } = {}) {
  const list = (events || []).filter(e => e && e.r);
  if (list.length < 8) return list;
  const socs = list.map(e => e.soc).filter(Number.isFinite).sort((a, b) => a - b);
  const temps = list.map(e => e.tMean).filter(Number.isFinite).sort((a, b) => a - b);
  const is = list.map(e => e.i).filter(Number.isFinite).sort((a, b) => a - b);
  const socC = quantile(socs, 0.5);
  const tC = quantile(temps, 0.5);
  const iC = quantile(is, 0.5);
  return list.filter(e => {
    if (socC != null && Number.isFinite(e.soc) && Math.abs(e.soc - socC) > socTol) return false;
    if (tC != null && Number.isFinite(e.tMean) && Math.abs(e.tMean - tC) > tTol) return false;
    if (iC != null && Number.isFinite(e.i) && Math.abs(e.i - iC) > iTol) return false;
    return true;
  });
}

function dailyMedianR(points) {
  const byDay = new Map();
  points.forEach(p => {
    const d = new Date(p.t);
    const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(p.r);
  });
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, rs]) => ({ t, r: median(rs) }));
}

export function piecewiseKnee(daily) {
  const xs = daily.map((p, i) => i);
  const ys = daily.map(p => p.r);
  const n = daily.length;
  if (n < 24) return null;
  let best = null;
  for (let i = 8; i < n - 8; i++) {
    const left = linreg(xs.slice(0, i), ys.slice(0, i));
    const right = linreg(xs.slice(i), ys.slice(i));
    const sse = left.sse + right.sse;
    const slopeRatio = Math.abs(right.slope) / Math.max(Math.abs(left.slope), 1e-9);
    if (!best || sse < best.sse) {
      best = {
        index: i, t: daily[i].t, sse, slopeRatio,
        preSlope: left.slope, postSlope: right.slope
      };
    }
  }
  return best;
}

export function kneedleKnee(daily) {
  const n = daily.length;
  if (n < 24) return null;
  const t0 = daily[0].t;
  const tSpan = daily[n - 1].t - t0 || 1;
  const r0 = daily[0].r;
  const rSpan = (daily[n - 1].r - r0) || 1e-9;
  let bestI = 0;
  let bestDiff = -Infinity;
  daily.forEach((p, i) => {
    const x = (p.t - t0) / tSpan;
    const y = (p.r - r0) / rSpan;
    // Resistance typically stays low then rises: the curve lags the chord, so
    // x - y peaks near the late acceleration (hockey-stick knee).
    const diff = x - y;
    if (diff > bestDiff) { bestDiff = diff; bestI = i; }
  });
  return { index: bestI, t: daily[bestI].t, score: bestDiff };
}

export function detectKnee(rPoints) {
  const daily = dailyMedianR(rPoints || []).filter(p => Number.isFinite(p.r));
  const pw = piecewiseKnee(daily);
  const kn = kneedleKnee(daily);
  if (!pw || !kn) {
    return { available: false, reason: '저항 시계열이 짧아 knee를 독립 탐지할 수 없음', piecewise: pw, kneedle: kn };
  }
  const span = (daily[daily.length - 1].t - daily[0].t) || 1;
  const agree = Math.abs(pw.t - kn.t) <= 0.25 * span;
  return {
    available: agree,
    reason: agree ? null : 'piecewise와 kneedle knee 시점이 25% 창 밖에서 불일치',
    t: agree ? (pw.t + kn.t) / 2 : null,
    piecewise: pw,
    kneedle: kn,
    daily
  };
}

export function outlierCellByResistance(events) {
  const byCell = resistanceSeriesByCell(events);
  let best = { cell: null, score: -Infinity };
  byCell.forEach((pts, i) => {
    if (pts.length < 4) return;
    const last = median(pts.slice(-Math.max(4, Math.floor(pts.length / 5))).map(p => p.r));
    const first = median(pts.slice(0, Math.max(4, Math.floor(pts.length / 5))).map(p => p.r));
    if (!Number.isFinite(last) || !Number.isFinite(first)) return;
    const score = last - first;
    if (score > best.score) best = { cell: i + 1, score, last, first };
  });
  return best.cell ? best : { cell: null, score: 0 };
}

export function balancingBurden(events) {
  const ah = Array(8).fill(0);
  let prevT = null;
  (events || []).forEach(ev => {
    if (!ev.bal || prevT == null) { prevT = ev.t; return; }
    const dtH = Math.max(0, (ev.t - prevT) / 3600000);
    ev.bal.forEach((b, i) => {
      if (Number.isFinite(b)) ah[i] += Math.abs(b) * dtH;
    });
    prevT = ev.t;
  });
  return ah;
}

export function temperatureResidual(samples) {
  // samples: {t, temps[4]}
  return (samples || []).map(s => {
    const temps = (s.temps || []).filter(Number.isFinite);
    const m = median(temps);
    if (m == null) return { t: s.t, residual: null };
    return { t: s.t, residual: Math.max(...temps.map(v => v - m)) };
  });
}

export function snapshotFromRow(rowObj) {
  const cells = [];
  for (let i = 1; i <= 8; i++) {
    const v = Number.parseFloat(rowObj[`U_Cell_${i}`]);
    cells.push(Number.isFinite(v) ? v : null);
  }
  if (cells.some(v => v == null)) return null;
  const i = Number.parseFloat(rowObj.I_Battery);
  const soc = Number.parseFloat(rowObj.SOC_Battery);
  const temps = [];
  for (let k = 1; k <= 4; k++) {
    const names = [`T_${k}`, `Temp_${k}`, `Temperature_${k}`, `T${k}`];
    for (const n of names) {
      if (rowObj[n] != null && rowObj[n] !== '') {
        const tv = Number.parseFloat(rowObj[n]);
        if (Number.isFinite(tv)) temps.push(tv);
        break;
      }
    }
  }
  const bal = [];
  for (let k = 1; k <= 8; k++) {
    const names = [`I_Bal_${k}`, `I_Balance_${k}`, `BalancingCurrent_${k}`, `I_Cell_Bal_${k}`];
    let found = null;
    for (const n of names) {
      if (rowObj[n] != null && rowObj[n] !== '') {
        const bv = Number.parseFloat(rowObj[n]);
        if (Number.isFinite(bv)) { found = bv; break; }
      }
    }
    bal.push(found);
  }
  return {
    i: Number.isFinite(i) ? i : null,
    cells,
    soc: Number.isFinite(soc) ? soc : null,
    tMean: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null,
    temps: temps.length ? temps : null,
    bal: bal.some(v => v != null) ? bal : null
  };
}
