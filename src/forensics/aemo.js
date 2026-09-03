import { binsToXY } from '../series-engine.js';

const WINDOW_MS = 15 * 60 * 1000;

function indicesInRange(t, range) {
  if (!range || !Number.isFinite(range.minMs) || !Number.isFinite(range.maxMs)) {
    return t.map((_, i) => i);
  }
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] >= range.minMs && t[i] < range.maxMs) out.push(i);
  }
  return out;
}

export function maxAbsDeltaAnchor(frozen, signal = 'mw', range = null) {
  const { t, y } = binsToXY(frozen, signal, 'mean');
  const idx = indicesInRange(t, range);
  if (idx.length < 2) return null;
  const first = idx[0];
  let best = null;
  for (let k = 1; k < idx.length; k++) {
    const i = idx[k];
    const prev = idx[k - 1];
    const d = y[i] - y[prev];
    const score = Math.abs(d);
    if (!best || score > best.score) best = { t: t[i], index: i, delta: d, score, from: y[prev], to: y[i] };
  }
  // Also consider deviation from the first in-range sample (slow ramps).
  for (let k = 1; k < idx.length; k++) {
    const i = idx[k];
    const d = y[i] - y[first];
    const score = Math.abs(d);
    if (best && score > best.score * 1.05) {
      best = { t: t[i], index: i, delta: d, score, from: y[first], to: y[i] };
    }
  }
  if (best) best.scoped = Boolean(range);
  return best;
}

export function windowedNormalized(frozen, anchorT, radiusMs = WINDOW_MS, signal = 'mw') {
  const { t, y } = binsToXY(frozen, signal, 'mean');
  const lo = anchorT - radiusMs;
  const hi = anchorT + radiusMs;
  const pts = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] < lo || t[i] > hi) continue;
    pts.push({ t: t[i], y: y[i] });
  }
  if (!pts.length) return [];
  const y0 = pts[0].y;
  const scale = Math.max(...pts.map(p => Math.abs(p.y - y0)), 1e-6);
  return pts.map(p => ({ t: p.t, y: (p.y - y0) / scale }));
}

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (!Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

function resampleTo(points, gridT) {
  if (!points.length) return gridT.map(() => 0);
  return gridT.map(t => {
    let best = points[0];
    let bestD = Math.abs(points[0].t - t);
    for (let i = 1; i < points.length; i++) {
      const d = Math.abs(points[i].t - t);
      if (d < bestD) { best = points[i]; bestD = d; }
    }
    return best.y;
  });
}

export function dpDtPercentile(frozen, signal = 'mw') {
  const { t, y } = binsToXY(frozen, signal, 'mean');
  const rates = [];
  for (let i = 1; i < t.length; i++) {
    const dtH = (t[i] - t[i - 1]) / 3600000;
    if (dtH <= 0) continue;
    rates.push(Math.abs(y[i] - y[i - 1]) / dtH);
  }
  if (!rates.length) return { p50: 0, p95: 0, max: 0, eventMax: 0 };
  rates.sort((a, b) => a - b);
  const at = (p) => rates[Math.min(rates.length - 1, Math.floor(p * (rates.length - 1)))];
  return { p50: at(0.5), p95: at(0.95), max: rates[rates.length - 1], eventMax: rates[rates.length - 1] };
}

export function qualityOverlap(frozen, range = null) {
  const mw = binsToXY(frozen, 'mw', 'mean');
  const q = binsToXY(frozen, 'quality', 'mean');
  if (!mw.t.length) return { qualityDegradedAtEvent: false, eventQuality: null };
  const anchor = maxAbsDeltaAnchor(frozen, 'mw', range);
  if (!anchor) return { qualityDegradedAtEvent: false, eventQuality: null };
  let eventQuality = null;
  for (let i = 0; i < q.t.length; i++) {
    if (Math.abs(q.t[i] - anchor.t) < 60 * 1000) { eventQuality = q.y[i]; break; }
  }
  if (eventQuality == null && q.y.length) {
    let bestI = 0;
    let bestD = Infinity;
    q.t.forEach((t, i) => {
      const d = Math.abs(t - anchor.t);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    eventQuality = q.y[bestI];
  }
  // AEMO: 1 = good. Anything else is degraded telemetry.
  return {
    qualityDegradedAtEvent: Number.isFinite(eventQuality) && eventQuality !== 1,
    eventQuality
  };
}

/**
 * Classify Local vs Common-mode from frozen MW series.
 * Never uses a published clock time — the focus entity's own max |ΔP| is the anchor.
 */
export function classifyCommonMode(focusId, seriesByEntity, { signal = 'mw', radiusMs = WINDOW_MS, range = null } = {}) {
  const focus = seriesByEntity?.[focusId];
  const peerIds = Object.keys(seriesByEntity || {}).filter(id => id !== focusId);
  if (!focus) {
    return { mode: 'unknown', score: 0, peerCount: 0, reason: '포커스 설비 시계열이 없음', anchor: null, peerScores: [] };
  }
  const anchor = maxAbsDeltaAnchor(focus, signal, range);
  if (!anchor) {
    return { mode: 'unknown', score: 0, peerCount: peerIds.length, reason: '포커스 설비에서 급변 앵커를 찾지 못함', anchor: null, peerScores: [] };
  }
  if (!peerIds.length) {
    return {
      mode: 'unknown',
      score: 0,
      peerCount: 0,
      reason: '비교할 타 설비 시계열이 없어 Local vs Common-mode를 닫을 수 없음',
      anchor,
      peerScores: []
    };
  }
  const focusWin = windowedNormalized(focus, anchor.t, radiusMs, signal);
  const grid = focusWin.map(p => p.t);
  const focusY = focusWin.map(p => p.y);
  const peerScores = peerIds.map(id => {
    const win = windowedNormalized(seriesByEntity[id], anchor.t, radiusMs, signal);
    const y = resampleTo(win, grid);
    const corr = pearson(focusY, y);
    const sameSign = (anchor.delta || 0) === 0 || focusY.length < 2 || y.length < 2
      ? false
      : Math.sign(focusY[focusY.length - 1]) === Math.sign(y[y.length - 1]);
    return { id, corr, sameSign };
  });
  const supporting = peerScores.filter(p => p.corr >= 0.45 && p.sameSign);
  const score = peerScores.length
    ? peerScores.reduce((s, p) => s + p.corr, 0) / peerScores.length
    : 0;
  let mode = 'local';
  let reason = '포커스 설비만 독립적으로 급변 — Local fault branch가 상대적으로 강함';
  if (supporting.length >= 1 && score >= 0.35) {
    mode = 'common-mode';
    reason = `타 설비 ${supporting.length}개가 같은 창에서 동조 (평균 상관 ${score.toFixed(2)}) — Local HW 가능성은 하락`;
  } else if (peerScores.every(p => p.corr < 0.2)) {
    mode = 'local';
    reason = '타 설비와 상관 없음 — 포커스 단독 급변';
  }
  return { mode, score, peerCount: peerIds.length, reason, anchor, peerScores, supportingCount: supporting.length };
}

export function eventStates(frozen, signal = 'mw', range = null) {
  const anchor = maxAbsDeltaAnchor(frozen, signal, range);
  if (!anchor) return [];
  const { t } = binsToXY(frozen, signal, 'mean');
  const t0 = t[0];
  const tEnd = t[t.length - 1];
  const pre = Math.max(t0, anchor.t - 10 * 60 * 1000);
  const rec = Math.min(tEnd, anchor.t + 10 * 60 * 1000);
  return [
    { state: 'Normal', t: t0 },
    { state: 'Precursor', t: pre },
    { state: 'Main', t: anchor.t },
    { state: 'Recovery', t: rec }
  ];
}
