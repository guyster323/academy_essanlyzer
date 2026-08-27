import { test, expect } from '@playwright/test';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', 'Desktop-only');
});

const CSV_TEXT = `timestamp,voltage_V,alarm_code
2024-06-03 10:29:10,3.58,0
2024-06-03 10:32:11,3.91,OV001`;

test('published comparison is available after a report and does not run before', async ({ page }) => {
  await page.route('**/api/detect-anomaly', route => route.fulfill({
    json: {
      issueStructured: { issueType: '과전압', facility: '랙 #3', occurredAt: '2024-06-03 10:32', priorHistory: '없음' },
      anomalyWindows: [{
        timestamp: '2024-06-03 10:32:11', sourceFile: '붙여넣기', parameter: 'voltage_V',
        observedValue: '3.91', normalRange: '3.0-3.7', deviation: '+0.21', alarmCode: 'OV001',
        level: '고', evidenceTier: 'Observed'
      }]
    }
  }));
  await page.route('**/api/generate-hypotheses', route => route.fulfill({
    json: {
      hypotheses: [{
        id: 'H1', name: 'BMS 셀 밸런싱 오작동', domain: 'Battery/BMS',
        expectedSignature: 'e', actualObservation: 'a', evidence: 'ev',
        evidenceTier: 'Inferred', disconfirmingEvidence: 'd', missingSignals: 'm',
        claimLimit: 'c', confidence: 'High', severityDraft: '상', severityReason: 'r'
      }]
    }
  }));
  await page.route('**/api/draft-report', route => route.fulfill({
    json: {
      report: {
        headline: 'h', occurrence: 'o', anomalySummary: 'a', rootCause: 'r', actionRecommendation: 'ar',
        provenBox: '입증', suggestedBox: '시사', unknownBox: '불가',
        independentFindings: ['독립 finding 하나'],
        ftaLeaves: [{ branch: 'Battery/BMS', disposition: 'Possible', evidenceIds: ['E001'] }],
        evidenceCitations: [{ field: 'headline', evidenceIds: ['E001'], figureIds: ['F-generic-1'] }],
        managementImplications: ['조치']
      },
      email: { to: 'CS', subject: 's', body: 'b' }
    }
  }));
  await page.route('**/api/compare-published', route => route.fulfill({
    json: {
      rows: [{
        item: '이상 셀', independentFinding: '독립 finding 하나', publishedFinding: '공개 문장',
        agree: 'partial', rawSufficient: false, notes: '지표 정의가 다름'
      }]
    }
  }));

  await page.goto('/');
  await expect(page.getByRole('button', { name: /공개 결과와 대조/ })).toHaveCount(0);

  await page.fill('#inputCsText', '2024년 6월 3일 현장 ESS 랙 #3에서 과전압 경보 발생. 오전 10시 32분경 BMS 알람 후 자동 차단됨.');
  await page.fill('#inputCsv', CSV_TEXT);
  await page.check('#sensitiveConfirm');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  await page.getByRole('button', { name: /원인 가설 생성/ }).click();
  await page.locator('.hyp-card').first().locator('input[name="hypSelect"]').check();
  await page.locator('#confirmedHypName').fill('BMS 셀 밸런싱 오작동 (확정)');
  await page.locator('#sevSelect').selectOption('상');
  await page.locator('#sevReasonInput').fill('즉시 차단 발생');
  await page.getByRole('button', { name: /확정.*보고서 생성/ }).click();

  await page.locator('#publishedExcerpt').fill('논문은 Cell 8 저항 knee를 약 3년으로 보고한다. 이 문장은 교차검증용 발췌이다.');
  await page.getByRole('button', { name: /공개 결과와 대조/ }).click();
  await expect(page.locator('.comparison-table')).toBeVisible();
  await expect(page.locator('.comparison-table')).toContainText('독립 finding 하나');
});
