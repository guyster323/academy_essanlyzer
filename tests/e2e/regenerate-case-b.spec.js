/**
 * Case B report regeneration — drives the REAL pipeline (no API mocking).
 *
 * This is not a test: it is a repeatable way to re-publish
 * Report/case_b_report.html through the actual UI, including the human-review
 * checkpoint. It is skipped unless RUN_CASE_B=1 so `npm run test:e2e` stays
 * fast; a real run makes three live Claude CLI calls and takes 30-90 minutes.
 *
 *   RUN_CASE_B=1 npx playwright test tests/e2e/regenerate-case-b.spec.js \
 *     --project=desktop-chromium
 *
 * Requires Log_sample/extracted/data_sys_6_stride80.csv (gitignored) and a
 * generous CLAUDE_CLI_TIMEOUT_MS on the API server.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const STRIDE80 = path.resolve('Log_sample/extracted/data_sys_6_stride80.csv');
const OUT_DIR = path.resolve('tmp/case-b-regen');
const CS_TEXT = [
  '2018년 가동 이후 공개 LFP System 6 필드 로그에서 셀 전압 편차와 저항 이벤트 점검 요청.',
  '데이터는 2018-04부터 2022-01까지이며, 특정 구간이 아니라 전 기간의 거동을 확인해 주세요.',
  'GP 및 BattGP 신호는 이번 로그에 없습니다.'
].join(' ');

// A single live stage has been measured at 707-1140s; allow generous headroom
// so a slow-but-healthy call is never cut off mid-flight.
const STAGE_MS = 90 * 60 * 1000;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Waits for a live stage to land, but gives up the moment the app renders its
 * error box instead. Without this a stage failure (a CLI 504, or the account
 * hitting its spend limit) would sit on the full STAGE_MS timeout even though
 * the page already knows it failed — one such run burned 90 minutes waiting
 * on a result that had errored out seconds in.
 */
async function waitForStage(page, successLocator, label) {
  const errorBox = page.locator('.error-box');
  const outcome = await Promise.race([
    successLocator.waitFor({ state: 'visible', timeout: STAGE_MS }).then(() => 'ok'),
    errorBox.waitFor({ state: 'visible', timeout: STAGE_MS }).then(() => 'error')
  ]);
  if (outcome === 'error') {
    const msg = (await errorBox.innerText()).replace(/\s+/g, ' ').trim();
    throw new Error(`${label} failed in the app: ${msg}`);
  }
  log(`${label} done`);
}

test('regenerate the Case B executive report through the real pipeline', async ({ page }, testInfo) => {
  test.skip(process.env.RUN_CASE_B !== '1', 'set RUN_CASE_B=1 to run the live regeneration');
  test.skip(testInfo.project.name === 'mobile-chromium', 'desktop-scoped');
  test.skip(!fs.existsSync(STRIDE80), 'Log_sample/extracted/data_sys_6_stride80.csv is not in this checkout');
  test.setTimeout(4 * STAGE_MS);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto('/');
  await page.fill('#inputCsText', CS_TEXT);
  await page.check('#sensitiveConfirm');
  await page.setInputFiles('#csvFileInput', STRIDE80);

  log('streaming stride80...');
  await expect(page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ })).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ }).click();
  await expect(page.locator('.source-sub').first()).toContainText(/240,603행|240603행/, { timeout: 300_000 });
  log('stream done');

  const coverage = page.locator('.time-coverage').first();
  if (await coverage.count()) {
    log(`time coverage: ${(await coverage.innerText()).replace(/\s+/g, ' ')}`);
  }

  // STEP 2 — live detect-anomaly
  log('detect-anomaly (live)...');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  await waitForStage(page, page.getByRole('button', { name: /원인 가설 생성/ }), 'detect-anomaly');
  await page.screenshot({ path: path.join(OUT_DIR, 'step2-anomaly.png'), fullPage: true });

  // STEP 3 — live generate-hypotheses
  log('generate-hypotheses (live)...');
  await page.getByRole('button', { name: /원인 가설 생성/ }).click();
  await waitForStage(page, page.locator('.hyp-radio').first(), 'generate-hypotheses');

  // STEP 4 — human review. Pick the best-supported hypothesis, then confirm
  // severity. Playwright drives the native <select> directly, which the
  // desktop-automation route could not do reliably.
  const hypCount = await page.locator('.hyp-radio').count();
  log(`hypotheses offered: ${hypCount}`);
  const names = await page.locator('.hyp-name').allInnerTexts();
  names.forEach((n, i) => log(`  [${i}] ${n}`));

  await page.locator('.hyp-radio').first().check();
  await page.selectOption('#sevSelect', '상');
  await page.fill('#sevReasonInput',
    '전 기간(2018-04~2022-01) 시간 버킷 전부에서 Cell 8이 최상위 이상 셀로 유지되고, ' +
    '2021년 이후 이상 밀도가 급격히 증가해 열화 진행이 의심되므로 현장 점검 우선순위 상향이 필요함.');
  await page.screenshot({ path: path.join(OUT_DIR, 'step4-review.png'), fullPage: true });

  // STEP 5 — live draft-report
  log('draft-report (live)...');
  await page.getByRole('button', { name: /가설·심각도 확정 → 보고서 생성/ }).click();
  await waitForStage(page, page.getByRole('button', { name: /HTML로 저장/ }), 'draft-report');
  await page.screenshot({ path: path.join(OUT_DIR, 'step5-report.png'), fullPage: true });

  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: /HTML로 저장/ }).click();
  const download = await downloadPromise;
  const saved = path.join(OUT_DIR, 'case_b_report.html');
  await download.saveAs(saved);
  const bytes = fs.statSync(saved).size;
  log(`saved ${saved} (${bytes} bytes)`);

  expect(bytes).toBeGreaterThan(50_000);
  expect(pageErrors, `pageerrors: ${pageErrors.join(' | ')}`).toEqual([]);
});
