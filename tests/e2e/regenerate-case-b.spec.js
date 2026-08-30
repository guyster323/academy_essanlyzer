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
 * Full-resolution variant (T1+T2 of Report/full-resolution-and-comparison-plan.md):
 *   RUN_CASE_B_FULLRES=1 PW_PORT=5185 npx playwright test tests/e2e/regenerate-case-b.spec.js \
 *     --project=desktop-chromium --grep "full-resolution"
 *
 * Requires the API server on :3001, Log_sample/case_b_field_data.zip, and a
 * generous CLAUDE_CLI_TIMEOUT_MS. Do not set RUN_CASE_B and RUN_CASE_B_FULLRES
 * together — both consume the same Claude quota.
 *
 * This file never overwrites Report/case_b_report.html.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test.describe.configure({ mode: 'serial' });

const STRIDE80 = path.resolve('Log_sample/extracted/data_sys_6_stride80.csv');
const FULLRES_ZIP = path.resolve('Log_sample/case_b_field_data.zip');
const OUT_DIR = path.resolve('tmp/case-b-regen');
const FULLRES_DIR = path.resolve('tmp/fullres');
const REPORT_DIR = path.resolve('Report');
const CS_TEXT = [
  '2018년 가동 이후 공개 LFP System 6 필드 로그에서 셀 전압 편차와 저항 이벤트 점검 요청.',
  '데이터는 2018-04부터 2022-01까지이며, 특정 구간이 아니라 전 기간의 거동을 확인해 주세요.',
  'GP 및 BattGP 신호는 이번 로그에 없습니다.'
].join(' ');

// Paper-reported values from Log_sample/ESS_Public_Log_Analysis_Strategy_WDBESS1_LFP.md §13.
// Pasted into the UI after independent analysis. Not used as thresholds in code.
const PUBLISHED_EXCERPT = [
  '논문이 보고한 값 (독립 분석 후 validation reference로만 사용한다):',
  'Equivalent Full Cycles: 약 1,446.',
  'Max age: 약 1,352 days.',
  'Cell 8 resistance가 다른 cell보다 높음.',
  '약 3년 이후 resistance knee.',
  'Cell 8 fault probability는 약 500일 이후 증가.',
  '약 800일 직전 0.5 초과.'
].join('\n');

// A single live stage has been measured at 707-1140s; allow generous headroom
// so a slow-but-healthy call is never cut off mid-flight. Full-res CLI timeout
// is raised locally to 90 min; keep the wait at least that long.
const STAGE_MS = 100 * 60 * 1000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(FULLRES_DIR, { recursive: true });
    fs.appendFileSync(path.join(FULLRES_DIR, 'progress.log'), line + '\n');
  } catch {
    // progress log is best-effort
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  log(`wrote ${filePath}`);
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
  test.skip(process.env.RUN_CASE_B_FULLRES === '1', 'full-res run occupies the Claude quota');
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

function sys6FromState() {
  return () => {
    const sources = window.state.logSources || [];
    const src = sources.find(s => /(?:^|\/)data_sys_6\.csv$/.test(s.path || s.name || ''));
    const derivedAlarmCount = src && src.groups
      ? Object.values(src.groups).reduce((sum, g) => sum + (g.derived?.alarmCount || 0), 0)
      : (src?.derived?.alarmCount || 0);
    return {
      zipScanning: window.state.zipScanning,
      skipped: window.state.zipSkipped || [],
      sourceCount: sources.length,
      paths: sources.map(s => s.path),
      src: src && {
        id: src.id,
        path: src.path,
        name: src.name,
        status: src.status,
        selected: src.selected,
        errorMsg: src.errorMsg || '',
        formatId: src.format && src.format.id,
        formatLabel: src.format && src.format.label,
        sizeBytes: src.sizeBytes,
        sizeLabel: src.sizeLabel,
        processedBytes: src.processedBytes,
        rowCount: src.rowCount,
        alarmCount: src.alarmCount,
        derivedAlarmCount,
        droppedResistanceEvents: src.droppedResistanceEvents,
        resistanceEventYearCounts: src.resistanceEventYearCounts,
        resistanceEventTimeDistribution: src.resistanceEventTimeDistribution,
        alarmDroppedCount: src.alarmDroppedCount,
        malformedRowCount: src.malformedRowCount,
        dataTimeRange: src.dataTimeRange,
        evidenceTimeRange: src.evidenceTimeRange,
        timeCoverageRatio: src.timeCoverageRatio,
        outlierCell: src.derived && src.derived.categoryCounts && src.derived.categoryCounts.outlierCell,
        categoryTimeBuckets: src.derived && src.derived.categoryTimeBuckets,
        eventEntityKeys: Object.keys(src.resistanceEventsByEntity || {}),
        eventCountsByEntity: Object.fromEntries(
          Object.entries(src.resistanceEventsByEntity || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
        )
      }
    };
  };
}

function compactFigures() {
  return () => {
    const figures = window.state.figureSpecs || [];
    return figures.map(f => ({
      id: f.id,
      claim: f.claim,
      available: Boolean(f.available),
      unavailableReason: f.unavailableReason || null,
      evidenceTier: f.evidenceTier || null,
      summaryStats: f.summaryStats || {},
      seriesPointCounts: (f.series || []).map(s => ({ name: s.name, n: (s.t || []).length }))
    }));
  };
}

test('full-resolution Case B stream, conflict check, and published comparison', async ({ page }, testInfo) => {
  test.skip(process.env.RUN_CASE_B_FULLRES !== '1', 'set RUN_CASE_B_FULLRES=1 to run the live full-resolution pipeline');
  test.skip(testInfo.project.name === 'mobile-chromium', 'desktop-scoped');
  test.skip(!fs.existsSync(FULLRES_ZIP), 'Log_sample/case_b_field_data.zip is not in this checkout');
  test.setTimeout(6 * STAGE_MS);

  fs.mkdirSync(FULLRES_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('crash', () => log('PAGE CRASH'));

  const zipStat = fs.statSync(FULLRES_ZIP);
  log(`zip ${FULLRES_ZIP} (${zipStat.size} bytes)`);

  try {
    await page.request.fetch('http://localhost:3001/api/detect-anomaly', { method: 'GET' });
  } catch (e) {
    throw new Error(`API server is not reachable on :3001 — start npm run dev:server in this worktree before the run. ${e}`);
  }

  await page.goto('/');
  await page.fill('#inputCsText', CS_TEXT);
  await page.check('#sensitiveConfirm');

  log('uploading zip (catalog may take several minutes — persistBrowserFile copies 1.6GB)...');
  await page.setInputFiles('#zipFileInput', FULLRES_ZIP);

  await expect.poll(async () => {
    const snap = await page.evaluate(sys6FromState());
    if (snap.zipScanning) log('zip scanning...');
    if (snap.src) log(`sys6 ${snap.src.status} ${snap.src.sizeLabel || ''} sources=${snap.sourceCount}`);
    else if (snap.sourceCount) log(`cataloged ${snap.sourceCount} sources, sys6 not yet listed`);
    return snap.src ? snap.src.path : '';
  }, { timeout: 25 * 60 * 1000, intervals: [2000, 5000, 10000] }).toMatch(/data_sys_6\.csv$/);

  await expect.poll(async () => {
    const snap = await page.evaluate(sys6FromState());
    return snap.zipScanning === false && snap.src && snap.src.status === 'cataloged';
  }, { timeout: 10 * 60 * 1000, intervals: [1000, 2000, 5000] }).toBe(true);

  const cataloged = await page.evaluate(sys6FromState());
  writeJson(path.join(FULLRES_DIR, 'catalog.json'), cataloged);
  await page.screenshot({ path: path.join(REPORT_DIR, 'fullres-catalog.png'), fullPage: true });

  const sys6Item = page.locator('.source-item').filter({
    has: page.locator('.source-path', { hasText: /field_data\/data_sys_6\.csv/ })
  });
  await expect(sys6Item.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ })).toBeVisible({ timeout: 30_000 });
  log('clicking 분석 포함 on field_data/data_sys_6.csv');
  await sys6Item.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ }).click();

  let streamError = null;
  await expect.poll(async () => {
    const snap = await page.evaluate(sys6FromState());
    const src = snap.src;
    if (!src) return 0;
    if (src.status === 'error') {
      streamError = src.errorMsg || 'unknown stream error';
      return 19_000_001;
    }
    const pct = src.sizeBytes ? Math.round(100 * (src.processedBytes || 0) / src.sizeBytes) : 0;
    log(`stream ${src.status} ${pct}% rows=${src.rowCount} droppedR=${src.droppedResistanceEvents}`);
    return src.status === 'ready' ? src.rowCount : 0;
  }, { timeout: 40 * 60 * 1000, intervals: [10000, 15000, 30000] }).toBeGreaterThan(19_000_000);
  if (streamError) throw new Error(`sys6 stream error: ${streamError}`);

  const streamed = await page.evaluate(sys6FromState());
  writeJson(path.join(FULLRES_DIR, 'stream.json'), { capturedAt: new Date().toISOString(), ...streamed });
  await page.screenshot({ path: path.join(REPORT_DIR, 'fullres-stream-done.png'), fullPage: true });
  log(`stream done rows=${streamed.src.rowCount} droppedEvents=${streamed.src.droppedResistanceEvents} vdev=${JSON.stringify(streamed.src.outlierCell)}`);

  if (!streamed.src.selected) {
    log('sys6 was not auto-selected — checking the source checkbox');
    await sys6Item.locator('input[type="checkbox"]').check();
  }

  // STEP 2 — live detect-anomaly. Figures are built synchronously before the
  // CLI call, so T1 numbers are captured even if the model later 429s.
  log('detect-anomaly (live)...');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  await expect.poll(async () => {
    const ids = await page.evaluate(() => (window.state.figureSpecs || []).map(f => f.id));
    if (ids.length) log(`figures so far: ${ids.join(',')}`);
    return ids.includes('B-F1');
  }, { timeout: 5 * 60 * 1000, intervals: [500, 1000, 2000] }).toBe(true);

  const figures = await page.evaluate(compactFigures());
  const conflict = await page.evaluate(() => window.state.attributionConflict);
  const t1 = {
    capturedAt: new Date().toISOString(),
    source: streamed.src,
    figures,
    attributionConflict: conflict
  };
  writeJson(path.join(FULLRES_DIR, 't1-figures.json'), t1);
  writeJson(path.join(REPORT_DIR, 'full-resolution-sys6.json'), t1);
  const bf1 = figures.find(f => f.id === 'B-F1') || {};
  const bf4 = figures.find(f => f.id === 'B-F4') || {};
  const bf5 = figures.find(f => f.id === 'B-F5') || {};
  log(`T1 B-F1 outlierCell=${bf1.summaryStats && bf1.summaryStats.outlierCell} matched=${bf1.summaryStats && bf1.summaryStats.matchedCount}/${bf1.summaryStats && bf1.summaryStats.eventCount} dropped=${bf1.summaryStats && bf1.summaryStats.droppedEvents}`);
  log(`T1 B-F4 available=${bf4.available} kneeT=${bf4.summaryStats && bf4.summaryStats.kneeT} reason=${bf4.unavailableReason}`);
  log(`T1 B-F5 available=${bf5.available} reason=${bf5.unavailableReason}`);
  log(`T1 conflict status=${conflict && conflict.status} vdev=${conflict && conflict.voltageResidual && conflict.voltageResidual.cell} resist=${conflict && conflict.eventResistance && conflict.eventResistance.cell}`);

  const banner = page.locator('.attribution-conflict-banner');
  if (await banner.count()) {
    await banner.scrollIntoViewIfNeeded();
    await banner.screenshot({ path: path.join(REPORT_DIR, 'fullres-attribution.png') });
  } else {
    await page.screenshot({ path: path.join(REPORT_DIR, 'fullres-attribution.png'), fullPage: true });
    log('no attribution-conflict banner (status is not conflict)');
  }

  await waitForStage(page, page.getByRole('button', { name: /원인 가설 생성/ }), 'detect-anomaly');
  await page.screenshot({ path: path.join(FULLRES_DIR, 'step2-anomaly.png'), fullPage: true });

  log('generate-hypotheses (live)...');
  await page.getByRole('button', { name: /원인 가설 생성/ }).click();
  await waitForStage(page, page.locator('.hyp-radio').first(), 'generate-hypotheses');

  const hypCount = await page.locator('.hyp-radio').count();
  log(`hypotheses offered: ${hypCount}`);
  const names = await page.locator('.hyp-name').allInnerTexts();
  names.forEach((n, i) => log(`  [${i}] ${n}`));
  writeJson(path.join(FULLRES_DIR, 'hypotheses.json'), { hypCount, names });

  await page.locator('.hyp-radio').first().check();
  await page.selectOption('#sevSelect', '상');
  const vCell = conflict?.voltageResidual?.cell || '미산출';
  const rCell = conflict?.eventResistance?.cell || '미산출';
  const status = conflict?.status || 'unknown';
  await page.fill('#sevReasonInput',
    `원본 해상도 스트림에서 전압 잔차는 ${vCell}을, 이벤트 저항은 ${rCell}을 지목했다 (status=${status}). ` +
    '전 기간 데이터가 포함되어 현장 점검 우선순위를 상으로 둔다.');
  await page.screenshot({ path: path.join(FULLRES_DIR, 'step4-review.png'), fullPage: true });

  log('draft-report (live)...');
  await page.getByRole('button', { name: /가설·심각도 확정 → 보고서 생성/ }).click();
  await waitForStage(page, page.getByRole('button', { name: /HTML로 저장/ }), 'draft-report');
  await page.screenshot({ path: path.join(FULLRES_DIR, 'step5-report.png'), fullPage: true });

  const independentBefore = await page.evaluate(() => ({
    report: window.state.report?.independentFindings || [],
    edits: window.state.reportEdits?.independentFindings || []
  }));
  writeJson(path.join(FULLRES_DIR, 'independent-findings-before.json'), independentBefore);

  const independentDownload = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: /HTML로 저장/ }).click();
  const independentFile = await independentDownload;
  const independentPath = path.join(FULLRES_DIR, 'case_b_report_fullres.html');
  await independentFile.saveAs(independentPath);
  log(`saved independent report ${independentPath} (${fs.statSync(independentPath).size} bytes)`);

  // T2 — published comparison AFTER independent analysis.
  log('published comparison (live)...');
  await page.locator('#publishedExcerpt').fill(PUBLISHED_EXCERPT);
  await page.getByRole('button', { name: /공개 결과와 대조/ }).click();
  await waitForStage(page, page.locator('.comparison-table'), 'published-comparison');
  await page.locator('.comparison-table').screenshot({ path: path.join(REPORT_DIR, 'fullres-comparison.png') });

  const independentAfter = await page.evaluate(() => ({
    report: window.state.report?.independentFindings || [],
    edits: window.state.reportEdits?.independentFindings || [],
    comparison: window.state.publishedComparison || []
  }));
  writeJson(path.join(FULLRES_DIR, 't2-comparison.json'), {
    capturedAt: new Date().toISOString(),
    excerpt: PUBLISHED_EXCERPT,
    independentBefore,
    independentAfter,
    findingsFrozen: JSON.stringify(independentBefore.edits) === JSON.stringify(independentAfter.edits)
      && JSON.stringify(independentBefore.report) === JSON.stringify(independentAfter.report)
  });

  expect(independentAfter.edits, 'runPublishedComparison must not rewrite reportEdits.independentFindings').toEqual(independentBefore.edits);
  expect(independentAfter.report, 'runPublishedComparison must not rewrite report.independentFindings').toEqual(independentBefore.report);
  expect(independentAfter.comparison.length).toBeGreaterThan(0);

  const comparedDownload = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: /HTML로 저장/ }).click();
  const comparedFile = await comparedDownload;
  const comparedPath = path.join(REPORT_DIR, 'case_b_report_compared.html');
  await comparedFile.saveAs(comparedPath);
  const comparedBytes = fs.statSync(comparedPath).size;
  log(`saved ${comparedPath} (${comparedBytes} bytes)`);

  const comparedHtml = fs.readFileSync(comparedPath, 'utf8');
  expect(comparedHtml).toContain('공개 결과 대조');
  expect(comparedHtml).toContain('Independent Findings');
  expect(comparedBytes).toBeGreaterThan(50_000);
  expect(pageErrors, `pageerrors: ${pageErrors.join(' | ')}`).toEqual([]);
});
