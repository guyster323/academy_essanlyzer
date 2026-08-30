import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  ATTRIBUTION_STATUS,
  normalizeCellLabel,
  detectAttributionConflict,
  describeAttributionConflict,
  shouldShowAttributionConflict
} from '../../src/attribution-conflict.js';
import { makeAccumulator, feedLine, applyAccumulatorToSource } from '../../src/log-engine.js';
import { LFP_CELL_ARRAY_FORMAT } from '../../src/formats.js';
import { buildFigures } from '../../src/figures.js';

const CASE_B_COUNTS = { 'Cell 8': 9271, 'Cell 3': 50, 'Cell 5': 45 };
const CASE_B_RESISTANCE = {
  id: 'B-F1',
  summaryStats: {
    outlierCell: 5,
    deltaR: 0.012,
    matchedCount: 1330,
    droppedEvents: 51677,
    eventCount: 4000
  }
};

function conflictInput({ counts = CASE_B_COUNTS, outlierCell = 5, figures, derived, blocks } = {}) {
  return {
    blocks: blocks ?? [{ derived: { categoryCounts: { outlierCell: counts } } }],
    figures: figures ?? [{ ...CASE_B_RESISTANCE, summaryStats: { ...CASE_B_RESISTANCE.summaryStats, outlierCell } }],
    derived
  };
}

test('normalizeCellLabel accepts "Cell 8", 8, and "cell8"', () => {
  assert.equal(normalizeCellLabel('Cell 8'), 'Cell 8');
  assert.equal(normalizeCellLabel(8), 'Cell 8');
  assert.equal(normalizeCellLabel('cell8'), 'Cell 8');
  assert.equal(normalizeCellLabel(0), null);
  assert.equal(normalizeCellLabel(null), null);
  assert.equal(normalizeCellLabel(''), null);
});

test('conflict: voltage residual Cell 8 vs event resistance Cell 5 (Case B shape)', () => {
  const result = detectAttributionConflict(conflictInput());
  assert.equal(result.status, ATTRIBUTION_STATUS.CONFLICT);
  assert.equal(result.conflict, true);
  assert.equal(result.voltageResidual.cell, 'Cell 8');
  assert.equal(result.voltageResidual.count, 9271);
  assert.equal(result.voltageResidual.total, 9366);
  assert.ok(Math.abs(result.voltageResidual.share - 9271 / 9366) < 1e-12);
  assert.equal(result.eventResistance.cell, 'Cell 5');
  assert.equal(result.eventResistance.deltaR, 0.012);
  assert.equal(result.eventResistance.matchedCount, 1330);
  assert.equal(result.eventResistance.droppedEvents, 51677);
  assert.equal(result.eventResistance.eventCount, 4000);
  assert.deepEqual(result.missing, []);
  assert.equal(shouldShowAttributionConflict(result), true);

  const desc = describeAttributionConflict(result);
  assert.ok(desc);
  assert.match(desc.title, /상충/);
  assert.equal(desc.sides[0].method, '전압 잔차 (Vdev)');
  assert.equal(desc.sides[1].method, '이벤트 저항 (B-F1)');
  assert.equal(desc.sides[0].cell, 'Cell 8');
  assert.equal(desc.sides[1].cell, 'Cell 5');
  assert.match(desc.sides[0].cannotProve, /저항 아님/);
  assert.match(desc.sides[1].stats, /1330|1,330/);
  assert.match(desc.sides[1].cannotProve, /drop/);
  assert.doesNotMatch(desc.caution, /채택|우선|더 신뢰|기본값/);
  assert.doesNotMatch(desc.title, /Cell 8이 맞|Cell 5가 맞/);
});

test('agreement: both methods name the same cell (numeric vs "Cell N")', () => {
  const result = detectAttributionConflict(conflictInput({
    counts: { 'Cell 8': 100, 'Cell 1': 2 },
    outlierCell: 'Cell 8'
  }));
  assert.equal(result.status, ATTRIBUTION_STATUS.AGREEMENT);
  assert.equal(result.conflict, false);
  assert.equal(result.voltageResidual.cell, 'Cell 8');
  assert.equal(result.eventResistance.cell, 'Cell 8');
  assert.equal(shouldShowAttributionConflict(result), false);
  assert.equal(describeAttributionConflict(result), null);
});

test('cross-check unavailable: voltage residual present, event resistance missing', () => {
  const result = detectAttributionConflict({
    blocks: [{ derived: { categoryCounts: { outlierCell: { 'Cell 8': 10 } } } }],
    figures: [{ id: 'B-F1', summaryStats: { outlierCell: null, matchedCount: 0, droppedEvents: 0 } }]
  });
  assert.equal(result.status, ATTRIBUTION_STATUS.CROSS_CHECK_UNAVAILABLE);
  assert.equal(result.conflict, false);
  assert.equal(result.voltageResidual.cell, 'Cell 8');
  assert.equal(result.eventResistance.cell, null);
  assert.deepEqual(result.missing, ['eventResistance']);
  assert.equal(shouldShowAttributionConflict(result), false);
  assert.equal(describeAttributionConflict(result), null);
});

test('cross-check unavailable: event resistance present, voltage residual missing', () => {
  const result = detectAttributionConflict({
    blocks: [{ derived: { categoryCounts: {} } }],
    figures: [CASE_B_RESISTANCE]
  });
  assert.equal(result.status, ATTRIBUTION_STATUS.CROSS_CHECK_UNAVAILABLE);
  assert.equal(result.conflict, false);
  assert.equal(result.voltageResidual.cell, null);
  assert.equal(result.eventResistance.cell, 'Cell 5');
  assert.deepEqual(result.missing, ['voltageResidual']);
  assert.equal(shouldShowAttributionConflict(result), false);
});

test('cross-check unavailable: both sides missing is not a conflict', () => {
  const result = detectAttributionConflict({ blocks: [], figures: [] });
  assert.equal(result.status, ATTRIBUTION_STATUS.CROSS_CHECK_UNAVAILABLE);
  assert.equal(result.conflict, false);
  assert.ok(result.missing.includes('voltageResidual'));
  assert.ok(result.missing.includes('eventResistance'));
  assert.equal(shouldShowAttributionConflict(result), false);
});

test('cross-check unavailable: B-F1 figure absent is missing, not a conflict', () => {
  const result = detectAttributionConflict({
    derived: { categoryCounts: { outlierCell: { 'Cell 8': 4 } } },
    figures: [{ id: 'B-F3', summaryStats: { note: '전압 잔차 (저항 아님)' } }]
  });
  assert.equal(result.status, ATTRIBUTION_STATUS.CROSS_CHECK_UNAVAILABLE);
  assert.deepEqual(result.missing, ['eventResistance']);
});

test('tied voltage-residual top counts are not a unique attribution', () => {
  const result = detectAttributionConflict(conflictInput({
    counts: { 'Cell 8': 10, 'Cell 5': 10 }
  }));
  assert.equal(result.status, ATTRIBUTION_STATUS.CROSS_CHECK_UNAVAILABLE);
  assert.equal(result.voltageResidual.cell, null);
  assert.deepEqual(result.voltageResidual.tie, ['Cell 5', 'Cell 8']);
  assert.equal(result.conflict, false);
});

test('stride80 Case B log actually conflicts: voltage residual Cell 8 vs event resistance Cell 5', { timeout: 120_000 }, async (t) => {
  const csvPath = path.resolve('Log_sample/extracted/data_sys_6_stride80.csv');
  if (!existsSync(csvPath)) {
    t.skip('stride80 csv is not in this checkout');
    return;
  }
  const acc = makeAccumulator(LFP_CELL_ARRAY_FORMAT);
  const rl = createInterface({ input: createReadStream(csvPath) });
  for await (const line of rl) {
    if (line.trim()) feedLine(acc, line);
  }
  const src = { name: 'data_sys_6_stride80.csv' };
  applyAccumulatorToSource(src, acc);
  const block = {
    label: src.name,
    formatId: 'lfp-cell-array',
    derived: src.derived,
    seriesByEntity: src.seriesByEntity,
    resistanceEventsByEntity: src.resistanceEventsByEntity,
    droppedResistanceEvents: src.droppedResistanceEvents
  };
  const figures = buildFigures([block]);
  const result = detectAttributionConflict({ blocks: [block], figures });
  assert.equal(src.derived.alarmCount, 9366);
  assert.equal(result.status, ATTRIBUTION_STATUS.CONFLICT);
  assert.equal(result.voltageResidual.cell, 'Cell 8');
  assert.equal(result.eventResistance.cell, 'Cell 5');
  assert.ok(result.voltageResidual.count >= 9000);
  assert.ok(Number.isFinite(result.eventResistance.matchedCount));
  assert.ok(Number.isFinite(result.eventResistance.droppedEvents));
});

test('group-level derived categoryCounts are included', () => {
  const result = detectAttributionConflict({
    blocks: [{
      derived: { categoryCounts: {} },
      groups: {
        rackA: { derived: { categoryCounts: { outlierCell: { 'Cell 2': 3 } } } }
      }
    }],
    figures: [{ id: 'B-F1', summaryStats: { outlierCell: 7, deltaR: 0.1, matchedCount: 1, droppedEvents: 0, eventCount: 1 } }]
  });
  assert.equal(result.status, ATTRIBUTION_STATUS.CONFLICT);
  assert.equal(result.voltageResidual.cell, 'Cell 2');
  assert.equal(result.voltageResidual.count, 3);
  assert.equal(result.eventResistance.cell, 'Cell 7');
});
