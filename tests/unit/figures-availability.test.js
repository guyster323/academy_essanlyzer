import test from 'node:test';
import assert from 'node:assert/strict';
import { frozenFromPairs, createSeriesBuffer, pushSample, freezeSeries } from '../../src/series-engine.js';
import { buildFigures, collectSeriesContext } from '../../src/figures.js';

function availabilityPairs(figures) {
  return Object.fromEntries(figures.map(f => [f.id, {
    available: Boolean(f.available),
    unavailableReason: f.unavailableReason ?? null
  }]));
}

test('empty generic source: F-generic-1 is unavailable with a reason, never both', () => {
  const figures = buildFigures([{ formatId: 'generic', seriesByEntity: {}, resistanceEventsByEntity: {} }]);
  const f = figures.find(x => x.id === 'F-generic-1');
  assert.equal(f.available, false);
  assert.ok(f.unavailableReason);
});

test('empty AEMO source: A-F1 is unavailable with a reason (early return, no A-F6 yet)', () => {
  const figures = buildFigures([{ formatId: 'aemo-mms', seriesByEntity: {}, resistanceEventsByEntity: {} }]);
  assert.equal(figures.length, 1);
  const af1 = figures.find(f => f.id === 'A-F1');
  assert.equal(af1.available, false);
  assert.ok(af1.unavailableReason);
});

test('empty LFP source: B-F3 unavailableReason is set when available is false (PR #2 pin)', () => {
  const figures = buildFigures([{ formatId: 'lfp-cell-array', seriesByEntity: {}, resistanceEventsByEntity: {} }]);
  const pairs = availabilityPairs(figures);
  assert.equal(pairs['B-F1'].available, false);
  assert.ok(pairs['B-F1'].unavailableReason);
  assert.equal(pairs['B-F3'].available, false);
  assert.equal(pairs['B-F3'].unavailableReason, '전압 분산 시계열이 없습니다');
  assert.equal(pairs['B-F5'].available, false);
  assert.ok(pairs['B-F5'].unavailableReason);
  Object.entries(pairs).forEach(([id, v]) => {
    if (v.available) assert.equal(v.unavailableReason, null, `${id} available+reason contradiction`);
    else assert.ok(v.unavailableReason, `${id} unavailable without reason`);
  });
});

test('A-F6 is unavailable and names the missing DEVIATION_MW column when the series has no deviation signal', () => {
  const t0 = Date.UTC(2025, 7, 19, 0, 0, 0);
  const frozen = frozenFromPairs('WDBESS1', [[t0, 10], [t0 + 4000, -40]], 'mw');
  const figures = buildFigures([{
    formatId: 'aemo-mms',
    seriesByEntity: { WDBESS1: frozen }
  }]);
  const af6 = figures.find(f => f.id === 'A-F6');
  assert.ok(af6);
  assert.equal(af6.available, false);
  assert.match(af6.unavailableReason, /DEVIATION_MW 컬럼이 없어/);
  assert.equal(/Dispatch Target/.test(af6.unavailableReason), false);
});

test('A-F6 is unavailable with an insufficient-data reason when DEVIATION_MW is listed but has too few points', () => {
  const buf = createSeriesBuffer({ signals: ['mw', 'deviationMw'] });
  pushSample(buf, 'WDBESS1', Date.UTC(2025, 7, 19, 0, 0, 0), { mw: 10, deviationMw: -2 });
  const frozen = freezeSeries(buf);
  const figures = buildFigures([{
    formatId: 'aemo-mms',
    seriesByEntity: { WDBESS1: frozen }
  }]);
  const af6 = figures.find(f => f.id === 'A-F6');
  assert.equal(af6.available, false);
  assert.match(af6.unavailableReason, /컬럼은 있으나 시계열 값이 부족/);
});

test('A-F6 is available when the frozen series actually has DEVIATION_MW points', () => {
  const buf = createSeriesBuffer({ signals: ['mw', 'scheduledMw', 'deviationMw'] });
  const t0 = Date.UTC(2025, 7, 19, 2, 0, 0);
  pushSample(buf, 'WDBESS1', t0, { mw: 10, scheduledMw: 10, deviationMw: 0 });
  pushSample(buf, 'WDBESS1', t0 + 4000, { mw: 10, scheduledMw: 40, deviationMw: -30 });
  const frozen = freezeSeries(buf);
  const figures = buildFigures([{
    formatId: 'aemo-mms',
    seriesByEntity: { WDBESS1: frozen }
  }]);
  const af6 = figures.find(f => f.id === 'A-F6');
  assert.equal(af6.available, true);
  assert.equal(af6.unavailableReason, null);
  assert.ok(af6.series.some(s => s.name.includes('DEVIATION_MW')));
  assert.equal(af6.summaryStats.eventDeviationMw, -30);
});

test('A-F1 claim uses the series span instead of 당일, and unscoped anchors name their day', () => {
  const buf = createSeriesBuffer({ signals: ['mw'] });
  pushSample(buf, 'U1', Date.UTC(2024, 2, 1, 3, 0, 0), { mw: 100 });
  pushSample(buf, 'U1', Date.UTC(2024, 2, 1, 4, 0, 0), { mw: 0 });
  pushSample(buf, 'U1', Date.UTC(2024, 2, 2, 4, 0, 0), { mw: 10 });
  pushSample(buf, 'U1', Date.UTC(2024, 2, 3, 3, 0, 0), { mw: 50 });
  pushSample(buf, 'U1', Date.UTC(2024, 2, 3, 4, 0, 0), { mw: 20 });
  const frozen = freezeSeries(buf);
  const figures = buildFigures([{
    formatId: 'aemo-mms',
    seriesByEntity: { U1: frozen }
  }]);
  const af1 = figures.find(f => f.id === 'A-F1');
  assert.equal(af1.available, true);
  assert.equal(/당일/.test(af1.claim), false);
  assert.match(af1.claim, /2024-03-01 ~ 2024-03-03/);
  assert.equal(af1.summaryStats.anchorScope, 'global-maximum');
  assert.equal(af1.summaryStats.eventDeltaMw, -100);
  assert.equal(af1.summaryStats.eventDay, '2024-03-01');
  assert.match(af1.markers[0].label, /2024-03-01/);
});

test('A-F1 anchor stays inside the CS analysis day when a scope is given', () => {
  const buf = createSeriesBuffer({ signals: ['mw'] });
  pushSample(buf, 'U1', Date.UTC(2024, 2, 1, 3, 0, 0), { mw: 100 });
  pushSample(buf, 'U1', Date.UTC(2024, 2, 1, 4, 0, 0), { mw: 0 });
  pushSample(buf, 'U1', Date.UTC(2024, 2, 3, 3, 0, 0), { mw: 50 });
  pushSample(buf, 'U1', Date.UTC(2024, 2, 3, 4, 0, 0), { mw: 20 });
  const frozen = freezeSeries(buf);
  const figures = buildFigures([{
    formatId: 'aemo-mms',
    seriesByEntity: { U1: frozen }
  }], { csText: '2024년 3월 3일 설비 출력 점검을 요청합니다.' });
  const af1 = figures.find(f => f.id === 'A-F1');
  assert.equal(af1.summaryStats.anchorScope, 'analysis-window');
  assert.equal(af1.summaryStats.eventDeltaMw, -30);
  assert.equal(af1.summaryStats.eventDay, '2024-03-03');
  assert.equal(af1.summaryStats.globalEventDeltaMw, -100);
});

test('collectSeriesContext merges same-entity bins across sources in time order', () => {
  const later = frozenFromPairs('WDBESS1', [[2000, 20], [3000, 30]], 'mw');
  const earlier = frozenFromPairs('WDBESS1', [[0, 0], [1000, 10]], 'mw');
  const ctx = collectSeriesContext([
    { formatId: 'aemo-mms', seriesByEntity: { WDBESS1: later } },
    { formatId: 'aemo-mms', seriesByEntity: { WDBESS1: earlier } }
  ]);
  const bins = ctx.seriesByEntity.WDBESS1.bins;
  assert.deepEqual(bins.map(b => b.t), [0, 1000, 2000, 3000]);
  assert.deepEqual(bins.map(b => b.mean.mw), [0, 10, 20, 30]);
});

test('LFP B-F3 with a vRange series is available and does not set unavailableReason', () => {
  const t0 = Date.UTC(2018, 0, 1);
  const frozen = frozenFromPairs('_file', [[t0, 0.01], [t0 + 86400000, 0.04]], 'vRange');
  const figures = buildFigures([{
    formatId: 'lfp-cell-array',
    seriesByEntity: { _file: frozen },
    resistanceEventsByEntity: {}
  }]);
  const bf3 = figures.find(f => f.id === 'B-F3');
  assert.equal(bf3.available, true);
  assert.equal(bf3.unavailableReason, null);
  assert.equal(bf3.summaryStats.note, '전압 잔차 (저항 아님)');
});
