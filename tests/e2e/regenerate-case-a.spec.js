/**
 * Case A report regeneration — drives the REAL pipeline (no API mocking).
 *
 * Skipped unless RUN_CASE_A=1 so `npm run test:e2e` stays fast. A real run
 * catalogs the nested AEMO zip, streams chosen daily CSVs (~522 MB each),
 * and makes three live Claude CLI calls (plus an optional published
 * comparison after the independent report is saved). Budget an hour or more.
 *
 *   RUN_CASE_A=1 PW_PORT=5186 npx playwright test tests/e2e/regenerate-case-a.spec.js \
 *     --project=desktop-chromium
 *
 * Requires the API server on :3001, Log_sample/case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip,
 * and a generous CLAUDE_CLI_TIMEOUT_MS. Do not set RUN_CASE_A together with
 * RUN_CASE_B / RUN_CASE_B_FULLRES — both consume the same Claude quota.
 *
 * Nested-zip inventory (verified from local file headers):
 *   outer 520,040,023 bytes → 7 daily inner zips (20250817–20250823).
 *   Each inner zip is ~76–79 MB and holds one CSV of ~522 MB uncompressed.
 *   Filename date is the AEMO NEXT_DAY publication date: PUBLIC_…_20250819
 *   starts 2025/08/18 04:05; PUBLIC_…_20250820 starts 2025/08/19 04:05.
 *   The 2025-08-19 incident therefore lives in the 20250820 CSV.
 *
 * Days streamed (override with CASE_A_DAYS=20250819,20250820):
 *   default 20250818,20250819,20250820 = trading days 17/18/19 Aug.
 *   20250820 is required and is last in catalog order so last-source-wins
 *   figure series stay on the incident trading day.
 *
 * Human review (Step 4) is not auto-picked. After hypotheses land, the test
 * writes tmp/case-a-regen/hypotheses.json and waits for
 * tmp/case-a-regen/review-decision.json:
 *   { "hypIndex": 0, "severity": "중", "reason": "..." }
 * Optional: CASE_A_REVIEW_JSON='{"hypIndex":0,"severity":"중","reason":"..."}'
 *
 * The published-comparison excerpt is filled only AFTER the independent
 * HTML is saved. Do not read AEMO conclusions before that point.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test.describe.configure({ mode: 'serial' });

const CASE_A_ZIP = path.resolve('Log_sample/case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip');
const OUT_DIR = path.resolve('tmp/case-a-regen');
const REPORT_DIR = path.resolve('Report');
const DECISION_PATH = path.join(OUT_DIR, 'review-decision.json');
const INCIDENT_DAY = '20250820';
const DEFAULT_DAYS = ['20250818', '20250819', '20250820'];

const CS_TEXT = [
  '공개 AEMO NEXT_DAY FPPMW 텔레메트리에서 Western Downs BESS(WDBESS1)와 동일 피드의 다른 BESS 설비 유효전력 거동을 점검해 주세요.',
  '내부 BMS/PCS/EMS 로그는 없으며 Dispatch Target 컬럼도 없습니다.',
  '업로드된 구간의 실측 MW, 품질 플래그, 스케줄 엔벌로프만으로 이상을 독립 확인하고, 특정 공개 사건 시각을 전제로 하지 마십시오.'
].join(' ');

// Pasted into the UI only after the independent report is saved.
// Titles the repo already records — not used as analysis thresholds.
const PUBLISHED_EXCERPT = [
  'AEMO, Self-Forecasting Errors and Frequency Excursion on 19 August 2025.',
  'AEMO Market Notices — WDBESS1 Non-Conformance, 19 Aug 2025. WDBESS1: 12:15–12:20, -55 MW.'
].join('\n');

const STAGE_MS = 100 * 60 * 1000;

function selectedDays() {
  const raw = (process.env.CASE_A_DAYS || '').trim();
  const days = raw
    ? raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    : DEFAULT_DAYS.slice();
  if (!days.includes(INCIDENT_DAY)) {
    throw new Error(`CASE_A_DAYS must include ${INCIDENT_DAY} (incident trading day 2025-08-19 lives in that file)`);
  }
  return days;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(path.join(OUT_DIR, 'progress.log'), line + '\n');
  } catch {
    // progress log is best-effort
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  log(`wrote ${filePath}`);
}

function mark(timings, name) {
  const now = Date.now();
  const prev = timings._last || timings.t0;
  timings[name] = {
    at: new Date(now).toISOString(),
    ms: now - timings.t0,
    sincePrevMs: now - prev
  };
  timings._last = now;
  log(`timing ${name} +${Math.round((now - prev) / 1000)}s (total ${Math.round((now - timings.t0) / 1000)}s)`);
}

/**
 * Waits for a live stage to land, but gives up the moment the app renders its
 * error box instead. Without this a stage failure (a CLI 504, or the account
 * hitting its spend limit) would sit on the full STAGE_MS timeout even though
 * the page already knows it failed.
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

function dumpPartials(page, timings, extra) {
  return page.evaluate(() => ({
    capturedAt: new Date().toISOString(),
    error: window.state.error,
    phase: window.state.phase,
    step: window.state.step,
    sourceCount: (window.state.logSources || []).length,
    sources: (window.state.logSources || []).map(s => ({
      id: s.id,
      path: s.path,
      name: s.name,
      status: s.status,
      selected: s.selected,
      errorMsg: s.errorMsg || '',
      formatId: s.format && s.format.id,
      sizeBytes: s.sizeBytes,
      rowCount: s.rowCount,
      alarmCount: s.alarmCount,
      entityFilter: s.entityFilter,
      entityFilterAuto: s.entityFilterAuto,
      entityColumn: s.entityColumn,
      groupCount: s.groups ? Object.keys(s.groups).length : 0,
      groupIds: s.groups ? Object.keys(s.groups) : [],
      dataTimeRange: s.dataTimeRange,
      evidenceTimeRange: s.evidenceTimeRange,
      timeCoverageRatio: s.timeCoverageRatio,
      alarmDroppedCount: s.alarmDroppedCount,
      alarmSampleTimeDistribution: s.alarmSampleTimeDistribution,
      processedBytes: s.processedBytes
    })),
    zipScanning: window.state.zipScanning,
    zipSkipped: window.state.zipSkipped || [],
    figures: (window.state.figureSpecs || []).map(f => ({
      id: f.id,
      claim: f.claim,
      available: Boolean(f.available),
      unavailableReason: f.unavailableReason || null,
      evidenceTier: f.evidenceTier || null,
      summaryStats: f.summaryStats || {},
      seriesPointCounts: (f.series || []).map(s => ({
        name: s.name,
        n: (s.t || []).length,
        tMin: s.t && s.t.length ? s.t[0] : null,
        tMax: s.t && s.t.length ? s.t[s.t.length - 1] : null,
        tMinIso: s.t && s.t.length ? new Date(s.t[0]).toISOString() : null,
        tMaxIso: s.t && s.t.length ? new Date(s.t[s.t.length - 1]).toISOString() : null
      }))
    })),
    hypotheses: window.state.hypotheses || [],
    sourceProfiles: window.state.sourceProfiles || [],
    lastTruncation: window.state.lastTruncation,
    attributionConflict: window.state.attributionConflict
  })).then(snap => {
    writeJson(path.join(OUT_DIR, 'partial.json'), { timings, ...extra, ...snap });
    return snap;
  });
}

function catalogSnapshot() {
  return () => ({
    zipScanning: window.state.zipScanning,
    skipped: window.state.zipSkipped || [],
    sourceCount: (window.state.logSources || []).length,
    sources: (window.state.logSources || []).map(s => ({
      id: s.id,
      path: s.path,
      name: s.name,
      status: s.status,
      selected: s.selected,
      errorMsg: s.errorMsg || '',
      formatId: s.format && s.format.id,
      formatLabel: s.format && s.format.label,
      sizeBytes: s.sizeBytes,
      sizeLabel: s.sizeLabel,
      entityColumn: s.entityColumn,
      entityFilter: s.entityFilter,
      entityFilterAuto: s.entityFilterAuto
    }))
  });
}

function compactFigures() {
  return () => (window.state.figureSpecs || []).map(f => ({
    id: f.id,
    claim: f.claim,
    available: Boolean(f.available),
    unavailableReason: f.unavailableReason || null,
    evidenceTier: f.evidenceTier || null,
    summaryStats: f.summaryStats || {},
    seriesPointCounts: (f.series || []).map(s => ({
      name: s.name,
      n: (s.t || []).length,
      tMin: s.t && s.t.length ? s.t[0] : null,
      tMax: s.t && s.t.length ? s.t[s.t.length - 1] : null,
      tMinIso: s.t && s.t.length ? new Date(s.t[0]).toISOString() : null,
      tMaxIso: s.t && s.t.length ? new Date(s.t[s.t.length - 1]).toISOString() : null
    }))
  }));
}

function sourceItem(page, day) {
  return page.locator('.source-item').filter({
    has: page.locator('.source-path', { hasText: new RegExp(day) })
  });
}

async function waitForReviewDecision() {
  const fromEnv = (process.env.CASE_A_REVIEW_JSON || '').trim();
  if (fromEnv) {
    log('review decision from CASE_A_REVIEW_JSON');
    return JSON.parse(fromEnv);
  }
  log(`HUMAN REVIEW: write ${DECISION_PATH} as {"hypIndex":N,"severity":"상|중|하","reason":"..."}`);
  await expect.poll(() => fs.existsSync(DECISION_PATH), {
    timeout: STAGE_MS,
    intervals: [2000, 5000, 10000]
  }).toBe(true);
  const decision = JSON.parse(fs.readFileSync(DECISION_PATH, 'utf8'));
  log(`review decision loaded hypIndex=${decision.hypIndex} severity=${decision.severity}`);
  return decision;
}

test('regenerate the Case A executive report through the nested-zip pipeline', async ({ page }, testInfo) => {
  test.skip(process.env.RUN_CASE_B === '1' || process.env.RUN_CASE_B_FULLRES === '1',
    'do not run two live pipelines at once');
  test.skip(process.env.RUN_CASE_A !== '1', 'set RUN_CASE_A=1 to run the live regeneration');
  test.skip(testInfo.project.name === 'mobile-chromium', 'desktop-scoped');
  test.skip(!fs.existsSync(CASE_A_ZIP), 'Log_sample/case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip is not in this checkout');
  test.setTimeout(8 * STAGE_MS);

  const days = selectedDays();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('crash', () => log('PAGE CRASH'));

  const zipStat = fs.statSync(CASE_A_ZIP);
  const timings = { t0: Date.now(), days };
  log(`zip ${CASE_A_ZIP} (${zipStat.size} bytes); days=${days.join(',')}`);
  writeJson(path.join(OUT_DIR, 'run-config.json'), {
    zip: CASE_A_ZIP,
    zipBytes: zipStat.size,
    days,
    incidentDay: INCIDENT_DAY,
    reason: 'AEMO NEXT_DAY filename 20250820 starts 2025/08/19 04:05 (incident trading day). Neighbouring publication days 20250818 and 20250819 add the two prior trading days. 20250820 is last in catalog order so figure series (last-source-wins per entity) stay on the incident day. Each CSV is ~522 MB uncompressed — not the ~78 MB inner-zip size — so all 7 days were not streamed.'
  });

  try {
    await page.request.fetch('http://localhost:3001/api/detect-anomaly', { method: 'GET' });
  } catch (e) {
    throw new Error(`API server is not reachable on :3001 — start npm run dev:server in this worktree before the run. ${e}`);
  }

  await page.goto('/');
  await page.fill('#inputCsText', CS_TEXT);
  await page.check('#sensitiveConfirm');

  log('uploading nested zip (persistBrowserFile copies ~520 MB, then catalogs 7 inner zips)...');
  await page.setInputFiles('#zipFileInput', CASE_A_ZIP);

  await expect.poll(async () => {
    const snap = await page.evaluate(catalogSnapshot());
    if (snap.zipScanning) log('zip scanning...');
    else log(`catalog sources=${snap.sourceCount} scanning=${snap.zipScanning}`);
    return snap.zipScanning === false && snap.sourceCount >= 7;
  }, { timeout: 25 * 60 * 1000, intervals: [2000, 5000, 10000] }).toBe(true);

  const cataloged = await page.evaluate(catalogSnapshot());
  mark(timings, 'catalog');
  writeJson(path.join(OUT_DIR, 'catalog.json'), cataloged);
  await page.screenshot({ path: path.join(OUT_DIR, 'catalog.png'), fullPage: true });

  expect(cataloged.sourceCount).toBeGreaterThanOrEqual(7);
  const csvPaths = cataloged.sources.map(s => s.path);
  log(`cataloged paths:\n${csvPaths.map(p => '  ' + p).join('\n')}`);
  for (const day of days) {
    expect(csvPaths.some(p => p.includes(day)), `catalog missing ${day}`).toBe(true);
  }

  // Entity filter must stay visible and clearable — do not hide or overwrite it.
  const incidentItem = sourceItem(page, INCIDENT_DAY);
  const filterInput = incidentItem.locator('.source-entity-row input[type="text"]');
  await expect(filterInput).toBeVisible({ timeout: 10_000 });
  await expect(filterInput).toHaveValue('BESS');
  await expect(filterInput).toBeEnabled();
  await expect(incidentItem.getByText('자동 제안됨')).toBeVisible();
  log('entity filter visible value=BESS auto-suggested enabled');

  for (const day of days) {
    const item = sourceItem(page, day);
    await expect(item.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ })).toBeVisible({ timeout: 30_000 });
    log(`clicking 분석 포함 on ${day}`);
    await item.getByRole('button', { name: /분석 포함 \(스트리밍 시작\)/ }).click();

    let streamError = null;
    await expect.poll(async () => {
      const src = (await page.evaluate(() => (window.state.logSources || []).map(s => ({
        path: s.path,
        status: s.status,
        errorMsg: s.errorMsg || '',
        rowCount: s.rowCount,
        processedBytes: s.processedBytes,
        sizeBytes: s.sizeBytes,
        entityFilter: s.entityFilter
      })))).find(s => (s.path || '').includes(day));
      if (!src) return 0;
      if (src.status === 'error') {
        streamError = src.errorMsg || 'unknown stream error';
        return -1;
      }
      const pct = src.sizeBytes ? Math.round(100 * (src.processedBytes || 0) / src.sizeBytes) : 0;
      log(`stream ${day} ${src.status} ${pct}% rows=${src.rowCount} filter=${src.entityFilter}`);
      return src.status === 'ready' ? (src.rowCount || 1) : 0;
    }, { timeout: 40 * 60 * 1000, intervals: [10000, 15000, 30000] }).toBeGreaterThan(0);
    if (streamError) throw new Error(`${day} stream error: ${streamError}`);
    mark(timings, `stream-${day}`);
  }

  const streamed = await page.evaluate(() => (window.state.logSources || []).map(s => ({
    id: s.id,
    path: s.path,
    name: s.name,
    status: s.status,
    selected: s.selected,
    errorMsg: s.errorMsg || '',
    formatId: s.format && s.format.id,
    sizeBytes: s.sizeBytes,
    sizeLabel: s.sizeLabel,
    rowCount: s.rowCount,
    alarmCount: s.alarmCount,
    derivedAlarmCount: s.groups
      ? Object.values(s.groups).reduce((sum, g) => sum + (g.derived?.alarmCount || 0), 0)
      : (s.derived?.alarmCount || 0),
    entityColumn: s.entityColumn,
    entityFilter: s.entityFilter,
    entityFilterAuto: s.entityFilterAuto,
    groupCount: s.groups ? Object.keys(s.groups).length : 0,
    groupIds: s.groups ? Object.keys(s.groups) : [],
    dataTimeRange: s.dataTimeRange,
    evidenceTimeRange: s.evidenceTimeRange,
    timeCoverageRatio: s.timeCoverageRatio,
    alarmDroppedCount: s.alarmDroppedCount,
    alarmSampleTimeDistribution: s.alarmSampleTimeDistribution,
    columns: s.columns
  })));
  writeJson(path.join(OUT_DIR, 'stream.json'), { capturedAt: new Date().toISOString(), sources: streamed });
  await page.screenshot({ path: path.join(OUT_DIR, 'stream-done.png'), fullPage: true });

  const coverage = page.locator('.time-coverage');
  const coverageCount = await coverage.count();
  for (let i = 0; i < coverageCount; i++) {
    log(`time coverage[${i}]: ${(await coverage.nth(i).innerText()).replace(/\s+/g, ' ')}`);
  }

  // Keep every streamed day selected. Last-source-wins for figure series is
  // accepted (20250820 is last among the default set).
  for (const day of days) {
    const src = streamed.find(s => (s.path || '').includes(day));
    if (src && !src.selected) {
      log(`${day} was not auto-selected — checking the source checkbox`);
      await sourceItem(page, day).locator('input[type="checkbox"]').check();
    }
  }

  // Filter still visible after streaming (ready-state row).
  await expect(sourceItem(page, INCIDENT_DAY).locator('.source-entity-row input[type="text"]')).toBeVisible();
  await expect(sourceItem(page, INCIDENT_DAY).locator('.source-entity-row input[type="text"]')).toHaveValue('BESS');

  log('detect-anomaly (live)...');
  await page.getByRole('button', { name: /이상 구간 탐지 시작/ }).click();
  await expect.poll(async () => {
    const ids = await page.evaluate(() => (window.state.figureSpecs || []).map(f => f.id));
    if (ids.length) log(`figures so far: ${ids.join(',')}`);
    return ids.includes('A-F1');
  }, { timeout: 5 * 60 * 1000, intervals: [500, 1000, 2000] }).toBe(true);

  const figures = await page.evaluate(compactFigures());
  writeJson(path.join(OUT_DIR, 't1-figures.json'), {
    capturedAt: new Date().toISOString(),
    figures,
    sources: streamed
  });
  writeJson(path.join(REPORT_DIR, 'case_a_pipeline.json'), {
    capturedAt: new Date().toISOString(),
    days,
    figures,
    sources: streamed.filter(s => days.some(d => (s.path || '').includes(d)))
  });
  for (const f of figures) {
    log(`T1 ${f.id} available=${f.available} reason=${f.unavailableReason || ''} stats=${JSON.stringify(f.summaryStats || {})}`);
  }

  try {
    await waitForStage(page, page.getByRole('button', { name: /원인 가설 생성/ }), 'detect-anomaly');
  } catch (e) {
    await dumpPartials(page, timings, { stage: 'detect-anomaly', error: String(e) });
    await page.screenshot({ path: path.join(OUT_DIR, 'step2-error.png'), fullPage: true }).catch(() => {});
    throw e;
  }
  mark(timings, 'detect-anomaly');
  await page.screenshot({ path: path.join(OUT_DIR, 'step2-anomaly.png'), fullPage: true });

  log('generate-hypotheses (live)...');
  await page.getByRole('button', { name: /원인 가설 생성/ }).click();
  try {
    await waitForStage(page, page.locator('.hyp-radio').first(), 'generate-hypotheses');
  } catch (e) {
    await dumpPartials(page, timings, { stage: 'generate-hypotheses', error: String(e) });
    await page.screenshot({ path: path.join(OUT_DIR, 'step3-error.png'), fullPage: true }).catch(() => {});
    throw e;
  }
  mark(timings, 'generate-hypotheses');

  const hypotheses = await page.evaluate(() => (window.state.hypotheses || []).map(h => ({
    id: h.id,
    name: h.name,
    domain: h.domain,
    confidence: h.confidence,
    expectedSignature: h.expectedSignature,
    actualObservation: h.actualObservation,
    evidence: h.evidence,
    evidenceTier: h.evidenceTier,
    disconfirmingEvidence: h.disconfirmingEvidence,
    missingSignals: h.missingSignals,
    claimLimit: h.claimLimit,
    severityDraft: h.severityDraft,
    severityReason: h.severityReason
  })));
  const hypCount = await page.locator('.hyp-radio').count();
  log(`hypotheses offered: ${hypCount}`);
  hypotheses.forEach((h, i) => log(`  [${i}] ${h.id} ${h.name} (${h.domain}, ${h.confidence})`));
  writeJson(path.join(OUT_DIR, 'hypotheses.json'), { hypCount, hypotheses, figures });

  const decision = await waitForReviewDecision();
  const hypIndex = Number(decision.hypIndex);
  expect(Number.isInteger(hypIndex) && hypIndex >= 0 && hypIndex < hypCount,
    `hypIndex ${decision.hypIndex} out of range 0..${hypCount - 1}`).toBe(true);
  expect(['상', '중', '하']).toContain(decision.severity);
  expect(String(decision.reason || '').trim().length).toBeGreaterThan(10);

  await page.locator('.hyp-radio').nth(hypIndex).check();
  await page.selectOption('#sevSelect', decision.severity);
  await page.fill('#sevReasonInput', String(decision.reason).trim());
  await page.screenshot({ path: path.join(OUT_DIR, 'step4-review.png'), fullPage: true });
  writeJson(path.join(OUT_DIR, 'review-applied.json'), {
    ...decision,
    picked: hypotheses[hypIndex]
  });
  mark(timings, 'human-review');

  log('draft-report (live)...');
  await page.getByRole('button', { name: /가설·심각도 확정 → 보고서 생성/ }).click();
  try {
    await waitForStage(page, page.getByRole('button', { name: /HTML로 저장/ }), 'draft-report');
  } catch (e) {
    await dumpPartials(page, timings, { stage: 'draft-report', error: String(e) });
    await page.screenshot({ path: path.join(OUT_DIR, 'step5-error.png'), fullPage: true }).catch(() => {});
    throw e;
  }
  mark(timings, 'draft-report');
  await page.screenshot({ path: path.join(OUT_DIR, 'step5-report.png'), fullPage: true });

  const independentBefore = await page.evaluate(() => ({
    report: window.state.report?.independentFindings || [],
    edits: window.state.reportEdits?.independentFindings || [],
    headline: window.state.reportEdits?.headline || window.state.report?.headline || '',
    severity: window.state.finalSeverity,
    severityReason: window.state.finalSeverityReason,
    hyp: window.state.confirmedHypothesis?.name || null
  }));
  writeJson(path.join(OUT_DIR, 'independent-findings-before.json'), independentBefore);

  const independentDownload = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: /HTML로 저장/ }).click();
  const independentFile = await independentDownload;
  const independentTmp = path.join(OUT_DIR, 'case_a_report.html');
  const independentReport = path.join(REPORT_DIR, 'case_a_report.html');
  await independentFile.saveAs(independentTmp);
  fs.copyFileSync(independentTmp, independentReport);
  const independentBytes = fs.statSync(independentTmp).size;
  log(`saved independent report ${independentReport} (${independentBytes} bytes)`);
  expect(independentBytes).toBeGreaterThan(20_000);
  mark(timings, 'independent-save');

  // Published comparison AFTER independent analysis. Skip if CASE_A_SKIP_COMPARE=1.
  if (process.env.CASE_A_SKIP_COMPARE === '1') {
    log('skipping published comparison (CASE_A_SKIP_COMPARE=1)');
    writeJson(path.join(OUT_DIR, 'timings.json'), timings);
    expect(pageErrors, `pageerrors: ${pageErrors.join(' | ')}`).toEqual([]);
    return;
  }

  log('published comparison (live)...');
  await page.locator('#publishedExcerpt').fill(PUBLISHED_EXCERPT);
  await page.getByRole('button', { name: /공개 결과와 대조/ }).click();
  try {
    await waitForStage(page, page.locator('.comparison-table'), 'published-comparison');
  } catch (e) {
    await dumpPartials(page, timings, { stage: 'published-comparison', error: String(e) });
    await page.screenshot({ path: path.join(OUT_DIR, 'compare-error.png'), fullPage: true }).catch(() => {});
    writeJson(path.join(OUT_DIR, 'timings.json'), timings);
    throw e;
  }
  mark(timings, 'published-comparison');
  await page.locator('.comparison-table').screenshot({ path: path.join(OUT_DIR, 'comparison.png') });

  const independentAfter = await page.evaluate(() => ({
    report: window.state.report?.independentFindings || [],
    edits: window.state.reportEdits?.independentFindings || [],
    comparison: window.state.publishedComparison || []
  }));
  writeJson(path.join(OUT_DIR, 't2-comparison.json'), {
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
  const comparedPath = path.join(REPORT_DIR, 'case_a_report_compared.html');
  await comparedFile.saveAs(comparedPath);
  const comparedBytes = fs.statSync(comparedPath).size;
  log(`saved ${comparedPath} (${comparedBytes} bytes)`);
  fs.copyFileSync(comparedPath, path.join(OUT_DIR, 'case_a_report_compared.html'));

  const comparedHtml = fs.readFileSync(comparedPath, 'utf8');
  expect(comparedHtml).toContain('공개 결과 대조');
  expect(comparedHtml).toContain('Independent Findings');
  expect(comparedBytes).toBeGreaterThan(20_000);
  writeJson(path.join(OUT_DIR, 'timings.json'), timings);
  expect(pageErrors, `pageerrors: ${pageErrors.join(' | ')}`).toEqual([]);
});
