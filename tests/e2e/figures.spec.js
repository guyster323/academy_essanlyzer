import { test, expect } from '@playwright/test';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', 'Figure canvas assertions are desktop-scoped');
});

const CSV_TEXT = `timestamp,voltage_V,alarm_code
2024-06-03 10:29:10,3.58,0
2024-06-03 10:30:10,3.60,0
2024-06-03 10:31:10,3.70,0
2024-06-03 10:32:11,3.91,OV001`;

test('anomaly view renders a generic time-series figure for pasted CSV', async ({ page }) => {
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

  await page.goto('/');
  await page.fill('#inputCsText', '2024년 6월 3일 현장 ESS 랙 #3에서 과전압 경보 발생. 오전 10시 32분경 BMS 알람 후 자동 차단됨.');
  await page.fill('#inputCsv', CSV_TEXT);
  await page.check('#sensitiveConfirm');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();

  await expect(page.locator('#figure-F-generic-1')).toBeVisible();
  await expect(page.locator('canvas[data-figure-id="F-generic-1"]')).toBeVisible();
  const n = await page.locator('canvas[data-figure-id="F-generic-1"]').evaluate(c => c.width);
  expect(n).toBeGreaterThan(100);
});
