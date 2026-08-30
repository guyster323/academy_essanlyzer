import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTimeRange, coverageRatio, isLowTimeCoverage, TIME_COVERAGE_WARN_RATIO,
  considerAlarmSample, histogramTimes, formatCoveragePct,
  buildTimeCoverageNote, figureCoveredTimeRange,
  MAX_CATEGORY_TIME_BUCKETS, recordCategoryTime, freezeCategoryTimeBuckets
} from '../../src/time-coverage.js';
import { ALARM_SAMPLE_CAP as ENGINE_CAP } from '../../src/log-engine.js';
import { makeAccumulator, feedLine, applyAccumulatorToSource } from '../../src/log-engine.js';
import { GENERIC_FORMAT, detectFormat } from '../../src/formats.js';
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

test('streaming records full data span and stratified alarm evidence covers both ends', () => {
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
  assert.equal(src.alarmDroppedCount, 60 - ENGINE_CAP);
  assert.equal(src.evidenceTimeRange.minMs, t0);
  const lastAlarm = t0 + 118 * 86400000;
  assert.equal(src.evidenceTimeRange.maxMs, lastAlarm);
  assert.ok(src.timeCoverageRatio > 0.9);
  const dist = src.alarmSampleTimeDistribution;
  assert.equal(dist.length, 8);
  assert.ok(dist[0].count > 0, 'stratified sampling keeps early-span alarms');
  assert.ok(dist[dist.length - 1].count > 0, 'stratified sampling keeps late-span alarms');
  src.alarmSamples.forEach(win => {
    assert.ok(win.length <= 5);
    assert.ok(win.length >= 1);
  });
  assert.equal(src.alarmSamples[src.alarmSamples.length - 1].length, 5);
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

test('considerAlarmSample spreads across the span instead of keeping the first N', () => {
  const bucket = { alarmSamples: [], alarmAnnotations: [], alarmSampleTimes: [] };
  const cap = 4;
  for (let i = 0; i < 10; i++) {
    const window = Array.from({ length: 5 }, (_, k) => ({ i: i - 4 + k }));
    considerAlarmSample(bucket, window, [{ kind: 'flag', reason: String(i) }], 1000 * i, cap);
  }
  assert.equal(bucket.alarmSamples.length, cap);
  assert.equal(bucket.alarmDroppedCount, 6);
  const kept = [...bucket.alarmSampleTimes].sort((a, b) => a - b);
  assert.equal(kept[0], 0);
  assert.equal(kept[kept.length - 1], 9000);
  assert.notDeepEqual(kept, [0, 1000, 2000, 3000], 'early-bias first-N must be gone');
  assert.equal(bucket.alarmSamples[0].length, 5);
});

test('time-stratum quotas fill every data-span bucket when alarms exist throughout', () => {
  const bucket = { alarmSamples: [], alarmAnnotations: [], alarmSampleTimes: [] };
  const cap = 40;
  const t0 = Date.UTC(2018, 0, 1);
  const t1 = Date.UTC(2022, 0, 1);
  const n = 400;
  for (let i = 0; i < n; i++) {
    const t = t0 + Math.round((t1 - t0) * i / (n - 1));
    bucket.dataTimeRange = makeTimeRange(t0, t);
    considerAlarmSample(bucket, [{ i }], [{ reason: String(i) }], t, cap);
  }
  const dist = histogramTimes(bucket.alarmSampleTimes, makeTimeRange(t0, t1), 8);
  dist.forEach((b, i) => {
    assert.ok(b.count > 0, `expected samples in data-span bucket ${i}, got ${b.count}`);
  });
  assert.equal(bucket.alarmSamples.length, cap);
  assert.equal(bucket.alarmDroppedCount, n - cap);
});

test('early-clustered alarms plus a late tail keep samples from both ends of the span', () => {
  const bucket = { alarmSamples: [], alarmAnnotations: [], alarmSampleTimes: [] };
  const cap = 8;
  for (let i = 0; i < 50; i++) {
    considerAlarmSample(bucket, [{ i }], [{ reason: String(i) }], i, cap);
  }
  for (let i = 0; i < 5; i++) {
    considerAlarmSample(bucket, [{ i: 1000 + i }], [{ reason: 'late' }], 100000 + i * 1000, cap);
  }
  const kept = [...bucket.alarmSampleTimes].sort((a, b) => a - b);
  assert.equal(kept.length, cap);
  assert.ok(kept[0] < 50, 'keeps an early-cluster sample');
  assert.ok(kept[kept.length - 1] >= 100000, 'keeps a late-tail sample');
  assert.ok(kept.filter(t => t >= 100000).length >= 1);
});

test('outlierCell is aggregated per time bucket so a cell shift is visible', () => {
  const header = 'Timestamp,U_Battery,I_Battery,SOC_Battery,U_Cell_1,U_Cell_2,U_Cell_3,U_Cell_4,U_Cell_5,U_Cell_6,U_Cell_7,U_Cell_8';
  const lines = [header];
  const cellRow = (ts, highIndex) => {
    const cells = Array.from({ length: 8 }, (_, i) => i === highIndex ? '3.80' : '3.30');
    return `${ts},26.4,0,50,${cells.join(',')}`;
  };
  for (let i = 0; i < 8; i++) {
    lines.push(cellRow(`2018-06-0${i + 1}T00:00:00Z`, 7));
  }
  for (let i = 0; i < 8; i++) {
    lines.push(cellRow(`2021-06-0${i + 1}T00:00:00Z`, 0));
  }
  const fmt = detectFormat(lines.slice(0, 3));
  const acc = makeAccumulator(fmt);
  lines.forEach(line => { if (line.trim()) feedLine(acc, line); });
  const src = { name: 'cells.csv', encoding: 'utf-8', format: fmt };
  applyAccumulatorToSource(src, acc);
  assert.equal(src.derived.categoryCounts.outlierCell['Cell 8'], 8);
  assert.equal(src.derived.categoryCounts.outlierCell['Cell 1'], 8);
  const buckets = src.derived.categoryTimeBuckets;
  assert.ok(buckets.length >= 2);
  assert.ok(buckets.length <= MAX_CATEGORY_TIME_BUCKETS);
  const early = buckets[0].counts.outlierCell;
  const late = buckets[buckets.length - 1].counts.outlierCell;
  const earlyTop = Object.entries(early).sort((a, b) => b[1] - a[1])[0][0];
  const lateTop = Object.entries(late).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(earlyTop, 'Cell 8');
  assert.equal(lateTop, 'Cell 1');
});

test('category time buckets stay within MAX_CATEGORY_TIME_BUCKETS', () => {
  const derived = { categoryCounts: {} };
  const t0 = Date.UTC(2018, 0, 1);
  for (let i = 0; i < 400; i++) {
    recordCategoryTime(derived, t0 + i * 86400000, { outlierCell: i % 2 ? 'Cell 8' : 'Cell 3' });
  }
  freezeCategoryTimeBuckets(derived);
  assert.ok(derived.categoryTimeBuckets.length <= MAX_CATEGORY_TIME_BUCKETS);
  assert.ok(derived.categoryTimeBuckets.length >= 2);
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
