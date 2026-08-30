/** Compare voltage-residual vs event-resistance cell attributions.
 *  Both values already exist at runtime — this module only compares them.
 *  "the two disagree" and "one side is missing" are different states. */

export const ATTRIBUTION_STATUS = {
  CONFLICT: 'conflict',
  AGREEMENT: 'agreement',
  CROSS_CHECK_UNAVAILABLE: 'cross-check-unavailable'
};

export function normalizeCellLabel(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return `Cell ${Math.trunc(value)}`;
  }
  const s = String(value).trim();
  const m = /cell\s*(\d+)/i.exec(s) || /^(\d+)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `Cell ${n}`;
}

function addCountMap(target, map, seen) {
  if (!map || typeof map !== 'object' || seen.has(map)) return;
  seen.add(map);
  Object.entries(map).forEach(([key, raw]) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    const cell = normalizeCellLabel(key);
    if (!cell) return;
    target[cell] = (target[cell] || 0) + n;
  });
}

function outlierCellCountsFrom(blocks, derived) {
  const counts = {};
  const seen = new Set();
  const hasBlocks = Array.isArray(blocks) && blocks.length > 0;
  if (hasBlocks) {
    blocks.forEach(block => {
      addCountMap(counts, block?.derived?.categoryCounts?.outlierCell, seen);
      const groups = block?.groups;
      if (groups && typeof groups === 'object') {
        Object.values(groups).forEach(bucket => {
          addCountMap(counts, bucket?.derived?.categoryCounts?.outlierCell, seen);
        });
      }
    });
  } else if (derived?.categoryCounts?.outlierCell) {
    addCountMap(counts, derived.categoryCounts.outlierCell, seen);
  } else if (derived && typeof derived === 'object' && !derived.categoryCounts) {
    addCountMap(counts, derived, seen);
  }
  return counts;
}

function voltageResidualSide(blocks, derived) {
  const counts = outlierCellCountsFrom(blocks, derived);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (!total) {
    return { cell: null, count: 0, total: 0, share: null, counts };
  }
  const topCount = entries[0][1];
  const tied = entries.filter(([, n]) => n === topCount).map(([cell]) => cell);
  if (tied.length !== 1) {
    return { cell: null, count: topCount, total, share: topCount / total, counts, tie: tied };
  }
  const cell = tied[0];
  return { cell, count: topCount, total, share: topCount / total, counts };
}

function eventResistanceSide(figures) {
  const empty = {
    cell: null, deltaR: null, matchedCount: null, droppedEvents: null, eventCount: null
  };
  const fig = (figures || []).find(f => f && f.id === 'B-F1');
  if (!fig) return empty;
  const s = fig.summaryStats || {};
  const num = (v) => Number.isFinite(v) ? v : null;
  return {
    cell: normalizeCellLabel(s.outlierCell),
    deltaR: num(s.deltaR),
    matchedCount: num(s.matchedCount),
    droppedEvents: num(s.droppedEvents),
    eventCount: num(s.eventCount)
  };
}

export function detectAttributionConflict({ blocks, figures, derived } = {}) {
  const voltageResidual = voltageResidualSide(blocks, derived);
  const eventResistance = eventResistanceSide(figures);
  const voltagePresent = Boolean(voltageResidual.cell);
  const resistancePresent = Boolean(eventResistance.cell);
  const missing = [];
  if (!voltagePresent) missing.push('voltageResidual');
  if (!resistancePresent) missing.push('eventResistance');

  if (missing.length) {
    return {
      status: ATTRIBUTION_STATUS.CROSS_CHECK_UNAVAILABLE,
      conflict: false,
      voltageResidual,
      eventResistance,
      missing
    };
  }
  if (voltageResidual.cell !== eventResistance.cell) {
    return {
      status: ATTRIBUTION_STATUS.CONFLICT,
      conflict: true,
      voltageResidual,
      eventResistance,
      missing: []
    };
  }
  return {
    status: ATTRIBUTION_STATUS.AGREEMENT,
    conflict: false,
    voltageResidual,
    eventResistance,
    missing: []
  };
}

export function shouldShowAttributionConflict(conflict) {
  return Boolean(conflict && conflict.status === ATTRIBUTION_STATUS.CONFLICT);
}

function formatPct(share) {
  if (!Number.isFinite(share)) return '—';
  const rounded = Math.round(share * 1000) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatDeltaR(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.001) return value.toExponential(3);
  return String(Math.round(value * 1e6) / 1e6);
}

function formatInt(value) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

/** Display model for the banner. Null unless the two methods actually disagree.
 *  Side order is method identity (voltage residual, then event resistance),
 *  not a ranking. */
export function describeAttributionConflict(conflict) {
  if (!shouldShowAttributionConflict(conflict)) return null;
  const v = conflict.voltageResidual || {};
  const r = conflict.eventResistance || {};
  return {
    title: '근거 상충 — 두 방법이 다른 셀을 지목합니다',
    caution: '앱은 어느 쪽이 맞다고 판정하지 않습니다. 가설 선택은 막지 않습니다. 엔지니어가 두 수치와 각 방법의 한계를 보고 판단하십시오.',
    sides: [
      {
        method: '전압 잔차 (Vdev)',
        cell: v.cell,
        stats: `파생 이상 ${formatInt(v.count)} / ${formatInt(v.total)}건 (${formatPct(v.share)})`,
        canProve: '동료 셀 대비 전압이 얼마나 벗어났는지 (Derived).',
        cannotProve: '저항이 아니다. B-F3 주석: 전압 잔차 (저항 아님).'
      },
      {
        method: '이벤트 저항 (B-F1)',
        cell: r.cell,
        stats: `ΔR=${formatDeltaR(r.deltaR)}, 매칭 통과 ${formatInt(r.matchedCount)}건, drop ${formatInt(r.droppedEvents)}건, 이벤트 ${formatInt(r.eventCount)}건`,
        canProve: '전류 전이 이벤트가 포착된 구간에서 경로 저항의 상대 분리.',
        cannotProve: '전류 전이가 없는 구간의 저항. 매칭 통과·drop 건수가 신뢰도를 제한한다.'
      }
    ]
  };
}
