import { binsToXY, pickTopEntities, MAX_SERIES_ENTITIES, primaryRange } from './series-engine.js';
import { CHART_PALETTE } from './charts.js';
import {
  classifyCommonMode, maxAbsDeltaAnchor, dpDtPercentile, qualityOverlap, eventStates, windowedNormalized
} from './forensics/aemo.js';
import {
  resistanceSeriesByCell, binMatch, detectKnee, outlierCellByResistance, balancingBurden
} from './forensics/lfp.js';

function xySeries(frozen, signal, name, color, which = 'mean', withBand = true) {
  const { t, y, lo, hi } = binsToXY(frozen, signal, which);
  const s = { name, color, t, y };
  if (withBand) { s.lo = lo; s.hi = hi; }
  return s;
}

function emptyFigure(id, claim, reason, extra = {}) {
  return {
    id, claim, available: false, unavailableReason: reason,
    evidenceTier: 'Derived', series: [], markers: [], summaryStats: {},
    xLabel: '', yLabel: '', ...extra
  };
}

function genericFigures(seriesByEntity) {
  const entries = Object.entries(seriesByEntity || {});
  if (!entries.length) {
    return [emptyFigure('F-generic-1', '주신호 시계열에서 이상 구간을 시각화한다', '시계열 포인트가 부족합니다')];
  }
  const [id, frozen] = entries[0];
  const signal = (frozen.signals || []).find(s => s !== 'quality') || frozen.signals?.[0];
  if (!signal || !frozen.bins?.length) {
    return [emptyFigure('F-generic-1', '주신호 시계열에서 이상 구간을 시각화한다', '수치 신호를 시계열로 남기지 못했습니다')];
  }
  return [{
    id: 'F-generic-1',
    claim: `${id}의 ${signal} 시계열 — 관측 구간 동안의 주신호 변화`,
    available: true,
    evidenceTier: 'Derived',
    xLabel: '시간',
    yLabel: signal,
    series: [xySeries(frozen, signal, `${id} ${signal}`, CHART_PALETTE[0])],
    markers: [],
    summaryStats: { entity: id, signal, points: frozen.bins.length, range: primaryRange(frozen, signal) }
  }];
}

function aemoFigures(seriesByEntity, focusHint) {
  const top = pickTopEntities(seriesByEntity, { primarySignal: 'mw', limit: MAX_SERIES_ENTITIES });
  const ids = Object.keys(top);
  const focusId = (focusHint && top[focusHint]) ? focusHint
    : ids.slice().sort((a, b) => primaryRange(top[b], 'mw') - primaryRange(top[a], 'mw'))[0];
  const figures = [];

  if (!focusId) {
    return [emptyFigure('A-F1', '선택 설비의 출력은 당일 정상 운전 범위를 이탈하는 구간이 있다', 'MEASURED_MW 시계열이 없습니다')];
  }
  const focus = top[focusId];
  const anchor = maxAbsDeltaAnchor(focus, 'mw');
  figures.push({
    id: 'A-F1',
    claim: `${focusId} 출력은 당일 정상 운전 범위를 이탈하는 구간이 있다`,
    available: focus.bins.length >= 2,
    unavailableReason: focus.bins.length >= 2 ? null : '포인트 부족',
    evidenceTier: 'Derived',
    xLabel: '시간', yLabel: 'MW',
    series: [xySeries(focus, 'mw', focusId, CHART_PALETTE[0])],
    markers: anchor ? [{ t: anchor.t, label: `ΔP ${anchor.delta.toFixed(1)} MW` }] : [],
    summaryStats: {
      entity: focusId, rangeMw: primaryRange(focus, 'mw'),
      eventDeltaMw: anchor ? anchor.delta : null, eventT: anchor ? anchor.t : null
    }
  });

  const zoom = windowedNormalized(focus, (anchor?.t) || (focus.bins[0]?.t || 0), 20 * 60 * 1000, 'mw');
  const states = eventStates(focus, 'mw');
  figures.push({
    id: 'A-F2',
    claim: '주요 변화는 수 분 단위 사건으로 집중된다',
    available: zoom.length >= 3,
    unavailableReason: zoom.length >= 3 ? null : '이벤트 창에 점이 부족합니다',
    evidenceTier: 'Derived',
    xLabel: '시간', yLabel: '정규화 ΔP',
    series: [{ name: focusId, color: CHART_PALETTE[0], t: zoom.map(p => p.t), y: zoom.map(p => p.y) }],
    markers: states.filter(s => s.state === 'Main').map(s => ({ t: s.t, label: s.state })),
    summaryStats: { entity: focusId, windowPoints: zoom.length, states: states.map(s => s.state) }
  });

  const dP = dpDtPercentile(focus, 'mw');
  const { t, y } = binsToXY(focus, 'mw', 'mean');
  const rateY = [];
  const rateT = [];
  for (let i = 1; i < t.length; i++) {
    const dtH = (t[i] - t[i - 1]) / 3600000;
    if (dtH <= 0) continue;
    rateT.push(t[i]);
    rateY.push(Math.abs(y[i] - y[i - 1]) / dtH);
  }
  figures.push({
    id: 'A-F3',
    claim: `출력 변화율은 당일 중앙값 대비 크다 (p95=${dP.p95.toFixed(1)} MW/h)`,
    available: rateT.length >= 2,
    unavailableReason: rateT.length >= 2 ? null : 'dP/dt를 계산할 구간이 없습니다',
    evidenceTier: 'Derived',
    xLabel: '시간', yLabel: '|dP/dt| MW/h',
    series: [{ name: '|dP/dt|', color: CHART_PALETTE[1], t: rateT, y: rateY }],
    markers: [],
    summaryStats: dP
  });

  const cm = classifyCommonMode(focusId, top, { signal: 'mw' });
  const peerSeries = Object.entries(top).map(([id, frozen], i) => {
    const win = windowedNormalized(frozen, (cm.anchor?.t) || (anchor?.t) || 0, 15 * 60 * 1000, 'mw');
    return { name: id, color: CHART_PALETTE[i % CHART_PALETTE.length], t: win.map(p => p.t), y: win.map(p => p.y) };
  }).filter(s => s.t.length);
  const af4Available = peerSeries.length >= 2 && cm.mode !== 'unknown';
  figures.push({
    id: 'A-F4',
    claim: cm.mode === 'common-mode'
      ? '타 설비가 같은 창에서 동조한다 — Local HW 가능성은 하락'
      : (cm.mode === 'local'
        ? '포커스 설비만 급변한다 — Local fault branch가 상대적으로 강함'
        : '타 설비와 동시 반응 여부를 이 로그만으로 닫을 수 없다'),
    available: af4Available || (peerSeries.length >= 1 && cm.mode === 'unknown'),
    unavailableReason: peerSeries.length ? (af4Available ? null : cm.reason) : '비교할 타 설비 시계열이 없습니다',
    evidenceTier: 'Derived',
    xLabel: '시간', yLabel: '정규화 ΔP',
    series: peerSeries,
    markers: cm.anchor ? [{ t: cm.anchor.t, label: 'anchor' }] : [],
    summaryStats: {
      mode: cm.mode, score: cm.score, peerCount: cm.peerCount, reason: cm.reason,
      supportingCount: cm.supportingCount || 0
    }
  });

  const q = qualityOverlap(focus);
  const qSeries = [];
  if ((focus.signals || []).includes('mw')) qSeries.push(xySeries(focus, 'mw', 'MW', CHART_PALETTE[0], 'mean', false));
  figures.push({
    id: 'A-F5',
    claim: q.qualityDegradedAtEvent
      ? '이벤트 시각에 telemetry 품질이 함께 저하되어 물리적 출력으로 즉시 해석하면 안 된다'
      : '품질 플래그 저하 없이 출력 변화가 관측된다',
    available: qSeries.length > 0,
    unavailableReason: qSeries.length ? null : 'MW 시계열 없음',
    evidenceTier: 'Derived',
    xLabel: '시간', yLabel: 'MW',
    series: qSeries,
    markers: [],
    summaryStats: q
  });

  figures.push(emptyFigure(
    'A-F6',
    'Actual–Target 오차가 어느 신호에서 먼저 시작됐는가',
    '이 소스에 Dispatch Target 컬럼이 없어 A-F6는 그릴 수 없습니다 — Unknown으로 남깁니다'
  ));

  return figures;
}

function lfpFigures(seriesByEntity, resistanceEvents) {
  const frozen = Object.values(seriesByEntity || {})[0];
  const events = resistanceEvents || [];
  const figures = [];

  const matched = binMatch(events);
  const byCell = resistanceSeriesByCell(matched.length ? matched : events);
  const rSeries = byCell.map((pts, i) => ({
    name: `Cell ${i + 1}`,
    color: CHART_PALETTE[i % CHART_PALETTE.length],
    t: pts.map(p => p.t),
    y: pts.map(p => p.r)
  })).filter(s => s.t.length);
  const rOut = outlierCellByResistance(matched.length ? matched : events);
  figures.push({
    id: 'B-F1',
    claim: rOut.cell
      ? `Cell ${rOut.cell} 경로의 유효 직렬저항이 동료 셀과 분리된다 (전기화학/커넥터/부식은 미확정)`
      : '셀 경로 저항 시계열 — 이벤트 전류 전이가 있으면 발산 셀을 표시한다',
    available: rSeries.length > 0,
    unavailableReason: rSeries.length ? null : '전류 전이 이벤트가 부족해 저항을 추정하지 못했습니다',
    evidenceTier: 'Derived',
    xLabel: '시간', yLabel: 'R (상대, V/A)',
    series: rSeries,
    markers: [],
    summaryStats: { outlierCell: rOut.cell, deltaR: rOut.score, eventCount: events.length, matchedCount: matched.length }
  });

  const matchedSeries = resistanceSeriesByCell(matched);
  const rSeriesMatched = matchedSeries.map((pts, i) => ({
    name: `Cell ${i + 1}`,
    color: CHART_PALETTE[i % CHART_PALETTE.length],
    t: pts.map(p => p.t),
    y: pts.map(p => p.r)
  })).filter(s => s.t.length);
  figures.push({
    id: 'B-F2',
    claim: '저항 분리가 SOC/T/I 매칭 후에도 남는가',
    available: rSeriesMatched.length > 0,
    unavailableReason: rSeriesMatched.length ? null : '운영점 매칭을 통과한 저항 이벤트가 없습니다',
    evidenceTier: 'Derived',
    xLabel: '시간', yLabel: 'R (matched)',
    series: rSeriesMatched,
    markers: [],
    summaryStats: { matchedCount: matched.length, rawCount: events.length }
  });

  const vSignal = frozen && (frozen.signals || []).includes('vRange') ? 'vRange'
    : frozen && (frozen.signals || []).includes('vStd') ? 'vStd' : null;
  figures.push({
    id: 'B-F3',
    claim: 'Cell 전압 분산이 장기적으로 확대되는가 (전압 잔차 — 저항이 아님)',
    available: Boolean(frozen && vSignal && frozen.bins.length >= 2),
    unavailableReason: frozen && vSignal ? null : '전압 분산 시계열이 없습니다',
    evidenceTier: 'Derived',
    xLabel: '시간', yLabel: vSignal || 'V',
    series: frozen && vSignal ? [xySeries(frozen, vSignal, vSignal, CHART_PALETTE[2])] : [],
    markers: [],
    summaryStats: { signal: vSignal, note: '전압 잔차 (저항 아님)' }
  });

  const focusPts = rOut.cell ? byCell[rOut.cell - 1] : [];
  const knee = focusPts.length ? detectKnee(focusPts) : { available: false, reason: '발산 셀 저항 시계열 없음' };
  figures.push({
    id: 'B-F4',
    claim: knee.available
      ? `Resistance knee가 ${new Date(knee.t).toISOString().slice(0, 10)} 부근에서 독립 탐지됨`
      : 'Resistance knee를 이 데이터에서 독립 탐지하지 못함',
    available: Boolean(knee.available && focusPts.length),
    unavailableReason: knee.available ? null : (knee.reason || 'knee 불일치 또는 시계열 부족'),
    evidenceTier: 'Derived',
    xLabel: '시간', yLabel: 'R',
    series: focusPts.length
      ? [{ name: `Cell ${rOut.cell || '?'}`, color: CHART_PALETTE[0], t: focusPts.map(p => p.t), y: focusPts.map(p => p.r) }]
      : [],
    markers: knee.available ? [{ t: knee.t, label: 'knee' }] : [],
    summaryStats: {
      cell: rOut.cell,
      kneeT: knee.t || null,
      piecewiseT: knee.piecewise?.t || null,
      kneedleT: knee.kneedle?.t || null,
      available: knee.available
    }
  });

  figures.push(emptyFigure(
    'B-F5',
    'Cell 이상 확률이 Peer Cell보다 먼저 증가하는가 (GP fault probability)',
    'GP/BattGP는 이번 범위에서 미구현 — Unknown으로 남깁니다'
  ));

  const ah = balancingBurden(events);
  const maxAh = Math.max(...ah, 0);
  figures.push({
    id: 'B-F6',
    claim: maxAh > 0
      ? `Balancing 부담이 Cell ${ah.indexOf(maxAh) + 1}에 치우치는가 (열/밸런싱이 저항 발산을 설명하는지)`
      : 'Balancing·Temperature가 특정 Cell 이상을 설명하는가',
    available: maxAh > 0,
    unavailableReason: maxAh > 0 ? null : 'balancing current 컬럼이 없어 B-F6를 그릴 수 없습니다',
    evidenceTier: 'Derived',
    xLabel: 'Cell', yLabel: '|balancing| Ah',
    series: maxAh > 0
      ? [{ name: 'balancing Ah', color: CHART_PALETTE[3], t: ah.map((_, i) => i + 1), y: ah }]
      : [],
    markers: [],
    summaryStats: { balancingAh: ah, maxCell: maxAh > 0 ? ah.indexOf(maxAh) + 1 : null }
  });

  return figures;
}

export function collectSeriesContext(blocks) {
  const seriesByEntity = {};
  const resistanceEvents = [];
  let formatId = 'generic';
  let focusHint = null;
  (blocks || []).forEach(block => {
    formatId = block.formatId || formatId;
    if (block.entityFilter) focusHint = block.entityFilter;
    Object.entries(block.seriesByEntity || {}).forEach(([id, frozen]) => {
      if (frozen?.bins?.length) seriesByEntity[id] = frozen;
    });
    const byEnt = block.resistanceEventsByEntity || {};
    Object.values(byEnt).forEach(list => {
      if (Array.isArray(list)) resistanceEvents.push(...list);
    });
    if (Array.isArray(block.resistanceEvents)) resistanceEvents.push(...block.resistanceEvents);
  });
  return { seriesByEntity, resistanceEvents, formatId, focusHint };
}

export function buildFigures(blocks) {
  const ctx = collectSeriesContext(blocks);
  if (ctx.formatId === 'aemo-mms') return aemoFigures(ctx.seriesByEntity, ctx.focusHint);
  if (ctx.formatId === 'lfp-cell-array') return lfpFigures(ctx.seriesByEntity, ctx.resistanceEvents);
  return genericFigures(ctx.seriesByEntity);
}

/** Prompt-safe catalog: claims and scalars only, no point arrays. */
export function figureCatalog(figures) {
  return (figures || []).map(fig => ({
    id: fig.id,
    claim: fig.claim,
    available: Boolean(fig.available),
    unavailableReason: fig.unavailableReason || '',
    evidenceTier: fig.evidenceTier || 'Derived',
    summaryStats: fig.summaryStats || {}
  }));
}
