import test from 'node:test';
import assert from 'node:assert/strict';
import { frozenFromPairs } from '../../src/series-engine.js';
import { buildFigures } from '../../src/figures.js';

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
