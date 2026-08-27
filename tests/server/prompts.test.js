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
  assert.match(report, /확정 원인이 아닌 미확인 대안/);
});
