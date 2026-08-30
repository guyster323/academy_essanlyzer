/**
 * Manual demo capture. Skipped unless RECORD_DEMO=1 so the default e2e
 * suite still fails fast. Records a 1280x720 webm of the Case B UI
 * (conflict banner, omission notices, human-review checkpoint).
 *
 *   $env:RECORD_DEMO=1; $env:PW_PORT=5183; npx playwright test tests/e2e/record-demo-case-b.spec.js --project=desktop-chromium
 *
 * API calls are mocked — this is a UI walkthrough with waits cut, not a
 * live 30-minute Claude run. Captions/overlays must say so.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const STRIDE80 = path.resolve('Log_sample/extracted/data_sys_6_stride80.csv');
const CS_TEXT = '공개 LFP System 6 로그의 셀 전압 편차와 저항 이벤트를 확인해 주세요.';
const HOLD_MS = 1800;

const MOCK_ANOMALY = {
  issueStructured: {
    issueType: '셀 전압 편차 및 저항 이벤트 점검',
    facility: '공개 LFP System 6',
    occurredAt: '2018-04 ~ 2018-12',
    priorHistory: '없음'
  },
  anomalyWindows: [{
    timestamp: '2018-11-24', sourceFile: 'data_sys_6_stride80.csv', parameter: 'maxAbsVdev',
    observedValue: 'Cell 8 Vdev 상승', normalRange: '|robust z| <= 3', deviation: 'z>3',
    alarmCode: 'cross-cell Vdev anomaly', level: '고', evidenceTier: 'Derived'
  }],
  truncation: { droppedAnomalyWindows: 4, kept: 16 }
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

const MOCK_REPORT = {
  report: {
    headline: '전압 잔차는 Cell 8을, 이벤트 저항은 Cell 5를 가리키며 앱은 한쪽을 채택하지 않는다',
    occurrence: '공개 LFP System 6 로그 구간에서 파생 이상이 반복 관측됐다.',
    anomalySummary: 'Vdev 파생 이상은 Cell 8에 편중되고, 이벤트 저항은 Cell 5 경로를 가리킨다.',
    rootCause: '현재 데이터가 입증하는 범위는 Cell 경로의 유효 직렬저항 증가 후보다. 어느 셀인지는 두 지표가 상충한다.',
    actionRecommendation: '근본원인 셀 확정은 보류하고 두 지표를 모두 엔지니어가 본다.',
    provenBox: '파생 이상 행과 이벤트 저항 집계는 관측·파생 사실이다.',
    suggestedBox: '유효 직렬저항 증가 후보는 Inferred이다.',
    unknownBox: '전기화학적 열화·커넥터·부식은 확정할 수 없다.',
    independentFindings: ['전압 잔차와 이벤트 저항이 다른 셀을 지목한다'],
    ftaLeaves: [{ branch: 'Electrical Path', disposition: 'Possible', evidenceIds: ['E001'] }],
    evidenceCitations: [{ field: 'headline', evidenceIds: ['E001'], figureIds: ['B-F1'] }],
    managementImplications: ['셀 확정을 보류한다']
  },
  email: { to: 'CS', subject: 'System 6 분석 초안', body: '근거 상충이 있어 셀을 확정하지 않았습니다.' }
};

test.use({
  video: {
    mode: 'on',
    size: { width: 1280, height: 720 }
  },
  viewport: { width: 1280, height: 720 }
});

test('record Case B demo walkthrough', async ({ page }, testInfo) => {
  test.skip(!process.env.RECORD_DEMO, 'set RECORD_DEMO=1 to re-record demo assets');
  test.skip(testInfo.project.name === 'mobile-chromium', 'demo recording is desktop-scoped');
  test.skip(!fs.existsSync(STRIDE80), 'Log_sample/extracted/data_sys_6_stride80.csv is not in this checkout');
  test.setTimeout(240_000);

  await page.route('**/api/detect-issues', route => route.fulfill({ json: { issues: [] } }));
  await page.route('**/api/detect-anomaly', route => route.fulfill({ json: MOCK_ANOMALY }));
  await page.route('**/api/generate-hypotheses', route => route.fulfill({ json: MOCK_HYPOTHESES }));
  await page.route('**/api/draft-report', route => route.fulfill({ json: MOCK_REPORT }));

  await page.goto('/');
  await page.fill('#inputCsText', CS_TEXT);
  await page.check('#sensitiveConfirm');
  await page.setInputFiles('#csvFileInput', STRIDE80);
  await expect(page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ }).click();
  await expect(page.locator('.source-sub').first()).toContainText(/240,603행|240603행/, { timeout: 120_000 });
  await expect(page.locator('.source-sub').first()).toContainText(/저항 이벤트/);
  await page.locator('.source-sub').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(HOLD_MS);

  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  const step2Banner = page.locator('.attribution-conflict-banner');
  await expect(step2Banner).toBeVisible({ timeout: 60_000 });
  await expect(step2Banner).toContainText('Cell 8');
  await expect(step2Banner).toContainText('Cell 5');
  await expect(page.locator('.skipped-note')).toBeVisible();
  await expect(page.locator('.skipped-note')).toContainText(/이상 구간/);
  await step2Banner.scrollIntoViewIfNeeded();
  await page.waitForTimeout(HOLD_MS);
  await page.locator('.skipped-note').scrollIntoViewIfNeeded();
  await page.waitForTimeout(HOLD_MS);

  await page.getByRole('button', { name: /원인 가설 생성/ }).click();
  await expect(page.locator('.hyp-card')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('.checkpoint-banner')).toBeVisible();
  await expect(page.locator('.attribution-conflict-banner')).toBeVisible();
  await page.locator('.checkpoint-banner').scrollIntoViewIfNeeded();
  await page.waitForTimeout(HOLD_MS);
  await page.locator('.attribution-conflict-banner').scrollIntoViewIfNeeded();
  await page.waitForTimeout(HOLD_MS);

  await page.locator('.hyp-card').first().locator('input[name="hypSelect"]').check();
  await page.locator('#sevSelect').selectOption('상');
  await page.locator('#sevReasonInput').fill('두 지표가 다른 셀을 가리키므로 엔지니어가 심각도를 확정한다.');
  await page.waitForTimeout(HOLD_MS);
  await page.getByRole('button', { name: /확정.*보고서 생성/ }).click();
  await expect(page.locator('.headline-text')).toBeVisible({ timeout: 30_000 });
  await page.locator('.headline-text').scrollIntoViewIfNeeded();
  await page.waitForTimeout(HOLD_MS * 2);
});
