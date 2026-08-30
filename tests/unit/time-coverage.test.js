import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTimeRange, coverageRatio, isLowTimeCoverage, TIME_COVERAGE_WARN_RATIO,
  considerAlarmSample, histogramTimes, formatCoveragePct,
  buildTimeCoverageNote, figureCoveredTimeRange
} from '../../src/time-coverage.js';
import { ALARM_SAMPLE_CAP as ENGINE_CAP } from '../../src/log-engine.js';
import { makeAccumulator, feedLine, applyAccumulatorToSource } from '../../src/log-engine.js';
import { GENERIC_FORMAT } from '../../src/formats.js';
import { blocksToPromptText } from '../../src/pipeline.js';
import { figureCatalog } from '../../src/figures.js';

test('coverageRatio is evidence span over data span and flags below 20%', () => {
  const data = makeTimeRange(Date.parse('2018-01-01T00:00:00Z'), Date.parse('2021-09-15T00:00:00Z'));
  const evidence = makeTimeRange(Date.parse('2018-10-10T00:00:00Z'), Date.parse('2018-12-01T00:00:00Z'));
  const ratio = coverageRatio(evidence, data);
  assert.ok(ratio < TIME_COVERAGE_WARN_RATIO);
  assert.ok(ratio > 0.03 && ratio < 0.05);
  assert.equal(isLowTimeCoverage(ratio), true);
  assert.equal(isLowTimeCoverage(0.5), false);
  assert.equal(coverageRatio(data, data), 1);
  assert.equal(coverageRatio(null, data), 0);
  assert.equal(coverageRatio(evidence, null), null);
});

test('streaming records full data span separately from first-N alarm evidence span', () => {
  const lines = ['timestamp,voltage_V,alarm_code'];
  const t0 = Date.UTC(2018, 0, 1);
  const n = 120;
  for (let i = 0; i < n; i++) {
    const ts = new Date(t0 + i * 86400000).toISOString();
    const alarm = i % 2 === 0 ? 'OV001' : '0';
    lines.push(`${ts},3.5,${alarm}`);
  }
  const acc = makeAccumulator(GENERIC_FORMAT);
  lines.forEach(line => { if (line.trim()) feedLine(acc, line); });
  const src = { name: 'span.csv', encoding: 'utf-8', format: GENERIC_FORMAT };
  applyAccumulatorToSource(src, acc);

  assert.equal(src.dataTimeRange.minMs, t0);
  assert.equal(src.dataTimeRange.maxMs, t0 + (n - 1) * 86400000);
  assert.equal(src.alarmSamples.length, ENGINE_CAP);
  assert.ok(src.alarmDroppedCount > 0);
  // First-N keeps the earliest alarms (even days 0,2,...,78).
  assert.equal(src.evidenceTimeRange.minMs, t0);
  const lastKept = src.alarmSampleTimes[src.alarmSampleTimes.length - 1];
  assert.ok(lastKept < src.dataTimeRange.maxMs);
  assert.ok(src.timeCoverageRatio < 0.8);
  const dist = src.alarmSampleTimeDistribution;
  assert.equal(dist.length, 8);
  assert.ok(dist[0].count > 0, 'first-N fills the earliest data-span bucket');
  assert.equal(dist[dist.length - 1].count, 0, 'first-N leaves the last data-span bucket empty');
});

test('blocksToPromptText prefixes a non-silent note when evidence covers under 20% of the data span', () => {
  const data = makeTimeRange(Date.parse('2018-01-01T00:00:00Z'), Date.parse('2021-09-15T00:00:00Z'));
  const evidence = makeTimeRange(Date.parse('2018-10-10T00:00:00Z'), Date.parse('2018-12-01T00:00:00Z'));
  const ratio = coverageRatio(evidence, data);
  const block = {
    label: 'data_sys_6.csv', columns: ['timestamp', 'value'], delimiter: ',',
    rowCount: 1000, alarmCount: 2,
    headSample: [{ timestamp: 't0', value: '1' }],
    alarmSamples: [[{ timestamp: 't0', value: '1' }]],
    stats: { value: { min: 0, max: 1, sum: 1, count: 1 } },
    groups: null,
    dataTimeRange: data,
    evidenceTimeRange: evidence,
    timeCoverageRatio: ratio,
    alarmDroppedCount: 900,
    alarmSampleTimeDistribution: histogramTimes(
      [evidence.minMs, evidence.maxMs], data
    )
  };
  const { text, truncation, sourceProfiles } = blocksToPromptText([block]);
  assert.equal(truncation.lowTimeCoverage, true);
  assert.match(text, /알람 근거 시간 범위가 데이터 전체 구간의 일부만 덮습니다/);
  assert.match(text, /data_sys_6.csv/);
  assert.match(text, /2018-10-10/);
  assert.match(text, /데이터 시간 범위/);
  assert.equal(sourceProfiles[0].dataTimeRange.min, data.min);
  assert.equal(sourceProfiles[0].evidenceTimeRange.max, evidence.max);
  assert.ok(sourceProfiles[0].timeCoverageRatio < TIME_COVERAGE_WARN_RATIO);
  assert.match(text, /추가 확인 필요/);
});

test('wide evidence coverage does not emit the low-coverage notice', () => {
  const data = makeTimeRange(Date.parse('2018-01-01T00:00:00Z'), Date.parse('2021-09-15T00:00:00Z'));
  const block = {
    label: 'wide.csv', columns: ['timestamp', 'value'], delimiter: ',',
    rowCount: 10, alarmCount: 2,
    headSample: [{ timestamp: 't0', value: '1' }],
    alarmSamples: [[{ timestamp: 't0', value: '1' }]],
    stats: { value: { min: 0, max: 1, sum: 1, count: 1 } },
    groups: null,
    dataTimeRange: data,
    evidenceTimeRange: data,
    timeCoverageRatio: 1,
    alarmDroppedCount: 0,
    alarmSampleTimeDistribution: histogramTimes([data.minMs, data.maxMs], data)
  };
  const { text, truncation } = blocksToPromptText([block]);
  assert.equal(truncation.lowTimeCoverage, false);
  assert.doesNotMatch(text, /알람 근거 시간 범위가 데이터 전체 구간의 일부만 덮습니다/);
  assert.match(text, /데이터 시간 범위/);
});

test('figureCatalog reports each figure\'s covered time range and skips non-time axes', () => {
  const t0 = Date.UTC(2018, 3, 28);
  const t1 = Date.UTC(2021, 8, 15);
  const catalog = figureCatalog([
    {
      id: 'B-F3', claim: 'vRange', available: true, xLabel: '시간',
      series: [{ t: [t0, t1], y: [0.01, 0.04] }],
      evidenceTier: 'Derived', summaryStats: {}
    },
    {
      id: 'B-F6', claim: 'balancing', available: true, xLabel: 'Cell',
      series: [{ t: [1, 2, 3], y: [0, 1, 2] }],
      evidenceTier: 'Derived', summaryStats: {}
    }
  ]);
  assert.equal(catalog[0].timeRange.minMs, t0);
  assert.equal(catalog[0].timeRange.maxMs, t1);
  assert.equal(catalog[1].timeRange, null);
  assert.equal(figureCoveredTimeRange({ xLabel: '시간', series: [] }), null);
});

test('considerAlarmSample first-N counts overflows without thinning the window', () => {
  const bucket = { alarmSamples: [], alarmAnnotations: [], alarmSampleTimes: [] };
  const cap = 4;
  for (let i = 0; i < 10; i++) {
    const window = Array.from({ length: 5 }, (_, k) => ({ i: i - 4 + k }));
    considerAlarmSample(bucket, window, [{ kind: 'flag', reason: String(i) }], 1000 * i, cap);
  }
  assert.equal(bucket.alarmSamples.length, cap);
  assert.equal(bucket.alarmDroppedCount, 6);
  assert.deepEqual(bucket.alarmSampleTimes, [0, 1000, 2000, 3000]);
  assert.equal(bucket.alarmSamples[0].length, 5);
});

test('buildTimeCoverageNote states coverage as fact', () => {
  const note = buildTimeCoverageNote([{
    sourceFile: 'a.csv',
    ratio: 0.04,
    dataTimeRange: makeTimeRange(Date.parse('2018-01-01'), Date.parse('2021-01-01')),
    evidenceTimeRange: makeTimeRange(Date.parse('2018-10-10'), Date.parse('2018-12-01'))
  }]);
  assert.match(note, /a.csv/);
  assert.match(note, /4%/);
  assert.match(note, /추가 확인 필요/);
  assert.equal(formatCoveragePct(0.1234), '12.3%');
});
