import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDetectAnomalyPrompt,
  buildHypothesesPrompt,
  buildDraftReportPrompt
} from '../../server/lib/prompts.js';

const base = {
  sourceFile: 'sample.csv', formatId: 'aemo-mms', formatLabel: 'AEMO MMS',
  entityColumn: 'FPP_UNITID', rowCount: 10, derivedAlarmCount: 1
};

test('source profile text includes data vs alarm-evidence time ranges when present', () => {
  const profile = {
    ...base,
    dataTimeRange: { min: '2018-04-28T00:00:00.000Z', max: '2021-09-15T00:00:00.000Z', minMs: 1, maxMs: 2 },
    evidenceTimeRange: { min: '2018-10-10T00:00:00.000Z', max: '2018-12-01T00:00:00.000Z', minMs: 1, maxMs: 2 },
    timeCoverageRatio: 0.04
  };
  const anomaly = buildDetectAnomalyPrompt({
    csText: '출력 이상을 확인해 주세요', priorCase: '', combinedLogText: 'log',
    totalRows: 10, sourceCount: 1, sourceProfiles: [profile]
  });
  assert.match(anomaly, /데이터 2018-04-28 ~ 2021-09-15/);
  assert.match(anomaly, /알람 근거 2018-10-10 ~ 2018-12-01/);
  assert.match(anomaly, /커버리지 4%/);
});

test('AEMO prompts require independent MEASURED_MW evidence and grid-domain hypotheses', () => {
  const anomaly = buildDetectAnomalyPrompt({
    csText: '출력 이상을 확인해 주세요', priorCase: '', combinedLogText: 'MEASURED_MW robust z',
    totalRows: 10, sourceCount: 1, sourceProfiles: [base]
  });
  const hypotheses = buildHypothesesPrompt({
    issueStructured: {}, anomalyWindows: [], priorCase: '', sourceProfiles: [base]
  });
  assert.match(anomaly, /12:15–12:20/);
  assert.match(anomaly, /MW_QUALITY_FLAG/);
  assert.match(hypotheses, /Telemetry\/SCADA/);
  assert.match(hypotheses, /disconfirmingEvidence/);
  assert.match(hypotheses, /missingSignals/);
  assert.match(hypotheses, /A-F4/);
});

test('cell-array prompts force data-driven peer-cell analysis and root-cause limits', () => {
  const profile = {
    sourceFile: 'data_sys_6.csv', formatId: 'lfp-cell-array',
    formatLabel: 'LFP cell-array 필드 데이터', entityColumn: null,
    rowCount: 20, derivedAlarmCount: 2
  };
  const prompt = buildHypothesesPrompt({
    issueStructured: {}, anomalyWindows: [{ parameter: 'maxAbsVdev', evidenceTier: 'Derived' }],
    priorCase: '', sourceProfiles: [profile]
  });
  const report = buildDraftReportPrompt({
    issueStructured: {}, anomalyWindows: [], confirmedHyp: { claimLimit: 'limit' },
    finalSeverity: '중', finalSeverityReason: 'reason', sourceProfiles: [profile]
  });
  assert.match(prompt, /robust_center\(다른 7개 Cell\)/);
  assert.match(prompt, /Cell N 경로의 유효 직렬저항 증가/);
  assert.match(prompt, /Cell 8을 사전 가정하거나 하드코딩하지 마라/);
  assert.match(prompt, /B-F1/);
  assert.match(report, /확정 원인이 아닌 미확인 대안/);
  assert.match(report, /Vdev/);
});

test('draft-report prompt records an attribution conflict as fact and does not pick a cell', () => {
  const profile = {
    sourceFile: 'data_sys_6.csv', formatId: 'lfp-cell-array',
    formatLabel: 'LFP cell-array 필드 데이터', entityColumn: null,
    rowCount: 20, derivedAlarmCount: 2
  };
  const report = buildDraftReportPrompt({
    issueStructured: {}, anomalyWindows: [], confirmedHyp: { claimLimit: 'limit' },
    finalSeverity: '중', finalSeverityReason: 'reason', sourceProfiles: [profile],
    attributionConflict: {
      status: 'conflict',
      conflict: true,
      voltageResidual: { cell: 'Cell 8', count: 9271, total: 9366, share: 9271 / 9366 },
      eventResistance: { cell: 'Cell 5', deltaR: 0.012, matchedCount: 1330, droppedEvents: 51677, eventCount: 4000 }
    }
  });
  assert.match(report, /교차 지목 사실/);
  assert.match(report, /Cell 8/);
  assert.match(report, /Cell 5/);
  assert.match(report, /9271\/9366/);
  assert.match(report, /matchedCount=1330/);
  assert.match(report, /droppedEvents=51677/);
  assert.match(report, /결론을 지시하지 않는다/);
  assert.doesNotMatch(report, /Cell 8을 채택/);
  assert.doesNotMatch(report, /Cell 5가 맞다/);
});

test('draft-report prompt omits the conflict block when a side is missing', () => {
  const report = buildDraftReportPrompt({
    issueStructured: {}, anomalyWindows: [], confirmedHyp: { claimLimit: 'limit' },
    finalSeverity: '중', finalSeverityReason: 'reason',
    attributionConflict: {
      status: 'cross-check-unavailable',
      conflict: false,
      voltageResidual: { cell: 'Cell 8', count: 10, total: 10, share: 1 },
      eventResistance: { cell: null },
      missing: ['eventResistance']
    }
  });
  assert.doesNotMatch(report, /교차 지목 사실/);
});
