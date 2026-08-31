import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, parseStructuredResult, ValidationError } from '../../server/lib/validation.js';

const HYP_EVIDENCE = {
  evidenceTier: 'Inferred',
  disconfirmingEvidence: 'peer cell과 동일한 추세가 확인되면 이 가설은 약화된다',
  missingSignals: '물리 검사 및 원시 BMS fault code가 제공되지 않았다',
  claimLimit: '현재 데이터가 지지하는 범위까지만 해석하고 물리적 원인은 확정하지 않는다'
};

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

test('detect-anomaly request accepts timestamp assumption and sustained windows on source profiles', () => {
  const req = parseRequest('detect-anomaly', {
    csText: '출력 이상을 확인해 주세요. 이 문장은 삼십 자를 넘깁니다.',
    priorCase: '',
    combinedLogText: 'log',
    totalRows: 1,
    sourceCount: 1,
    sourceProfiles: [{
      sourceFile: 'PUBLIC.csv',
      formatId: 'aemo-mms',
      formatLabel: 'AEMO MMS 리포트',
      entityColumn: 'FPP_UNITID',
      rowCount: 100,
      derivedAlarmCount: 9,
      timestampAssumption: {
        id: 'aemo-market-aest',
        offsetMinutes: 600,
        statedInData: false,
        label: '시간대 표기 없음 — 시장 시간대 AEST(UTC+10, 일광절약 없음)로 가정. CSV는 시간대를 적지 않음',
        naiveCount: 100,
        zonedCount: 0
      },
      sustainedWindows: [{
        entityId: 'U1',
        start: '2024-03-03T00:00:00.000Z',
        end: '2024-03-03T00:05:00.000Z',
        startMs: 1,
        endMs: 2,
        count: 6,
        maxAbs: 20,
        maxSigned: -20
      }],
      sustainedWindowsDropped: 0
    }]
  });
  assert.equal(req.sourceProfiles[0].timestampAssumption.id, 'aemo-market-aest');
  assert.equal(req.sourceProfiles[0].sustainedWindows.length, 1);
});

test('detect-issues request rejects unknown extra properties (strict)', () => {
  assert.throws(() => parseRequest('detect-issues', {
    combinedLogText: 'x', totalRows: 1, sourceCount: 1, extraField: 'nope'
  }), ValidationError);
});

test('detect-anomaly response accepts a rich, multi-instance derived-metric observedValue/deviation (reproduced live: format-aware derived detection legitimately exceeds a single-value 200-char budget)', () => {
  const richText = 'vdev -0.0320V~-0.0430V, robust z 3.29~4.05 (알람#1: z=3.32, #2: z=3.29, #3: z=3.93, #4: z=4.05, #5: z=3.53, #6: z=3.63); voltageClosureError -0.002~-0.008V — Cell5가 6개 알람 모두에서 outlier로 지목, 동일 구간 원본 행에서 I_Battery가 0A대에서 -201.17A까지 급락';
  assert.ok(richText.length > 200 && richText.length <= 800);
  const result = parseStructuredResult('detect-anomaly', {
    issueStructured: { issueType: 't', facility: 'f', occurredAt: 'o', priorHistory: 'p' },
    anomalyWindows: [{
      timestamp: '2014-08-21 08:43:34 ~ 09:02:10', sourceFile: 'data_sys_28.csv',
      parameter: 'Vdev_Cell5', observedValue: richText, normalRange: '|robust z| <= 3',
      deviation: richText, alarmCode: 'cross-cell Vdev anomaly', level: '고', evidenceTier: 'Derived'
    }]
  });
  assert.equal(result.anomalyWindows[0].observedValue, richText);
});

test('detect-anomaly response truncates anomalyWindows above the Case B gold-run cap of 16 and records the drop', () => {
  const window = {
    timestamp: 't', sourceFile: 'f', parameter: 'p', observedValue: 'v',
    normalRange: 'n', deviation: 'd', alarmCode: 'a', level: '고', evidenceTier: 'Derived'
  };
  const result = parseStructuredResult('detect-anomaly', {
    issueStructured: { issueType: 't', facility: 'f', occurredAt: 'o', priorHistory: 'p' },
    anomalyWindows: Array.from({ length: 18 }, () => ({ ...window }))
  });
  assert.equal(result.anomalyWindows.length, 16);
  assert.equal(result.truncation.droppedAnomalyWindows, 2);
  assert.equal(result.truncation.kept, 16);
});

test('detect-anomaly response of exactly 16 windows is not truncated', () => {
  const window = {
    timestamp: 't', sourceFile: 'f', parameter: 'p', observedValue: 'v',
    normalRange: 'n', deviation: 'd', alarmCode: 'a', level: '고', evidenceTier: 'Derived'
  };
  const result = parseStructuredResult('detect-anomaly', {
    issueStructured: { issueType: 't', facility: 'f', occurredAt: 'o', priorHistory: 'p' },
    anomalyWindows: Array.from({ length: 16 }, () => ({ ...window }))
  });
  assert.equal(result.anomalyWindows.length, 16);
  assert.equal(result.truncation, undefined);
});

test('detect-anomaly response still rejects an observedValue beyond the 800-char bound', () => {
  assert.throws(() => parseStructuredResult('detect-anomaly', {
    issueStructured: { issueType: 't', facility: 'f', occurredAt: 'o', priorHistory: 'p' },
    anomalyWindows: [{
      timestamp: 't', sourceFile: 'f', parameter: 'p', observedValue: 'x'.repeat(801),
      normalRange: 'n', deviation: 'd', alarmCode: 'a', level: '고', evidenceTier: 'Derived'
    }]
  }));
});

test('detect-issues response rejects more than 4 issues', () => {
  const issue = { id: 'I1', title: 't', occurredAt: 'a', sourceFile: 'f', description: 'd', alarmCodes: [], level: '중' };
  assert.throws(() => parseStructuredResult('detect-issues', { issues: [issue, issue, issue, issue, issue] }));
});

test('generate-hypotheses response rejects a severity outside the enum', () => {
  const hyp = {
    id: 'H1', name: 'n', domain: 'PCS', expectedSignature: 'e', actualObservation: 'a',
    evidence: 'ev', confidence: 'High', severityDraft: '매우높음', severityReason: 'r', ...HYP_EVIDENCE
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
    confidence: 'Medium', severityDraft: '중', severityReason: 'test', ...HYP_EVIDENCE
  };
  assert.throws(() => parseStructuredResult('generate-hypotheses', { hypotheses: [junkHyp] }));
});

test('generate-hypotheses response rejects a hypothesis whose substantive fields are all identical, even with real-looking (non-"test") text', () => {
  const repeatedText = '동일한 문장이 반복 사용됨';
  const dup = {
    id: 'H1', name: repeatedText, domain: 'PCS',
    expectedSignature: repeatedText, actualObservation: repeatedText, evidence: repeatedText,
    confidence: 'Low', severityDraft: '하', severityReason: '근거 부족', ...HYP_EVIDENCE
  };
  assert.throws(() => parseStructuredResult('generate-hypotheses', { hypotheses: [dup] }));
});

test('generate-hypotheses response accepts a genuine, well-formed hypothesis', () => {
  const good = {
    id: 'H1', name: 'BMS 셀 밸런싱 회로 결함', domain: 'Battery/BMS',
    expectedSignature: '셀 간 전압 편차가 시간에 따라 확대되는 패턴',
    actualObservation: '3.61V에서 3.95V로 약 2분간 급상승 후 자동 차단',
    evidence: '동일 랙에서 3개월 내 2회 반복 이력이 있어 열화 가능성을 뒷받침함',
    confidence: 'Medium', severityDraft: '상', severityReason: '반복 발생 및 안전 리스크로 상향 판단', ...HYP_EVIDENCE
  };
  const result = parseStructuredResult('generate-hypotheses', { hypotheses: [good] });
  assert.equal(result.hypotheses[0].name, 'BMS 셀 밸런싱 회로 결함');
});

test('generate-hypotheses response requires explicit evidence tier and counter-evidence fields', () => {
  const incomplete = {
    id: 'H1', name: 'PCS 출력 제한', domain: 'PCS', expectedSignature: '출력 제한 신호',
    actualObservation: '출력 감소', evidence: '관측값', confidence: 'Low', severityDraft: '중', severityReason: '근거'
  };
  assert.throws(() => parseStructuredResult('generate-hypotheses', { hypotheses: [incomplete] }));
});

test('cell-array hypotheses reject definitive physical root-cause claims', () => {
  const badCellHyp = {
    id: 'B-C1', name: 'Cell 8 전기화학적 열화가 확정 원인', domain: 'Cell/Pack',
    expectedSignature: '저항 상승', actualObservation: 'Cell 8 Vdev 상승', evidence: '저항 divergence',
    confidence: 'Medium', severityDraft: '중', severityReason: '관측', ...HYP_EVIDENCE,
    claimLimit: '전기화학적 열화가 확정 원인이다'
  };
  assert.throws(() => parseStructuredResult(
    'generate-hypotheses',
    { hypotheses: [badCellHyp] },
    { sourceProfiles: [{ sourceFile: 'data_sys_6.csv', formatId: 'lfp-cell-array' }] }
  ));
});

test('cell-array hypotheses accept a bounded effective-series-resistance claim', () => {
  const goodCellHyp = {
    id: 'B-C1', name: 'Cell 3 경로의 유효 직렬저항 증가 후보', domain: 'Cell/Pack',
    expectedSignature: 'peer 대비 Cell 3 resistance residual 증가', actualObservation: 'Cell 3 Vdev와 robust z-score 상승',
    evidence: 'cross-cell 파생지표가 같은 방향을 지지하지만 물리 검사는 없음', confidence: 'Medium', severityDraft: '중',
    severityReason: '추가 검증 필요', ...HYP_EVIDENCE,
    claimLimit: '공개 로그로는 Cell 3 경로의 유효 직렬저항 증가 수준까지만 입증 가능하며 전기화학적 열화·커넥터·부식은 확정할 수 없다'
  };
  const result = parseStructuredResult(
    'generate-hypotheses',
    { hypotheses: [goodCellHyp] },
    { sourceProfiles: [{ sourceFile: 'data_sys_6.csv', formatId: 'lfp-cell-array' }] }
  );
  assert.equal(result.hypotheses[0].evidenceTier, 'Inferred');
});

test('valid requests and responses pass through unchanged', () => {
  const req = parseRequest('detect-issues', { combinedLogText: 'log', totalRows: 5, sourceCount: 1 });
  assert.equal(req.totalRows, 5);

  const res = parseStructuredResult('draft-report', {
    report: fullReport({ headline: 'h' }),
    email: { to: 'CS', subject: 's', body: 'b' }
  });
  assert.equal(res.report.headline, 'h');
});

test('draft-report request accepts an optional attributionConflict payload', () => {
  const req = parseRequest('draft-report', {
    issueStructured: { issueType: 't', facility: 'f', occurredAt: 'o', priorHistory: 'p' },
    anomalyWindows: [],
    confirmedHyp: {
      name: 'Cell 경로 유효 직렬저항 증가 후보', domain: 'Cell/Pack',
      expectedSignature: 'e', actualObservation: 'a', evidence: 'ev',
      evidenceTier: 'Inferred', disconfirmingEvidence: 'd', missingSignals: 'm', claimLimit: 'c'
    },
    finalSeverity: '상',
    finalSeverityReason: '엔지니어 확정 사유',
    attributionConflict: {
      status: 'conflict',
      conflict: true,
      voltageResidual: { cell: 'Cell 8', count: 9271, total: 9366, share: 0.99, counts: { 'Cell 8': 9271 } },
      eventResistance: { cell: 'Cell 5', deltaR: 0.012, matchedCount: 1330, droppedEvents: 51677, eventCount: 4000 },
      missing: []
    }
  });
  assert.equal(req.attributionConflict.voltageResidual.cell, 'Cell 8');
  assert.equal(req.attributionConflict.eventResistance.cell, 'Cell 5');
});

function fullReport(overrides = {}) {
  return {
    headline: '셀 과전압이 관측됨',
    occurrence: '발생 개요 문장입니다',
    anomalySummary: '이상 구간 요약입니다',
    rootCause: '확정 원인 문장입니다',
    actionRecommendation: '조치 권고 문장입니다',
    provenBox: '로그에서 직접 본 사실만',
    suggestedBox: '복수 근거로 시사되는 해석',
    unknownBox: '이 데이터로 판단할 수 없는 항목',
    independentFindings: ['독립 finding 하나'],
    ftaLeaves: [{ branch: 'Battery/BMS', disposition: 'Possible', evidenceIds: ['E001'] }],
    evidenceCitations: [{ field: 'headline', evidenceIds: ['E001'], figureIds: ['F-generic-1'] }],
    managementImplications: ['로깅 보존 강화'],
    ...overrides
  };
}

test('draft-report response with available figures is rejected without figure citations', () => {
  assert.throws(() => parseStructuredResult('draft-report', {
    report: fullReport({ evidenceCitations: [{ field: 'headline', evidenceIds: ['E001'], figureIds: [] }] }),
    email: { to: 'CS', subject: '제목입니다', body: '본문입니다' }
  }, { figureCatalog: [{ id: 'F-generic-1', claim: '주신호', available: true }] }));
});

test('draft-report response citing an available figure passes', () => {
  const res = parseStructuredResult('draft-report', {
    report: fullReport(),
    email: { to: 'CS', subject: '제목입니다', body: '본문입니다' }
  }, { figureCatalog: [{ id: 'F-generic-1', claim: '주신호', available: true }] });
  assert.equal(res.report.evidenceCitations[0].figureIds[0], 'F-generic-1');
});

test('compare-published rejects a response that drops frozen independent findings', () => {
  assert.throws(() => parseStructuredResult('compare-published', {
    rows: [{
      item: '이상 셀', independentFinding: '전혀 다른 문장입니다', publishedFinding: 'Cell 8',
      agree: 'no', rawSufficient: true, notes: 'note'
    }]
  }, { independentFindings: ['Cell 경로 저항 발산이 Cell 8에서 관측됨'] }));
});

test('compare-published keeps frozen independent findings', () => {
  const finding = 'Cell 경로 저항 발산이 Cell 8에서 관측됨';
  const res = parseStructuredResult('compare-published', {
    rows: [{
      item: '이상 셀', independentFinding: finding, publishedFinding: 'Cell 8',
      agree: 'yes', rawSufficient: true, notes: '저항 기준'
    }]
  }, { independentFindings: [finding] });
  assert.equal(res.rows[0].agree, 'yes');
});
