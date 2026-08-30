import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const STRIDE80 = path.resolve('Log_sample/extracted/data_sys_6_stride80.csv');
const CS_TEXT = '공개 LFP System 6 로그의 셀 전압 편차와 저항 이벤트를 확인해 주세요.';

const MOCK_ANOMALY = {
  issueStructured: { issueType: '셀 전압 편차', facility: 'System 6', occurredAt: '2014-2019', priorHistory: '없음' },
  anomalyWindows: [{
    timestamp: '2018-11-24', sourceFile: 'data_sys_6_stride80.csv', parameter: 'maxAbsVdev',
    observedValue: 'Cell 8 Vdev 상승', normalRange: '|robust z| <= 3', deviation: 'z>3',
    alarmCode: 'cross-cell Vdev anomaly', level: '고', evidenceTier: 'Derived'
  }]
};

const MOCK_HYPOTHESES = {
  hypotheses: [
    {
      id: 'H1', name: 'Cell 경로 유효 직렬저항 증가 후보', domain: 'Electrical Path',
      expectedSignature: '전류 방향에 연동된 전압 편차', actualObservation: '파생 이상 다수',
      evidence: 'Vdev와 이벤트 저항이 셀을 달리 지목', confidence: 'Medium', severityDraft: '상',
      severityReason: '엔지니어 판단 필요', evidenceTier: 'Inferred',
      disconfirmingEvidence: '두 지표가 같은 셀을 지목하면 약화',
      missingSignals: '물리 검사 없음', claimLimit: '유효 직렬저항 증가 수준까지'
    },
    {
      id: 'H2', name: '운영점 편향 후보', domain: 'Operating Condition',
      expectedSignature: '특정 SOC/I 구간에서만 편차', actualObservation: '일부 구간 편차',
      evidence: '매칭 drop이 큼', confidence: 'Low', severityDraft: '중',
      severityReason: '근거 제한', evidenceTier: 'Inferred',
      disconfirmingEvidence: '전 구간 지속이면 약화',
      missingSignals: '열전대 로그 없음', claimLimit: '운영점 가설은 미확정'
    }
  ]
};

const GENERIC_CSV = `timestamp,voltage_V,alarm_code
2024-06-03 10:29:10,3.58,0
2024-06-03 10:30:10,3.60,0
2024-06-03 10:31:10,3.70,0
2024-06-03 10:32:11,3.91,OV001`;

test('stride80 shows Cell 8 vs Cell 5 conflict on Step 2 and Step 4 without gating radios', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', '36MB stride80 stream is desktop-scoped');
  test.skip(!fs.existsSync(STRIDE80), 'Log_sample/extracted/data_sys_6_stride80.csv is not in this checkout');
  test.setTimeout(180_000);

  await page.route('**/api/detect-issues', route => route.fulfill({ json: { issues: [] } }));
  await page.route('**/api/detect-anomaly', route => route.fulfill({ json: MOCK_ANOMALY }));
  await page.route('**/api/generate-hypotheses', route => route.fulfill({ json: MOCK_HYPOTHESES }));

  await page.goto('/');
  await page.fill('#inputCsText', CS_TEXT);
  await page.check('#sensitiveConfirm');
  await page.setInputFiles('#csvFileInput', STRIDE80);
  await expect(page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ }).click();
  await expect(page.locator('.source-sub').first()).toContainText(/240,603행|240603행/, { timeout: 120_000 });

  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  const step2Banner = page.locator('.attribution-conflict-banner');
  await expect(step2Banner).toBeVisible({ timeout: 60_000 });
  await expect(step2Banner).toContainText('Cell 8');
  await expect(step2Banner).toContainText('Cell 5');
  await expect(step2Banner).toContainText('전압 잔차');
  await expect(step2Banner).toContainText('이벤트 저항');
  await expect(step2Banner).toContainText('앱은 어느 쪽이 맞다고 판정하지 않습니다');
  await step2Banner.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'Report/evidence-conflict-step2.png', fullPage: false });
  await step2Banner.screenshot({ path: 'Report/evidence-conflict-step2-banner.png' });

  await page.getByRole('button', { name: /원인 가설 생성/ }).click();
  await expect(page.locator('.hyp-card')).toHaveCount(2, { timeout: 30_000 });
  const step4Banner = page.locator('.attribution-conflict-banner');
  await expect(step4Banner).toBeVisible();
  await expect(step4Banner).toContainText('Cell 8');
  await expect(step4Banner).toContainText('Cell 5');
  await expect(page.locator('.checkpoint-banner')).toBeVisible();
  const bannerBox = await step4Banner.boundingBox();
  const firstRadio = page.locator('input[name="hypSelect"]').first();
  const radioBox = await firstRadio.boundingBox();
  expect(bannerBox, 'conflict banner should sit above hypothesis radios').not.toBeNull();
  expect(radioBox).not.toBeNull();
  expect(bannerBox.y + bannerBox.height).toBeLessThan(radioBox.y + 1);
  await expect(firstRadio).toBeEnabled();
  await expect(page.locator('input[name="hypSelect"]:checked')).toHaveCount(0);
  await firstRadio.check();
  await expect(firstRadio).toBeChecked();
  await page.locator('.checkpoint-banner').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'Report/evidence-conflict-step4.png', fullPage: false });
  await step4Banner.screenshot({ path: 'Report/evidence-conflict-step4-banner.png' });
});

test('generic CSV with no LFP conflict does not show the conflict banner', async ({ page }) => {
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
  await page.route('**/api/generate-hypotheses', route => route.fulfill({ json: MOCK_HYPOTHESES }));

  await page.goto('/');
  await page.fill('#inputCsText', CS_TEXT);
  await page.fill('#inputCsv', GENERIC_CSV);
  await page.check('#sensitiveConfirm');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  await expect(page.locator('#figure-F-generic-1')).toBeVisible();
  await expect(page.locator('.attribution-conflict-banner')).toHaveCount(0);
  await page.screenshot({ path: 'Report/evidence-conflict-no-false-positive.png', fullPage: false });

  await page.getByRole('button', { name: /원인 가설 생성/ }).click();
  await expect(page.locator('.hyp-card')).toHaveCount(2);
  await expect(page.locator('.attribution-conflict-banner')).toHaveCount(0);
});
