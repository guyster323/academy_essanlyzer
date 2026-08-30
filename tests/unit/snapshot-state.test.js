import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotState } from '../../src/pipeline.js';

test('snapshotState drops source-level and bucket-level heavy fields from one list each', () => {
  const snap = snapshotState({
    id: 'CASE-1',
    figureSpecs: [{ id: 'B-F1' }],
    logSources: [{
      id: 'SRC-1',
      name: 'x.csv',
      selected: true,
      _ref: { file: true },
      format: { id: 'lfp-cell-array', parseHeaderRow() {} },
      seriesByEntity: { a: { bins: [1] } },
      resistanceEventsByEntity: { a: [1] },
      derived: { alarmCount: 2 },
      groups: {
        rack: {
          rowCount: 3,
          series: { bins: [] },
          resistanceEvents: [1],
          recentWindow: [{}],
          _lfpPrev: { t: 1 },
          _seriesPrevMw: 10,
          derived: { alarmCount: 1 }
        }
      }
    }]
  });
  assert.equal(snap.figureSpecs, undefined);
  const src = snap.logSources[0];
  assert.equal(src.name, 'x.csv');
  assert.equal(src.derived.alarmCount, 2);
  assert.equal(src._ref, undefined);
  assert.equal(src.format, undefined);
  assert.equal(src.seriesByEntity, undefined);
  assert.equal(src.resistanceEventsByEntity, undefined);
  const bucket = src.groups.rack;
  assert.equal(bucket.rowCount, 3);
  assert.equal(bucket.derived.alarmCount, 1);
  assert.equal(bucket.series, undefined);
  assert.equal(bucket.resistanceEvents, undefined);
  assert.equal(bucket.recentWindow, undefined);
  assert.equal(bucket._lfpPrev, undefined);
  assert.equal(bucket._seriesPrevMw, undefined);
});
