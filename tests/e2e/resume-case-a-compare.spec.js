/**
 * Case A published-comparison resume — runs ONLY the last live stage.
 *
 * The comparison is the final live call in regenerate-case-a.spec.js and has
 * twice been the only stage to fail: once on a Claude session limit
 * (2026-08-31), once when the API server went away mid-call (2026-09-03).
 * Both times the independent report was already saved, and both times the
 * retry cost another detect/hypotheses/draft round — roughly 30 minutes of
 * live model time to redo work that had succeeded.
 *
 * This spec seeds the app with tmp/case-a-regen/report-full.json (written by
 * the regeneration spec at its independent-save point) and then does exactly
 * what the failed step would have done: fill the excerpt, run the live
 * comparison, export the compared HTML through the app's own button.
 *
 *   RUN_CASE_A_COMPARE=1 PW_PORT=5186 npx playwright test \
 *     tests/e2e/resume-case-a-compare.spec.js --project=desktop-chromium
 *
 * Requires the API server on :3001 and Report/case_a_report.html from the
 * same run as the dump. No ZIP, no streaming, one live model call.
 *
 * CASE_A_COMPARE_DRY=1 stops after the fidelity gate below — the whole
 * seeding path can be checked without spending a model call.
 *
 * FIDELITY GATE: before the comparison runs, the seeded state is exported
 * and compared byte-for-byte against the independent HTML the original run
 * saved. Identical bytes are what make the resumed artifact honest: the
 * report text, the figure PNGs and the severity line are that run's, not a
 * reconstruction. If the bytes differ the spec fails and says so rather
 * than publishing a lookalike.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('tmp/case-a-regen');
const REPORT_DIR = path.resolve('Report');
const RESUME_PATH = path.join(OUT_DIR, 'report-full.json');
const INDEPENDENT_PATH = path.join(REPORT_DIR, 'case_a_report.html');
const COMPARED_PATH = path.join(REPORT_DIR, 'case_a_report_compared.html');

// Same two lines the regeneration spec pastes, for the same reason: titles
// this repo already records, never used as analysis thresholds. Read only
// after the independent report exists — here it always already does.
const PUBLISHED_EXCERPT = [
  'AEMO, Self-Forecasting Errors and Frequency Excursion on 19 August 2025.',
  'AEMO Market Notices — WDBESS1 Non-Conformance, 19 Aug 2025. WDBESS1: 12:15–12:20, -55 MW.'
].join('\n');

const STAGE_MS = 100 * 60 * 1000;

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

async function exportHtml(page, savePath) {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: /HTML로 저장/ }).click();
  const file = await download;
  await file.saveAs(savePath);
  return fs.statSync(savePath).size;
}

test('resume the Case A published comparison from the saved run', async ({ page }, testInfo) => {
  test.skip(process.env.RUN_CASE_A_COMPARE !== '1', 'set RUN_CASE_A_COMPARE=1 to run the live comparison');
  test.skip(testInfo.project.name === 'mobile-chromium', 'desktop-scoped');
  test.skip(!fs.existsSync(RESUME_PATH), 'tmp/case-a-regen/report-full.json is not in this checkout');
  test.setTimeout(2 * STAGE_MS);

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  const resume = JSON.parse(fs.readFileSync(RESUME_PATH, 'utf8'));
  const seed = resume.state || {};
  expect(fs.existsSync(INDEPENDENT_PATH), `${INDEPENDENT_PATH} must exist — the resume compares against it`).toBe(true);
  const savedIndependent = fs.readFileSync(INDEPENDENT_PATH);
  log(`resume dump ${RESUME_PATH} captured ${resume.capturedAt}; independent ${savedIndependent.length} bytes`);
  expect((seed.reportEdits?.independentFindings || seed.report?.independentFindings || []).length,
    'the dump carries no independent findings — nothing to compare').toBeGreaterThan(0);
  expect((seed.figureSpecs || []).length, 'the dump carries no figure specs — the compared HTML would lose its charts').toBeGreaterThan(0);

  try {
    await page.request.fetch('http://localhost:3001/api/detect-anomaly', { method: 'GET' });
  } catch (e) {
    throw new Error(`API server is not reachable on :3001 — start the server in this worktree before the run. ${e}`);
  }

  await page.goto('/');
  await page.evaluate(state => {
    Object.assign(window.state, state, {
      step: 5,
      phase: 'result-report',
      publishedComparison: null,
      finalReviewConfirmed: false,
      readOnly: false,
      error: null
    });
    window.render();
  }, seed);
  log('seeded the saved run into step 5');

  await expect(page.getByRole('button', { name: /HTML로 저장/ })).toBeVisible();

  // FIDELITY GATE — the seeded export must reproduce the run's own bytes.
  const gatePath = path.join(OUT_DIR, 'case_a_report_reseeded.html');
  const gateBytes = await exportHtml(page, gatePath);
  const reseeded = fs.readFileSync(gatePath);
  const identical = reseeded.equals(savedIndependent);
  writeJson(path.join(OUT_DIR, 'resume-fidelity.json'), {
    capturedAt: new Date().toISOString(),
    savedBytes: savedIndependent.length,
    reseededBytes: gateBytes,
    identical
  });
  expect(identical,
    `reseeded export (${gateBytes} bytes) is not byte-identical to ${INDEPENDENT_PATH} (${savedIndependent.length} bytes) — do not publish a lookalike; re-run the full pipeline instead`).toBe(true);
  log('fidelity gate passed — reseeded export is byte-identical to the saved independent report');

  if (process.env.CASE_A_COMPARE_DRY === '1') {
    log('CASE_A_COMPARE_DRY=1 — stopping before the live comparison');
    expect(pageErrors, `pageerrors: ${pageErrors.join(' | ')}`).toEqual([]);
    return;
  }

  const independentBefore = await page.evaluate(() => ({
    report: window.state.report?.independentFindings || [],
    edits: window.state.reportEdits?.independentFindings || []
  }));

  log('published comparison (live)...');
  const compareStartedAt = new Date().toISOString();
  const t0 = Date.now();
  await page.locator('#publishedExcerpt').fill(PUBLISHED_EXCERPT);
  await page.getByRole('button', { name: /공개 결과와 대조/ }).click();
  try {
    await waitForStage(page, page.locator('.comparison-table'), 'published-comparison');
  } catch (e) {
    writeJson(path.join(OUT_DIR, 'resume-partial.json'), {
      capturedAt: new Date().toISOString(),
      compareStartedAt,
      elapsedMs: Date.now() - t0,
      error: String(e),
      appError: await page.evaluate(() => window.state.error || null)
    });
    await page.screenshot({ path: path.join(OUT_DIR, 'resume-compare-error.png'), fullPage: true }).catch(() => {});
    throw e;
  }
  const compareMs = Date.now() - t0;
  await page.locator('.comparison-table').screenshot({ path: path.join(OUT_DIR, 'resume-comparison.png') });

  const independentAfter = await page.evaluate(() => ({
    report: window.state.report?.independentFindings || [],
    edits: window.state.reportEdits?.independentFindings || [],
    comparison: window.state.publishedComparison || []
  }));
  const findingsFrozen = JSON.stringify(independentBefore.edits) === JSON.stringify(independentAfter.edits)
    && JSON.stringify(independentBefore.report) === JSON.stringify(independentAfter.report);
  writeJson(path.join(OUT_DIR, 'resume-comparison.json'), {
    capturedAt: new Date().toISOString(),
    excerpt: PUBLISHED_EXCERPT,
    compareStartedAt,
    compareMs,
    independentBefore,
    independentAfter,
    findingsFrozen
  });
  expect(independentAfter.edits, 'runPublishedComparison must not rewrite reportEdits.independentFindings').toEqual(independentBefore.edits);
  expect(independentAfter.report, 'runPublishedComparison must not rewrite report.independentFindings').toEqual(independentBefore.report);
  expect(independentAfter.comparison.length).toBeGreaterThan(0);

  const comparedBytes = await exportHtml(page, COMPARED_PATH);
  fs.copyFileSync(COMPARED_PATH, path.join(OUT_DIR, 'case_a_report_compared.html'));
  const comparedHtml = fs.readFileSync(COMPARED_PATH, 'utf8');
  expect(comparedHtml).toContain('공개 결과 대조');
  expect(comparedHtml).toContain('Independent Findings');
  expect(comparedBytes).toBeGreaterThan(savedIndependent.length);
  log(`saved ${COMPARED_PATH} (${comparedBytes} bytes, +${comparedBytes - savedIndependent.length} over the independent report)`);

  // The compared export must still contain the independent report verbatim —
  // the comparison section is appended, never a rewrite. Checked on bytes,
  // not on the in-page state alone.
  const independentText = savedIndependent.toString('utf8');
  const marker = independentText.slice(independentText.indexOf('<h1>'), independentText.indexOf('<h2>조치</h2>'));
  expect(marker.length).toBeGreaterThan(100);
  expect(comparedHtml.includes(marker),
    'the compared HTML does not contain the independent report verbatim').toBe(true);

  expect(pageErrors, `pageerrors: ${pageErrors.join(' | ')}`).toEqual([]);
});
