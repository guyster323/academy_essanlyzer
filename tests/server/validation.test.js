import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, parseStructuredResult, ValidationError } from '../../server/lib/validation.js';

test('detect-anomaly request rejects a missing csText', () => {
  assert.throws(() => parseRequest('detect-anomaly', {
    priorCase: '', combinedLogText: 'x', totalRows: 1, sourceCount: 1
  }), ValidationError);
});

test('detect-issues request rejects a non-numeric totalRows', () => {
  assert.throws(() => parseRequest('detect-issues', {
    combinedLogText: 'x', totalRows: '10', sourceCount: 1
  }), ValidationError);
});

test('detect-issues request rejects unknown extra properties (strict)', () => {
  assert.throws(() => parseRequest('detect-issues', {
    combinedLogText: 'x', totalRows: 1, sourceCount: 1, extraField: 'nope'
  }), ValidationError);
});

test('detect-issues response rejects more than 4 issues', () => {
  const issue = { id: 'I1', title: 't', occurredAt: 'a', sourceFile: 'f', description: 'd', alarmCodes: [], level: '중' };
  assert.throws(() => parseStructuredResult('detect-issues', { issues: [issue, issue, issue, issue, issue] }));
});

test('generate-hypotheses response rejects a severity outside the enum', () => {
  const hyp = {
    id: 'H1', name: 'n', domain: 'PCS', expectedSignature: 'e', actualObservation: 'a',
    evidence: 'ev', confidence: 'High', severityDraft: '매우높음', severityReason: 'r'
  };
  assert.throws(() => parseStructuredResult('generate-hypotheses', { hypotheses: [hyp] }));
});

test('draft-report response rejects an empty report field', () => {
  assert.throws(() => parseStructuredResult('draft-report', {
    report: { headline: '', occurrence: 'o', anomalySummary: 'a', rootCause: 'r', actionRecommendation: 'ar' },
    email: { to: 'CS', subject: 's', body: 'b' }
  }));
});

test('draft-report request rejects a confirmedHyp missing a name', () => {
  assert.throws(() => parseRequest('draft-report', {
    issueStructured: { issueType: 't', facility: 'f', occurredAt: 'o', priorHistory: 'p' },
    anomalyWindows: [],
    confirmedHyp: { name: '', domain: 'PCS', expectedSignature: '', actualObservation: '', evidence: '' },
    finalSeverity: '상',
    finalSeverityReason: '이유'
  }), ValidationError);
});

test('generate-hypotheses response rejects a degenerate "test"-filled hypothesis (regression: observed live via the CLI provider)', () => {
  const junkHyp = {
    id: 'H1', name: 'test', domain: 'Battery/BMS',
    expectedSignature: 'test', actualObservation: 'test', evidence: 'test',
    confidence: 'Medium', severityDraft: '중', severityReason: 'test'
  };
  assert.throws(() => parseStructuredResult('generate-hypotheses', { hypotheses: [junkHyp] }));
});

test('generate-hypotheses response rejects a hypothesis whose substantive fields are all identical, even with real-looking (non-"test") text', () => {
  const repeatedText = '동일한 문장이 반복 사용됨';
  const dup = {
    id: 'H1', name: repeatedText, domain: 'PCS',
    expectedSignature: repeatedText, actualObservation: repeatedText, evidence: repeatedText,
    confidence: 'Low', severityDraft: '하', severityReason: '근거 부족'
  };
  assert.throws(() => parseStructuredResult('generate-hypotheses', { hypotheses: [dup] }));
});

test('generate-hypotheses response accepts a genuine, well-formed hypothesis', () => {
  const good = {
    id: 'H1', name: 'BMS 셀 밸런싱 회로 결함', domain: 'Battery/BMS',
    expectedSignature: '셀 간 전압 편차가 시간에 따라 확대되는 패턴',
    actualObservation: '3.61V에서 3.95V로 약 2분간 급상승 후 자동 차단',
    evidence: '동일 랙에서 3개월 내 2회 반복 이력이 있어 열화 가능성을 뒷받침함',
    confidence: 'Medium', severityDraft: '상', severityReason: '반복 발생 및 안전 리스크로 상향 판단'
  };
  const result = parseStructuredResult('generate-hypotheses', { hypotheses: [good] });
  assert.equal(result.hypotheses[0].name, 'BMS 셀 밸런싱 회로 결함');
});

test('valid requests and responses pass through unchanged', () => {
  const req = parseRequest('detect-issues', { combinedLogText: 'log', totalRows: 5, sourceCount: 1 });
  assert.equal(req.totalRows, 5);

  const res = parseStructuredResult('draft-report', {
    report: { headline: 'h', occurrence: 'o', anomalySummary: 'a', rootCause: 'r', actionRecommendation: 'ar' },
    email: { to: 'CS', subject: 's', body: 'b' }
  });
  assert.equal(res.report.headline, 'h');
});
