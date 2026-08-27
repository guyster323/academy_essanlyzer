import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CSV_TEXT = `timestamp,voltage_V,alarm_code
2024-06-03 10:29:10,3.58,0
2024-06-03 10:32:11,3.91,OV001`;

const VALID_CS_TEXT = '2024년 6월 3일 현장 ESS 랙 #3에서 과전압 경보 발생. 오전 10시 32분경 BMS 알람 후 자동 차단됨.';

async function trackApiCalls(page) {
  const calls = [];
  page.on('request', (req) => { if (req.url().includes('/api/')) calls.push(req.url()); });
  return calls;
}

test('submitting without checking the sensitive-data confirmation checkbox is blocked, no API call fires', async ({ page }) => {
  const apiCalls = await trackApiCalls(page);
  await page.goto('/');
  await page.fill('#inputCsText', VALID_CS_TEXT);
  await page.fill('#inputCsv', CSV_TEXT);
  // deliberately not checking #sensitiveConfirm
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();

  await expect(page.getByText(/고객명.*사이트 위치.*실 설비 식별자.*개인정보를 제거했음을 확인/)).toBeVisible();
  await expect(page.locator('#viewRoot .panel').first()).toBeVisible(); // still on intake, not navigated away
  expect(apiCalls).toEqual([]);
});

test('an obvious PII pattern (email address) in the CS text blocks submission even with the checkbox checked', async ({ page }) => {
  const apiCalls = await trackApiCalls(page);
  await page.goto('/');
  await page.fill('#inputCsText', VALID_CS_TEXT + ' 담당자 연락처: engineer@example.com');
  await page.fill('#inputCsv', CSV_TEXT);
  await page.check('#sensitiveConfirm');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();

  await expect(page.getByText(/민감정보로 의심되는 패턴이 감지/)).toBeVisible();
  await expect(page.getByText(/이메일 주소/)).toBeVisible();
  expect(apiCalls).toEqual([]);
});

test('an uploaded HTML reference doc is extracted client-side, listed in the UI, and reaches the generate-hypotheses request body labeled by filename', async ({ page }) => {
  await page.route('**/api/detect-anomaly', route => route.fulfill({
    json: {
      issueStructured: { issueType: '과전압', facility: '랙 #3', occurredAt: '2024-06-03 10:32', priorHistory: '없음' },
      anomalyWindows: [{ timestamp: '2024-06-03 10:32:11', sourceFile: '붙여넣기', parameter: 'voltage_V', observedValue: '3.91', normalRange: '3.0-3.7', deviation: '+0.21', alarmCode: 'OV001', level: '고' }]
    }
  }));
  let hypothesesBody = null;
  await page.route('**/api/generate-hypotheses', async (route) => {
    hypothesesBody = route.request().postDataJSON();
    await route.fulfill({ json: { hypotheses: [{ id: 'H1', name: 'n', domain: 'PCS', expectedSignature: 'e', actualObservation: 'a', evidence: 'ev', confidence: 'High', severityDraft: '상', severityReason: 'r' }] } });
  });

  await page.goto('/');
  await page.setInputFiles('#refDocInput', path.join(__dirname, 'fixtures', 'reference-case-01.html'));
  await expect(page.getByText('reference-case-01.html')).toBeVisible();

  await page.fill('#inputCsText', VALID_CS_TEXT);
  await page.fill('#inputCsv', CSV_TEXT);
  await page.check('#sensitiveConfirm');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  await page.getByRole('button', { name: /원인 가설 생성/ }).click();
  await expect(page.locator('.hyp-card')).toHaveCount(1);

  expect(hypothesesBody.referenceDocsText).toContain('[참고 파일: reference-case-01.html]');
  expect(hypothesesBody.referenceDocsText).toContain('셀 밸런싱 로직 오작동');
  expect(hypothesesBody.referenceDocsText).not.toContain('should be stripped'); // <script> content excluded
});

test('clean input with the checkbox checked proceeds normally', async ({ page }) => {
  await page.route('**/api/detect-anomaly', route => route.fulfill({
    json: {
      issueStructured: { issueType: '과전압', facility: '랙 #3', occurredAt: '2024-06-03 10:32', priorHistory: '없음' },
      anomalyWindows: [{ timestamp: '2024-06-03 10:32:11', sourceFile: '붙여넣기', parameter: 'voltage_V', observedValue: '3.91', normalRange: '3.0-3.7', deviation: '+0.21', alarmCode: 'OV001', level: '고' }]
    }
  }));
  await page.goto('/');
  await page.fill('#inputCsText', VALID_CS_TEXT);
  await page.fill('#inputCsv', CSV_TEXT);
  await page.check('#sensitiveConfirm');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();

  await expect(page.locator('table')).toBeVisible();
});
