import { test, expect } from '@playwright/test';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', 'Desktop-only for readability of the assertions; layout itself is covered by responsive.spec.js');
});

const CSV_TEXT = `timestamp,voltage_V,alarm_code
2024-06-03 10:29:10,3.58,0
2024-06-03 10:32:11,3.91,OV001`;

const MOCK_ANOMALY = {
  issueStructured: { issueType: '과전압', facility: '랙 #3', occurredAt: '2024-06-03 10:32', priorHistory: '없음' },
  anomalyWindows: [{ timestamp: '2024-06-03 10:32:11', sourceFile: '붙여넣기', parameter: 'voltage_V', observedValue: '3.91', normalRange: '3.0-3.7', deviation: '+0.21', alarmCode: 'OV001', level: '고' }]
};
const MOCK_HYPOTHESES = {
  hypotheses: [{ id: 'H1', name: 'BMS 셀 밸런싱 오작동', domain: 'Battery/BMS', expectedSignature: 'e', actualObservation: 'a', evidence: 'ev', confidence: 'High', severityDraft: '상', severityReason: 'r' }]
};
const MOCK_REPORT = {
  report: { headline: 'AI 초안 헤드라인', occurrence: 'AI 초안 발생개요', anomalySummary: 'AI 초안 이상구간요약', rootCause: 'AI 초안 원인', actionRecommendation: 'AI 초안 조치권고' },
  email: { to: 'CS 담당자', subject: 'AI 초안 제목', body: 'AI 초안 본문' }
};

async function reachReportView(page) {
  await page.route('**/api/detect-anomaly', route => route.fulfill({ json: MOCK_ANOMALY }));
  await page.route('**/api/generate-hypotheses', route => route.fulfill({ json: MOCK_HYPOTHESES }));
  await page.route('**/api/draft-report', route => route.fulfill({ json: MOCK_REPORT }));

  await page.goto('/');
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
  await expect(page.locator('.headline-box')).toBeVisible();
}

test('report headline/sections and email fields are editable textareas, not read-only text', async ({ page }) => {
  await reachReportView(page);

  const headline = page.locator('#reportHeadline');
  await expect(headline).toBeVisible();
  await expect(headline).toHaveValue('AI 초안 헤드라인');
  await headline.fill('엔지니어가 수정한 헤드라인');

  const body = page.locator('#emailBody');
  await body.fill('엔지니어가 수정한 메일 본문');
  await expect(body).toHaveValue('엔지니어가 수정한 메일 본문');
});

test('copying the report uses the currently edited text, not the original AI draft', async ({ page }) => {
  await reachReportView(page);
  await page.locator('#reportHeadline').fill('수정된 헤드라인 XYZ');

  await page.evaluate(() => { window.__copiedText = null; navigator.clipboard.writeText = (t) => { window.__copiedText = t; return Promise.resolve(); }; });
  await page.getByRole('button', { name: /보고서 전체 복사/ }).click();
  const copied = await page.evaluate(() => window.__copiedText);
  expect(copied).toContain('수정된 헤드라인 XYZ');
  expect(copied).not.toContain('AI 초안 헤드라인');
});

test('completing the case is blocked until the final review checkbox (기술 정확성·민감정보·심각도) is checked', async ({ page }) => {
  await reachReportView(page);

  const completeBtn = page.getByRole('button', { name: /완료.*신규 케이스 시작/ });
  await expect(completeBtn).toBeDisabled();
  await expect(page.locator('label:has(#finalReviewConfirm)')).toContainText(/기술적 정확성.*민감정보 미포함 여부.*심각도 최종 판정/);

  await page.check('#finalReviewConfirm');
  await expect(completeBtn).toBeEnabled();
});
