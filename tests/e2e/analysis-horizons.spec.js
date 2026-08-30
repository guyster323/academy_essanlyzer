import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const STRIDE80 = path.resolve('Log_sample/extracted/data_sys_6_stride80.csv');
const CS_TEXT = '공개 LFP System 6 로그의 셀 전압 편차와 저항 이벤트를 확인해 주세요. 시간 커버리지를 포함해 분석해 주세요.';

const MOCK_ANOMALY = {
  issueStructured: { issueType: '셀 전압 편차', facility: 'System 6', occurredAt: '2018-2021', priorHistory: '없음' },
  anomalyWindows: [{
    timestamp: '2018-11-24', sourceFile: 'data_sys_6_stride80.csv', parameter: 'maxAbsVdev',
    observedValue: 'Cell 8 Vdev 상승', normalRange: '|robust z| <= 3', deviation: 'z>3',
    alarmCode: 'cross-cell Vdev anomaly', level: '고', evidenceTier: 'Derived'
  }]
};

test('stride80 time coverage, alarm span, and outlierCell-over-time are visible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', '36MB stride80 stream is desktop-scoped');
  test.skip(!fs.existsSync(STRIDE80), 'Log_sample/extracted/data_sys_6_stride80.csv is not in this checkout');
  test.setTimeout(180_000);

  let capturedPrompt = '';
  let capturedProfiles = null;
  await page.route('**/api/detect-issues', route => route.fulfill({ json: { issues: [] } }));
  await page.route('**/api/detect-anomaly', async route => {
    const body = route.request().postDataJSON() || {};
    capturedPrompt = body.combinedLogText || '';
    capturedProfiles = body.sourceProfiles || null;
    await route.fulfill({ json: MOCK_ANOMALY });
  });

  await page.goto('/');
  await page.fill('#inputCsText', CS_TEXT);
  await page.check('#sensitiveConfirm');
  await page.setInputFiles('#csvFileInput', STRIDE80);
  await expect(page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ }).click();
  await expect(page.locator('.source-sub').first()).toContainText(/240,603행|240603행/, { timeout: 120_000 });

  const coverage = page.locator('.time-coverage').first();
  await expect(coverage).toBeVisible();
  await expect(coverage).toContainText('데이터 구간');
  await expect(coverage).toContainText('알람 근거 구간');
  const coverageText = await coverage.innerText();
  expect(coverageText).toMatch(/2018/);
  expect(coverageText).toMatch(/2021|2020|2019/);

  const dist = page.locator('[data-alarm-time-dist]').first();
  await expect(dist).toBeVisible();
  const distText = await dist.innerText();
  expect(distText).toMatch(/2018/);
  expect(distText).toMatch(/2019|2020|2021/);

  const category = page.locator('[data-category-time="outlierCell"]').first();
  await expect(category).toBeVisible();
  await expect(category).toContainText('Cell');

  await coverage.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'Report/analysis-horizons-intake.png', fullPage: false });
  await coverage.screenshot({ path: 'Report/analysis-horizons-coverage-card.png' });
  if (await category.count()) {
    await category.screenshot({ path: 'Report/analysis-horizons-outlier-over-time.png' });
  }

  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  await expect.poll(() => capturedPrompt.length, { timeout: 60_000 }).toBeGreaterThan(100);
  expect(capturedPrompt).toMatch(/데이터 시간 범위/);
  expect(capturedPrompt).toMatch(/알람 근거 시간 범위/);
  expect(capturedProfiles?.[0]?.dataTimeRange?.min).toBeTruthy();
  expect(capturedProfiles?.[0]?.evidenceTimeRange?.max).toBeTruthy();
  const evidenceMin = capturedProfiles[0].evidenceTimeRange.min || '';
  const evidenceMax = capturedProfiles[0].evidenceTimeRange.max || '';
  expect(evidenceMin).toMatch(/2018|2019/);
  expect(evidenceMax).toMatch(/2019|2020|2021|2022/);
  fs.writeFileSync(
    'Report/analysis-horizons-prompt-excerpt.txt',
    [
      '--- sourceProfiles ---',
      JSON.stringify(capturedProfiles, null, 2),
      '',
      '--- combinedLogText head ---',
      capturedPrompt.slice(0, 4000)
    ].join('\n')
  );

  const panel = page.locator('[data-time-coverage-panel]');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel).toContainText('데이터');
  await expect(panel).toContainText('알람 근거');
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'Report/analysis-horizons-anomaly.png', fullPage: false });
  await panel.screenshot({ path: 'Report/analysis-horizons-anomaly-panel.png' });
});
