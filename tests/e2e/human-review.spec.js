import { test, expect } from '@playwright/test';

const CSV_TEXT = `timestamp,voltage_V,alarm_code
2024-06-03 10:29:10,3.58,0
2024-06-03 10:32:11,3.91,OV001`;

const MOCK_ANOMALY = {
  issueStructured: { issueType: '과전압', facility: '랙 #3', occurredAt: '2024-06-03 10:32', priorHistory: '없음' },
  anomalyWindows: [{ timestamp: '2024-06-03 10:32:11', sourceFile: '붙여넣기', parameter: 'voltage_V', observedValue: '3.91', normalRange: '3.0-3.7', deviation: '+0.21', alarmCode: 'OV001', level: '고' }]
};

const MOCK_HYPOTHESES = {
  hypotheses: [
    {
      id: 'H1', name: 'BMS 셀 밸런싱 오작동', domain: 'Battery/BMS',
      expectedSignature: '셀 간 전압 편차 확대', actualObservation: '3.91V까지 상승',
      evidence: 'OV001 발생 직전 급상승', confidence: 'High', severityDraft: '상', severityReason: '즉시 차단 발생'
    },
    {
      id: 'H2', name: 'PCS 전압 제어 오차', domain: 'PCS',
      expectedSignature: 'PCS 출력 전압 불안정', actualObservation: '단일 셀만 상승',
      evidence: '타 셀은 정상 범위', confidence: 'Low', severityDraft: '중', severityReason: '재현성 낮음'
    }
  ]
};

const MOCK_REPORT = {
  report: { headline: 'h', occurrence: 'o', anomalySummary: 'a', rootCause: 'r', actionRecommendation: 'ar' },
  email: { to: 'CS', subject: 's', body: 'b' }
};

async function mockAndReachHypothesisView(page) {
  await page.route('**/api/detect-anomaly', route => route.fulfill({ json: MOCK_ANOMALY }));
  await page.route('**/api/generate-hypotheses', route => route.fulfill({ json: MOCK_HYPOTHESES }));

  await page.goto('/');
  await page.fill('#inputCsText', '2024년 6월 3일 현장 ESS 랙 #3에서 과전압 경보 발생. 오전 10시 32분경 BMS 알람 후 자동 차단됨.');
  await page.fill('#inputCsv', CSV_TEXT);
  await page.check('#sensitiveConfirm');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  await page.getByRole('button', { name: /원인 가설 생성/ }).click();
  await expect(page.locator('.hyp-card')).toHaveCount(2);
}

test('zero anomaly windows blocks hypothesis generation with the fixed "추가 확인 필요" message', async ({ page }) => {
  await page.route('**/api/detect-anomaly', route => route.fulfill({
    json: {
      issueStructured: { issueType: '미상', facility: '미상', occurredAt: '미상', priorHistory: '없음' },
      anomalyWindows: []
    }
  }));

  await page.goto('/');
  await page.fill('#inputCsText', '2024년 6월 3일 현장 ESS 랙 #3에서 과전압 경보 발생. 오전 10시 32분경 BMS 알람 후 자동 차단됨.');
  await page.fill('#inputCsv', CSV_TEXT);
  await page.check('#sensitiveConfirm');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();

  await expect(page.getByText('판단 불가 — 추가 확인 필요: 로그 범위, 임계값, 관련 PCS/EMS 로그를 확인하세요.')).toBeVisible();
  await expect(page.getByRole('button', { name: /원인 가설 생성/ })).toBeDisabled();
});

test('no hypothesis/severity is pre-selected, report button starts disabled', async ({ page }) => {
  await mockAndReachHypothesisView(page);

  await expect(page.locator('input[name="hypSelect"]:checked')).toHaveCount(0);
  await expect(page.locator('#sevSelect')).toHaveValue('');
  await expect(page.getByRole('button', { name: /확정.*보고서 생성/ })).toBeDisabled();
});

test('selecting a hypothesis populates an editable draft but leaves report disabled until severity+reason are set', async ({ page }) => {
  await mockAndReachHypothesisView(page);

  await page.locator('.hyp-card').first().locator('input[name="hypSelect"]').check();
  const confirmBtn = page.getByRole('button', { name: /확정.*보고서 생성/ });
  await expect(confirmBtn).toBeDisabled(); // severity/reason still unset

  await page.locator('#confirmedHypName').fill('BMS 셀 밸런싱 오작동 (수정됨)');
  await page.locator('#sevSelect').selectOption('상');
  await page.locator('#sevReasonInput').fill('즉시 차단 + 재발 이력 있음');

  await expect(confirmBtn).toBeEnabled();
});

test('edited hypothesis and explicit severity reach the draft-report request body', async ({ page }) => {
  await mockAndReachHypothesisView(page);
  let capturedBody = null;
  await page.route('**/api/draft-report', async route => {
    capturedBody = route.request().postDataJSON();
    await route.fulfill({ json: MOCK_REPORT });
  });

  await page.locator('.hyp-card').nth(1).locator('input[name="hypSelect"]').check();
  await page.locator('#confirmedHypName').fill('PCS 전압 제어 오차 (엔지니어 확정)');
  await page.locator('#sevSelect').selectOption('중');
  await page.locator('#sevReasonInput').fill('단일 셀 이상, 재현성 낮음');
  await page.getByRole('button', { name: /확정.*보고서 생성/ }).click();

  await expect(page.locator('.headline-text')).toBeVisible();
  expect(capturedBody).not.toBeNull();
  expect(capturedBody.confirmedHyp.name).toBe('PCS 전압 제어 오차 (엔지니어 확정)');
  expect(capturedBody.finalSeverity).toBe('중');
  expect(capturedBody.finalSeverityReason).toBe('단일 셀 이상, 재현성 낮음');
});

test('regenerating hypotheses clears any prior selection', async ({ page }) => {
  await mockAndReachHypothesisView(page);
  await page.locator('.hyp-card').first().locator('input[name="hypSelect"]').check();
  await expect(page.locator('input[name="hypSelect"]:checked')).toHaveCount(1);

  await page.getByRole('button', { name: /가설 다시 생성/ }).click();
  await expect(page.locator('.hyp-card')).toHaveCount(2);
  await expect(page.locator('input[name="hypSelect"]:checked')).toHaveCount(0);
  await expect(page.locator('#sevSelect')).toHaveValue('');
});
