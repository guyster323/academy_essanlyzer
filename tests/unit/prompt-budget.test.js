import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksToPromptText } from '../../src/pipeline.js';
import { MAX_SELECTED_SOURCES, MAX_GROUPS_PER_SOURCE_IN_PROMPT, MAX_TOTAL_ALARM_CONTEXTS, MAX_LOG_TEXT_CHARS } from '../../src/log-engine.js';

function makeAlarmSamples(n) {
  return Array.from({ length: n }, (_, i) => [{ timestamp: `t${i}`, value: `v${i}` }]);
}

function makeFlatBlock(label, alarmCount) {
  return {
    label, columns: ['timestamp', 'value'], delimiter: ',',
    rowCount: 1000, alarmCount,
    headSample: [{ timestamp: 't0', value: '1' }],
    alarmSamples: makeAlarmSamples(alarmCount),
    stats: { value: { min: 0, max: 1, sum: 1, count: 1 } },
    groups: null
  };
}

function makeGroupedBlock(label, groupCount, alarmsPerGroup) {
  const groups = {};
  for (let i = 0; i < groupCount; i++) {
    groups[`ENTITY_${i}`] = {
      rowCount: 100, alarmCount: alarmsPerGroup,
      headSample: [{ timestamp: 't0', value: '1' }],
      alarmSamples: makeAlarmSamples(alarmsPerGroup),
      stats: { value: { min: 0, max: 1, sum: 1, count: 1 } }
    };
  }
  return { label, columns: ['timestamp', 'value'], delimiter: ',', rowCount: groupCount * 100, alarmCount: groupCount * alarmsPerGroup, groups };
}

test('series bins are not copied into the prompt text', () => {
  const huge = { t: 1, count: 1, min: { value: 0 }, max: { value: 9 }, mean: { value: 1 } };
  const block = makeFlatBlock('with-series', 0);
  block.seriesByEntity = {
    u1: { entityId: 'u1', signals: ['value'], bins: Array.from({ length: 2000 }, () => huge) }
  };
  const { text } = blocksToPromptText([block]);
  assert.equal(text.includes('"bins"'), false);
  assert.ok(text.length < 50_000);
});

test('more than MAX_SELECTED_SOURCES sources are capped and reported', () => {
  const blocks = Array.from({ length: 17 }, (_, i) => makeFlatBlock(`source-${i}`, 0));
  const { count, truncation } = blocksToPromptText(blocks);
  assert.equal(count, MAX_SELECTED_SOURCES);
  assert.equal(truncation.excludedSources, 17 - MAX_SELECTED_SOURCES);
});

test('entity groups beyond the per-source cap are excluded and reported, not silently dropped', () => {
  const block = makeGroupedBlock('market-source', 25, 0);
  const { text, truncation } = blocksToPromptText([block]);
  assert.equal(truncation.excludedGroups, 25 - MAX_GROUPS_PER_SOURCE_IN_PROMPT);
  assert.match(text, /기타 15개 엔티티 상세 생략/);
});

test('alarm-context windows are capped GLOBALLY across all sources, not per-source', () => {
  // 3 sources x 40 alarms each = 120 available, way over the 60-window budget.
  const blocks = [makeFlatBlock('a', 40), makeFlatBlock('b', 40), makeFlatBlock('c', 40)];
  const { truncation } = blocksToPromptText(blocks);
  assert.equal(truncation.excludedAlarmContexts, 120 - MAX_TOTAL_ALARM_CONTEXTS);
});

test('combined prompt text never exceeds MAX_LOG_TEXT_CHARS even with many large groups', () => {
  const block = makeGroupedBlock('huge-source', MAX_GROUPS_PER_SOURCE_IN_PROMPT, 40);
  const { text, truncation } = blocksToPromptText([block, block, block, block, block]);
  assert.ok(text.length <= MAX_LOG_TEXT_CHARS);
  if (text.length >= MAX_LOG_TEXT_CHARS) {
    assert.ok(truncation.textTruncatedChars > 0);
  }
});

test('no truncation occurs (and no truncation note is prefixed) for a small, well-bounded input', () => {
  const blocks = [makeFlatBlock('single-source', 2)];
  const { text, truncation } = blocksToPromptText(blocks);
  assert.equal(truncation.excludedSources, 0);
  assert.equal(truncation.excludedGroups, 0);
  assert.equal(truncation.excludedAlarmContexts, 0);
  assert.equal(truncation.droppedResistanceEvents, 0);
  assert.equal(truncation.textTruncatedChars, 0);
  assert.equal(truncation.lowTimeCoverage, false);
  assert.doesNotMatch(text, /데이터 규모 제한으로/);
  assert.doesNotMatch(text, /알람 근거 시간 범위가 데이터 전체 구간의 일부만 덮습니다/);
});

test('dropped resistance events are reported in truncation, never silently', () => {
  const block = makeFlatBlock('data_sys_6.csv', 2);
  block.droppedResistanceEvents = 1234;
  const { text, truncation } = blocksToPromptText([block]);
  assert.equal(truncation.droppedResistanceEvents, 1234);
  assert.match(text, new RegExp(`저항 이벤트 ${Number(1234).toLocaleString()}건 생략\\(초기 기준선\\+최근 창 유지\\)`));
});

test('when anything is truncated, a human-readable note is prefixed into the prompt text itself', () => {
  const blocks = Array.from({ length: 12 }, (_, i) => makeFlatBlock(`source-${i}`, 0));
  const { text } = blocksToPromptText(blocks);
  assert.match(text, /^\[참고: 데이터 규모 제한으로 일부가 생략된 상태입니다/);
});

test('derived metrics and source format profiles are included in the bounded prompt output', () => {
  const block = {
    ...makeFlatBlock('data_sys_6.csv', 1),
    formatId: 'lfp-cell-array',
    formatLabel: 'LFP cell-array 필드 데이터',
    entityColumn: null,
    derived: {
      label: 'cross-cell Vdev / voltage closure',
      alarmCount: 1,
      metricStats: {
        maxAbsVdev: { min: 0.001, max: 0.42, sum: 0.421, count: 2 },
        maxRobustZ: { min: 0, max: 8.1, sum: 8.1, count: 2 }
      },
      reasonCounts: { 'Cell 8 cross-cell Vdev': 1 },
      categoryCounts: { outlierCell: { 'Cell 8': 1 } }
    },
    alarmAnnotations: [{ kind: 'derived', reason: 'Cell 8 cross-cell Vdev', details: { zScore: 8.1 } }]
  };
  const result = blocksToPromptText([block]);
  assert.match(result.text, /LFP cell-array/);
  assert.match(result.text, /maxAbsVdev/);
  assert.match(result.text, /Cell 8 cross-cell Vdev/);
  assert.equal(result.sourceProfiles[0].formatId, 'lfp-cell-array');
});
