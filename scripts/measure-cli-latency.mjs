/**
 * Reproduces production `claude -p` flags from server/lib/claude-cli.js
 * and records wall-clock + token usage. Used for tasks 6-2 and 6-3.
 *
 * Usage:
 *   node scripts/measure-cli-latency.mjs --suite effort
 *   node scripts/measure-cli-latency.mjs --suite stages --from-detect <envelope.json>
 *   node scripts/measure-cli-latency.mjs --stage detect-anomaly --effort high --repeat 1
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PERSONA, buildDetectAnomalyPrompt, buildHypothesesPrompt, buildDraftReportPrompt } from '../server/lib/prompts.js';
import { detectAnomalyTool, hypothesesTool, draftReportTool } from '../server/lib/schemas.js';
import { makeAccumulator, feedLine, applyAccumulatorToSource } from '../src/log-engine.js';
import { detectFormat } from '../src/formats.js';
import { blocksToPromptText } from '../src/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'tmp', 'latency-runs');
const OUT_DIR = path.join(ROOT, 'Report', 'latency-effort-outputs');
const REAL_OUT_DIR = path.join(ROOT, 'Report', 'latency-effort-real-outputs');
const CLI_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
const CLI_TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TIMEOUT_MS) || 1_200_000;

const DETECT_PROMPT =
  '아래는 LFP 셀 어레이 로그의 파생 통계 요약이다. 2018-10-10부터 2018-11-28까지 Cell 8의 ' +
  '전압편차가 반복적으로 관측되었고, 파생 이상 행이 9,366건이다. 이상 구간을 가능한 한 ' +
  '빠짐없이, 발견되는 대로 모두 나열하라.';

const TOOLS = {
  'detect-anomaly': detectAnomalyTool,
  'generate-hypotheses': hypothesesTool,
  'draft-report': draftReportTool
};

function parseArgs(argv) {
  const out = {
    suite: null, stage: 'detect-anomaly', effort: null, repeat: 1,
    fromDetect: null, label: null, realCsv: null, outDir: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--suite') out.suite = next();
    else if (a === '--stage') out.stage = next();
    else if (a === '--effort') out.effort = next();
    else if (a === '--repeat') out.repeat = Number(next());
    else if (a === '--from-detect') out.fromDetect = next();
    else if (a === '--label') out.label = next();
    else if (a === '--real-csv') out.realCsv = next();
    else if (a === '--out-dir') out.outDir = next();
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function accumulateCsvBlock(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const first = lines.filter(l => l.trim()).slice(0, 4);
  const format = detectFormat(first);
  const acc = makeAccumulator(format);
  for (const line of lines) {
    if (line.trim()) feedLine(acc, line);
  }
  const src = { name: path.basename(csvPath) };
  applyAccumulatorToSource(src, acc);
  return {
    label: src.name,
    columns: src.columns,
    delimiter: src.delimiter,
    rowCount: src.rowCount,
    alarmCount: src.alarmCount,
    headSample: src.headSample,
    alarmSamples: src.alarmSamples,
    alarmAnnotations: src.alarmAnnotations,
    stats: src.stats,
    groups: src.groups,
    formatId: format.id,
    formatLabel: format.label,
    entityColumn: src.entityColumn || null,
    derived: src.derived,
    seriesByEntity: src.seriesByEntity || {},
    resistanceEventsByEntity: src.resistanceEventsByEntity || {},
    droppedResistanceEvents: src.droppedResistanceEvents || 0
  };
}

function buildRealDetectPrompt(csvPath) {
  const block = accumulateCsvBlock(csvPath);
  const { text, totalRows, count, sourceProfiles } = blocksToPromptText([block]);
  const prompt = buildDetectAnomalyPrompt({
    csText: '공개 LFP System 6 로그의 셀 전압 편차와 저항 이벤트를 확인해 주세요.',
    priorCase: '',
    combinedLogText: text,
    totalRows,
    sourceCount: count,
    sourceProfiles
  });
  return { prompt, totalRows, sourceCount: count, promptChars: prompt.length, derivedAlarmCount: block.derived?.alarmCount || 0 };
}

function isValidDetectResult(so) {
  if (!so || !Array.isArray(so.anomalyWindows) || so.anomalyWindows.length === 0) return false;
  const blob = JSON.stringify(so);
  if (/원본 로그가 첨부되지\s*않|로그가 첨부되지\s*않/.test(blob)) return false;
  return true;
}

function runClaudeCli(args, stdinText) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(CLI_BIN, args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`timeout ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function extractUsage(envelope) {
  const usage = envelope?.usage && typeof envelope.usage === 'object' ? envelope.usage : {};
  const modelUsage = envelope?.modelUsage && typeof envelope.modelUsage === 'object' ? envelope.modelUsage : {};
  const firstModel = Object.values(modelUsage)[0] || {};
  const thinking =
    usage.output_tokens_details?.thinking_tokens ??
    usage.thinking_tokens ??
    firstModel.thinkingTokens ??
    firstModel.thinking_tokens ??
    null;
  return {
    input_tokens: usage.input_tokens ?? firstModel.inputTokens ?? null,
    output_tokens: usage.output_tokens ?? firstModel.outputTokens ?? null,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? firstModel.cacheCreationInputTokens ?? null,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? firstModel.cacheReadInputTokens ?? null,
    thinking_tokens: thinking,
    usage_keys: Object.keys(usage),
    modelUsage_keys: Object.keys(firstModel)
  };
}

function summarizeEnvelope(envelope, wallMs) {
  const usage = extractUsage(envelope);
  const so = envelope?.structured_output;
  let soSummary = null;
  if (so && typeof so === 'object') {
    soSummary = {
      keys: Object.keys(so),
      anomalyWindows: Array.isArray(so.anomalyWindows) ? so.anomalyWindows.length : undefined,
      hypotheses: Array.isArray(so.hypotheses) ? so.hypotheses.length : undefined,
      hasReport: Boolean(so.report),
      hasEmail: Boolean(so.email)
    };
  }
  return {
    wall_ms: wallMs,
    wall_s: Math.round(wallMs / 100) / 10,
    duration_ms: envelope?.duration_ms ?? null,
    duration_api_ms: envelope?.duration_api_ms ?? null,
    is_error: envelope?.is_error ?? null,
    subtype: envelope?.subtype ?? null,
    stop_reason: envelope?.stop_reason ?? envelope?.stopReason ?? null,
    has_structured_output: Boolean(so),
    structured_output_summary: soSummary,
    ...usage
  };
}

async function callStage({ stage, effort, prompt, label, outDir }) {
  const tool = TOOLS[stage];
  if (!tool) throw new Error(`unknown stage ${stage}`);
  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(tool.input_schema),
    '--model', process.env.ANTHROPIC_MODEL || 'sonnet',
    '--allowedTools', '',
    '--disable-slash-commands',
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence'
  ];
  if (effort) args.push('--effort', effort);
  args.push('--system-prompt', PERSONA);

  const destDir = outDir || OUT_DIR;
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });

  const started = Date.now();
  const stamp = new Date(started).toISOString().replace(/[:.]/g, '-');
  const base = label || `${stage}-${effort || 'default'}-${stamp}`;
  console.log(`[start] ${base}  timeout=${CLI_TIMEOUT_MS}ms`);

  let stdout, stderr, code;
  try {
    ({ stdout, stderr, code } = await runClaudeCli(args, prompt));
  } catch (e) {
    const rec = { ok: false, error: String(e), wall_ms: Date.now() - started, stage, effort, label: base };
    const p = path.join(RAW_DIR, `${base}.error.json`);
    fs.writeFileSync(p, JSON.stringify(rec, null, 2));
    console.error(`[error] ${base}  ${e.message}`);
    return rec;
  }
  const wallMs = Date.now() - started;
  fs.writeFileSync(path.join(RAW_DIR, `${base}.stdout.txt`), stdout);
  if (stderr) fs.writeFileSync(path.join(RAW_DIR, `${base}.stderr.txt`), stderr);

  let envelope = null;
  try {
    envelope = JSON.parse(stdout);
  } catch (e) {
    const rec = { ok: false, error: `json parse: ${e.message}`, wall_ms: wallMs, code, stage, effort, label: base };
    fs.writeFileSync(path.join(RAW_DIR, `${base}.error.json`), JSON.stringify(rec, null, 2));
    console.error(`[parse-fail] ${base}  ${e.message}`);
    return rec;
  }

  const summary = summarizeEnvelope(envelope, wallMs);
  const rec = { ok: !envelope.is_error && envelope.subtype === 'success' && Boolean(envelope.structured_output), stage, effort, label: base, code, summary };
  fs.writeFileSync(path.join(RAW_DIR, `${base}.summary.json`), JSON.stringify({ ...rec, usage_raw: envelope.usage || null, modelUsage: envelope.modelUsage || null }, null, 2));
  if (envelope.structured_output) {
    fs.writeFileSync(path.join(destDir, `${base}.structured.json`), JSON.stringify(envelope.structured_output, null, 2));
  }
  // Keep a stripped envelope (no huge result string) for later inspection.
  const stripped = { ...envelope, result: typeof envelope.result === 'string' ? `[len ${envelope.result.length}]` : envelope.result };
  fs.writeFileSync(path.join(RAW_DIR, `${base}.envelope.json`), JSON.stringify(stripped, null, 2));

  console.log(`[done] ${base}  wall=${summary.wall_s}s  out=${summary.output_tokens}  think=${summary.thinking_tokens}  so=${summary.has_structured_output}  err=${summary.is_error}  windows=${summary.structured_output_summary?.anomalyWindows ?? '-'}  hyp=${summary.structured_output_summary?.hypotheses ?? '-'}`);
  return { ...rec, structured_output: envelope.structured_output || null };
}

function hypothesesPromptFromDetect(so) {
  return buildHypothesesPrompt({
    issueStructured: so.issueStructured,
    anomalyWindows: so.anomalyWindows,
    priorCase: '없음',
    referenceDocsText: '',
    sourceProfiles: [{
      sourceFile: 'data_sys_6_stride80.csv',
      formatId: 'lfp-cell-array',
      formatLabel: 'LFP cell-array',
      derivedAlarmCount: 9366
    }],
    sourceFormats: ['lfp-cell-array']
  });
}

function draftPromptFromDetectAndHyp(detectSo, hypSo) {
  const confirmedHyp = Array.isArray(hypSo?.hypotheses) ? hypSo.hypotheses[0] : hypSo;
  return buildDraftReportPrompt({
    issueStructured: detectSo.issueStructured,
    anomalyWindows: detectSo.anomalyWindows,
    confirmedHyp,
    finalSeverity: confirmedHyp?.severityDraft || '중',
    finalSeverityReason: confirmedHyp?.severityReason || '측정용 초안',
    sourceProfiles: [{
      sourceFile: 'data_sys_6_stride80.csv',
      formatId: 'lfp-cell-array',
      formatLabel: 'LFP cell-array',
      derivedAlarmCount: 9366
    }],
    sourceFormats: ['lfp-cell-array'],
    figureCatalog: [
      { id: 'B-F1', available: true, claim: 'Cell 8 경로의 유효 직렬저항이 동료 셀과 분리된다' },
      { id: 'B-F3', available: true, claim: 'Cell 전압 분산이 장기적으로 확대되는가 (전압 잔차 — 저항이 아님)' },
      { id: 'B-F5', available: false, unavailableReason: 'GP/BattGP는 이번 범위에서 미구현 — Unknown으로 남깁니다' }
    ],
    evidenceLedger: []
  });
}

async function runEffortSuite({ prompt, outDir, prefix } = {}) {
  // Interleave levels so cache-warmup from the first call does not land
  // entirely on one effort bucket (the original n=1 table had this bias).
  const levels = ['low', 'medium', 'high'];
  const results = [];
  const promptText = prompt || DETECT_PROMPT;
  const destDir = outDir || OUT_DIR;
  const labelPrefix = prefix || 'detect-anomaly';
  for (let i = 1; i <= 3; i++) {
    for (const effort of levels) {
      const rec = await callStage({
        stage: 'detect-anomaly',
        effort,
        prompt: promptText,
        label: `${labelPrefix}-${effort}-${i}`,
        outDir: destDir
      });
      rec.validDetect = isValidDetectResult(rec.structured_output);
      results.push(rec);
      fs.writeFileSync(path.join(destDir, 'effort-progress.json'), JSON.stringify(results.map(r => ({
        label: r.label, ok: r.ok, validDetect: r.validDetect, summary: r.summary
      })), null, 2));
    }
  }
  return results;
}

async function runStageSuite(fromDetectPath) {
  let detectSo;
  if (fromDetectPath) {
    const raw = JSON.parse(fs.readFileSync(fromDetectPath, 'utf8'));
    detectSo = raw.structured_output || raw;
  } else {
    const rec = await callStage({
      stage: 'detect-anomaly',
      effort: null,
      prompt: DETECT_PROMPT,
      label: 'stage-detect-anomaly-1'
    });
    if (!rec.structured_output) throw new Error('detect-anomaly produced no structured_output');
    detectSo = rec.structured_output;
  }
  const hyp = await callStage({
    stage: 'generate-hypotheses',
    effort: null,
    prompt: hypothesesPromptFromDetect(detectSo),
    label: 'stage-generate-hypotheses-1'
  });
  if (!hyp.structured_output) throw new Error('generate-hypotheses produced no structured_output');
  const draft = await callStage({
    stage: 'draft-report',
    effort: null,
    prompt: draftPromptFromDetectAndHyp(detectSo, hyp.structured_output),
    label: 'stage-draft-report-1'
  });
  return { hyp, draft };
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

if (args.suite === 'effort-real') {
  const csvPath = path.resolve(args.realCsv || path.join(ROOT, 'Log_sample/extracted/data_sys_6_stride80.csv'));
  console.log(`[prompt] building real detect prompt from ${csvPath}`);
  const built = buildRealDetectPrompt(csvPath);
  fs.mkdirSync(REAL_OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REAL_OUT_DIR, 'detect-anomaly-real-prompt.txt'), built.prompt);
  fs.writeFileSync(path.join(REAL_OUT_DIR, 'detect-anomaly-real-prompt.meta.json'), JSON.stringify({
    csvPath, promptChars: built.promptChars, totalRows: built.totalRows,
    sourceCount: built.sourceCount, derivedAlarmCount: built.derivedAlarmCount
  }, null, 2));
  console.log(`[prompt] ${built.promptChars} chars, rows=${built.totalRows}, derivedAlarms=${built.derivedAlarmCount}`);

  const results = await runEffortSuite({
    prompt: built.prompt,
    outDir: REAL_OUT_DIR,
    prefix: 'real-detect'
  });
  const valid = results.filter(r => r.validDetect);
  const excluded = results.filter(r => !r.validDetect);
  const byEffort = {};
  for (const effort of ['low', 'medium', 'high']) {
    const runs = valid.filter(r => r.effort === effort);
    const walls = runs.map(r => r.summary?.wall_s).filter(n => Number.isFinite(n));
    byEffort[effort] = {
      valid: runs.length,
      excluded: results.filter(r => r.effort === effort && !r.validDetect).length,
      wall_s: walls,
      mean_s: walls.length ? Math.round((walls.reduce((a, b) => a + b, 0) / walls.length) * 10) / 10 : null
    };
  }
  const suite = {
    promptChars: built.promptChars,
    totalRows: built.totalRows,
    derivedAlarmCount: built.derivedAlarmCount,
    n_attempted: results.length,
    n_valid: valid.length,
    n_excluded: excluded.length,
    excluded_labels: excluded.map(r => ({
      label: r.label,
      ok: r.ok,
      windows: r.summary?.structured_output_summary?.anomalyWindows ?? 0,
      is_error: r.summary?.is_error,
      error: r.error || null
    })),
    byEffort,
    runs: results.map(r => ({
      label: r.label, ok: r.ok, validDetect: r.validDetect, effort: r.effort, summary: r.summary
    }))
  };
  fs.writeFileSync(path.join(REAL_OUT_DIR, 'effort-suite.json'), JSON.stringify(suite, null, 2));
  console.log(`[suite] valid=${valid.length}/${results.length} excluded=${excluded.length}`);

  const pick = valid.find(r => r.label.includes('-high-')) || valid[0];
  if (pick?.structured_output) {
    console.log(`[hypotheses] chaining from ${pick.label}`);
    try {
      const hyp = await callStage({
        stage: 'generate-hypotheses',
        effort: null,
        prompt: hypothesesPromptFromDetect(pick.structured_output),
        label: 'real-generate-hypotheses-1',
        outDir: REAL_OUT_DIR
      });
      fs.writeFileSync(path.join(REAL_OUT_DIR, 'generate-hypotheses.json'), JSON.stringify({
        ok: hyp.ok, summary: hyp.summary, error: hyp.error || null
      }, null, 2));
      if (/429|session limit|rate limit/i.test(JSON.stringify(hyp))) {
        console.log('[hypotheses] 429 or session limit — recorded, not retried');
      }
    } catch (e) {
      const msg = String(e);
      fs.writeFileSync(path.join(REAL_OUT_DIR, 'generate-hypotheses.json'), JSON.stringify({ ok: false, error: msg }, null, 2));
      console.log(`[hypotheses] failed: ${msg}`);
    }
  } else {
    console.log('[hypotheses] skipped — no valid detect-anomaly structured_output');
  }
  process.exit(0);
} else if (args.suite === 'effort' || args.suite === 'all') {
  const results = await runEffortSuite();
  fs.writeFileSync(path.join(RAW_DIR, 'effort-suite.json'), JSON.stringify(results.map(r => ({ label: r.label, ok: r.ok, summary: r.summary })), null, 2));
  if (args.suite === 'effort') process.exit(results.every(r => r.ok) ? 0 : 1);
  const pick = results.find(r => r.ok && r.structured_output && r.label.includes('-high-'))
    || results.find(r => r.ok && r.structured_output);
  if (!pick) {
    console.error('no successful detect-anomaly structured_output to chain stages');
    process.exit(1);
  }
  const detectPath = path.join(OUT_DIR, `${pick.label}.structured.json`);
  const out = await runStageSuite(detectPath);
  fs.writeFileSync(path.join(RAW_DIR, 'stage-suite.json'), JSON.stringify({
    from: pick.label,
    hyp: { ok: out.hyp.ok, summary: out.hyp.summary },
    draft: { ok: out.draft.ok, summary: out.draft.summary }
  }, null, 2));
  process.exit(results.every(r => r.ok) && out.hyp.ok && out.draft.ok ? 0 : 1);
} else if (args.suite === 'stages') {
  const out = await runStageSuite(args.fromDetect);
  fs.writeFileSync(path.join(RAW_DIR, 'stage-suite.json'), JSON.stringify({
    hyp: { ok: out.hyp.ok, summary: out.hyp.summary },
    draft: { ok: out.draft.ok, summary: out.draft.summary }
  }, null, 2));
  process.exit(out.hyp.ok && out.draft.ok ? 0 : 1);
} else {
  const rec = await callStage({
    stage: args.stage,
    effort: args.effort,
    prompt: DETECT_PROMPT,
    label: args.label
  });
  process.exit(rec.ok ? 0 : 1);
}
