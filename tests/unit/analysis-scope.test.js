import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAnalysisScope, civilDayRange, seriesSpanLabel, civilDateLabel
} from '../../src/analysis-scope.js';
import { TIMESTAMP_ASSUMPTIONS } from '../../src/formats.js';
import { frozenFromPairs } from '../../src/series-engine.js';

const AEMO = TIMESTAMP_ASSUMPTIONS['aemo-mms'];

test('resolveAnalysisScope is null when CS and issues carry no date', () => {
  const scope = resolveAnalysisScope({
    csText: '업로드된 구간의 실측 MW만으로 이상을 독립 확인하세요.',
    assumption: AEMO
  });
  assert.equal(scope, null);
});

test('resolveAnalysisScope uses a CS civil date as a one-day window in the assumed zone', () => {
  const scope = resolveAnalysisScope({
    csText: '2024년 3월 3일 현장 설비 출력을 점검해 주세요.',
    assumption: AEMO
  });
  assert.ok(scope);
  const day = civilDayRange(2024, 3, 3, AEMO.offsetMinutes);
  assert.equal(scope.minMs, day.minMs);
  assert.equal(scope.maxMs, day.maxMs);
  assert.equal(scope.label, '2024-03-03');
  assert.ok(scope.sources.includes('cs-text'));
});

test('resolveAnalysisScope unions anomaly-window timestamps into civil days without a hardcoded clock', () => {
  const scope = resolveAnalysisScope({
    anomalyWindows: [
      { timestamp: '2024-03-02 06:00:00' },
      { timestamp: '2024-03-03 18:00:00' }
    ],
    assumption: AEMO
  });
  assert.ok(scope);
  assert.equal(scope.label, '2024-03-02 ~ 2024-03-03');
  assert.ok(scope.sources.includes('anomaly-window'));
});

test('seriesSpanLabel names the civil range of a multi-day frozen series', () => {
  const frozen = frozenFromPairs('U1', [
    [Date.UTC(2024, 2, 1, 4, 0, 0), 10],
    [Date.UTC(2024, 2, 3, 4, 0, 0), 20]
  ], 'mw');
  assert.equal(seriesSpanLabel(frozen, AEMO.offsetMinutes), '2024-03-01 ~ 2024-03-03');
  assert.equal(civilDateLabel(Date.UTC(2024, 2, 3, 4, 0, 0), AEMO.offsetMinutes), '2024-03-03');
});
