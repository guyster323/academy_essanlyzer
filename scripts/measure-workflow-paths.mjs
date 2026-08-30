/**
 * Task A: measure the two user-facing workflow paths, per-step wall clock.
 *
 *   node scripts/measure-workflow-paths.mjs --path sample
 *   node scripts/measure-workflow-paths.mjs --path caseb
 *   node scripts/measure-workflow-paths.mjs --path all
 *
 * Hits the production HTTP API (same routes the UI uses). Does not re-run
 * Case B detect-anomaly — those numbers already exist. Stops a path on 429
 * without retrying.
 */
import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SAMPLE_CS, SAMPLE_CSV, SAMPLE_PRIOR } from '../src/state.js';
import { makeAccumulator, feedLine, applyAccumulatorToSource } from '../src/log-engine.js';
import { detectFormat } from '../src/formats.js';
import { blocksToPromptText } from '../src/pipeline.js';
import { buildFigures, figureCatalog } from '../src/figures.js';
import { detectAttributionConflict } from '../src/attribution-conflict.js';
import { buildEvidenceLedger, catalogEvidence } from '../src/evidence-ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'workflow-timing-runs');
const CASE_B_CSV = path.join(ROOT, 'Log_sample', 'extracted', 'data_sys_6_stride80.csv');
const CASE_B_DETECT = path.join(ROOT, 'Report', 'latency-effort-real-outputs', 'real-detect-medium-1.structured.json');

const API_BASE = process.env.WORKFLOW_API_BASE || 'http://127.0.0.1:3011';
const FETCH_TIMEOUT_MS = Number(process.env.WORKFLOW_FETCH_TIMEOUT_MS) || 2_100_000; // 35 min

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Connection: 'close'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    const timer = setTimeout(() => fail(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
    req.on('error', (e) => fail(e));
    req.write(payload);
    req.end();
  });
}

function parseArgs(argv) {
  let which = 'all';
  let resumeDetect = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') which = argv[++i];
    else if (argv[i] === '--resume-detect') resumeDetect = argv[++i];
  }
  if (!['sample', 'caseb', 'all'].includes(which)) throw new Error(`unknown --path ${which}`);
  return { path: which, resumeDetect };
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(path.join(OUT_DIR, 'console.log'), line + '\n');
}

function writeJson(name, value) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}

function accumulateText(text, label) {
  const lines = text.split(/\r?\n/);
  const first = lines.filter(l => l.trim()).slice(0, 4);
  const format = detectFormat(first);
  const acc = makeAccumulator(format);
  for (const line of lines) {
    if (line.trim()) feedLine(acc, line);
  }
  const src = { name: label };
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

function slimCatalog(catalog) {
  return (catalog || []).map(fig => {
    const stats = fig.summaryStats && typeof fig.summaryStats === 'object' ? fig.summaryStats : {};
    const slimStats = {};
    for (const [k, v] of Object.entries(stats)) {
      if (Array.isArray(v) || (v && typeof v === 'object' && !Number.isFinite(v) && typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean' && v !== null)) {
        continue;
      }
      slimStats[k] = v;
    }
    return {
      id: fig.id,
      claim: fig.claim,
      available: Boolean(fig.available),
      unavailableReason: fig.unavailableReason || '',
      evidenceTier: fig.evidenceTier || 'Derived',
      summaryStats: slimStats
    };
  });
}

function extrasFromBlock(block) {
  let figureSpecs = [];
  let attributionConflict = null;
  let evidenceLedger = [];
  try {
    figureSpecs = buildFigures([block]);
  } catch (e) {
    log(`figure build failed: ${e.message}`);
  }
  try {
    attributionConflict = detectAttributionConflict({ blocks: [block], figures: figureSpecs });
  } catch (e) {
    log(`attribution conflict failed: ${e.message}`);
  }
  try {
    const af4 = (figureSpecs || []).find(f => f.id === 'A-F4');
    evidenceLedger = buildEvidenceLedger({
      blocks: [block],
      figures: figureSpecs,
      anomalyWindows: [],
      commonMode: af4 ? af4.summaryStats : null
    });
  } catch (e) {
    log(`evidence ledger failed: ${e.message}`);
  }
  return {
    figureCatalog: slimCatalog(figureCatalog(figureSpecs)),
    attributionConflict,
    evidenceLedger: catalogEvidence(evidenceLedger || [])
  };
}

async function postStage(stage, body) {
  const url = `${API_BASE}/api/${stage}`;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  log(`[start] ${stage}  POST ${url}`);
  let status = 0;
  let json = null;
  let text = '';
  let error = null;
  try {
    const res = await postJson(url, body, FETCH_TIMEOUT_MS);
    status = res.status;
    text = res.text;
    try { json = JSON.parse(text); } catch { json = null; }
  } catch (e) {
    error = String(e);
  }
  const wallMs = Date.now() - started;
  const rec = {
    stage,
    startedAt,
    finishedAt: new Date().toISOString(),
    wall_ms: wallMs,
    wall_s: Math.round(wallMs / 100) / 10,
    http_status: status,
    ok: status === 200 && json && !json.error,
    error: error || json?.error || (status && status !== 200 ? `HTTP ${status}` : null),
    body_chars: JSON.stringify(body).length,
    response_chars: text.length
  };
  const is429 = status === 429 || /spend limit|rate.?limit|429/i.test(String(rec.error || '') + text.slice(0, 500));
  rec.is_429 = is429;
  const stamp = startedAt.replace(/[:.]/g, '-');
  writeJson(`${stage}-${stamp}.request-meta.json`, {
    ...rec,
    response_preview: text.slice(0, 2000)
  });
  if (json) writeJson(`${stage}-${stamp}.response.json`, json);
  log(`[done] ${stage}  wall=${rec.wall_s}s  status=${status}  ok=${rec.ok}  429=${is429}  err=${rec.error || '-'}`);
  return { ...rec, json };
}

function pickConfirmedHyp(hypotheses) {
  const h = hypotheses[0];
  return {
    name: h.name,
    domain: h.domain,
    expectedSignature: h.expectedSignature,
    actualObservation: h.actualObservation,
    evidence: h.evidence,
    evidenceTier: h.evidenceTier || 'Inferred',
    disconfirmingEvidence: h.disconfirmingEvidence,
    missingSignals: h.missingSignals,
    claimLimit: h.claimLimit
  };
}

async function measureSample(resumeDetectPath) {
  log('=== SAMPLE PATH (GETTING_STARTED pasted sample, 10 rows) ===');
  const block = accumulateText(SAMPLE_CSV, '직접 붙여넣은 텍스트');
  const built = blocksToPromptText([block]);
  const extras = extrasFromBlock(block);
  const promptMeta = {
    path: 'sample',
    label: block.label,
    formatId: block.formatId,
    rowCount: block.rowCount,
    alarmCount: block.alarmCount,
    promptChars: built.text.length,
    totalRows: built.totalRows,
    sourceCount: built.count,
    sourceProfiles: built.sourceProfiles,
    figureCatalogIds: extras.figureCatalog.map(f => `${f.id}:${f.available}`),
    attributionConflictStatus: extras.attributionConflict?.status || null
  };
  writeJson('sample-prompt-meta.json', promptMeta);
  log(`sample prompt ${promptMeta.promptChars} chars, rows=${promptMeta.rowCount}, format=${promptMeta.formatId}`);

  let detect;
  if (resumeDetectPath) {
    const saved = JSON.parse(fs.readFileSync(resumeDetectPath, 'utf8'));
    log(`resuming sample from saved detect ${resumeDetectPath}`);
    detect = {
      stage: 'detect-anomaly',
      ok: true,
      reused: true,
      reusedFrom: resumeDetectPath,
      json: saved,
      wall_s: null,
      wall_ms: 0,
      http_status: 200,
      is_429: false,
      error: null
    };
  } else {
    detect = await postStage('detect-anomaly', {
      csText: SAMPLE_CS,
      priorCase: SAMPLE_PRIOR,
      combinedLogText: built.text,
      totalRows: built.totalRows,
      sourceCount: built.count,
      sourceProfiles: built.sourceProfiles
    });
  }
  if (!detect.ok) return { path: 'sample', promptMeta, stages: { detect }, stopped: detect.is_429 ? '429' : 'detect-failed' };

  const hyp = await postStage('generate-hypotheses', {
    issueStructured: detect.json.issueStructured,
    anomalyWindows: detect.json.anomalyWindows,
    priorCase: SAMPLE_PRIOR,
    referenceDocsText: '',
    sourceProfiles: built.sourceProfiles
  });
  if (!hyp.ok) return { path: 'sample', promptMeta, stages: { detect, hyp }, stopped: hyp.is_429 ? '429' : 'hyp-failed' };

  const hypotheses = hyp.json.hypotheses || [];
  const confirmedHyp = pickConfirmedHyp(hypotheses);
  const chosen = hypotheses[0];
  const humanReview = {
    note: 'Simulated engineer accepting the first AI hypothesis and its severityDraft. Not an AI call.',
    selectedId: chosen.id,
    finalSeverity: chosen.severityDraft,
    finalSeverityReason: chosen.severityReason
  };

  const draft = await postStage('draft-report', {
    issueStructured: detect.json.issueStructured,
    anomalyWindows: detect.json.anomalyWindows,
    confirmedHyp,
    finalSeverity: chosen.severityDraft,
    finalSeverityReason: chosen.severityReason,
    sourceProfiles: built.sourceProfiles,
    figureCatalog: extras.figureCatalog,
    evidenceLedger: extras.evidenceLedger
  });
  const stages = { detect, hyp, draft };
  const aiTotalMs = detect.wall_ms + hyp.wall_ms + draft.wall_ms;
  return {
    path: 'sample',
    promptMeta,
    humanReview,
    stages,
    ai_total_ms: aiTotalMs,
    ai_total_s: Math.round(aiTotalMs / 100) / 10,
    stopped: draft.ok ? null : (draft.is_429 ? '429' : 'draft-failed')
  };
}

async function measureCaseB() {
  log('=== CASE B PATH (generate-hypotheses + draft-report only; detect-anomaly not re-run) ===');
  if (!fs.existsSync(CASE_B_DETECT)) throw new Error(`missing ${CASE_B_DETECT}`);
  const detectSo = JSON.parse(fs.readFileSync(CASE_B_DETECT, 'utf8'));
  const detectMeta = {
    reusedFrom: 'Report/latency-effort-real-outputs/real-detect-medium-1.structured.json',
    reusedWall_s: 707.8,
    reusedLabel: 'real-detect-medium-1',
    note: 'Previously measured this session family, not re-measured today'
  };

  let block = null;
  let extras = { figureCatalog: [], attributionConflict: undefined, evidenceLedger: [] };
  let sourceProfiles = [{
    sourceFile: 'data_sys_6_stride80.csv',
    formatId: 'lfp-cell-array',
    formatLabel: 'LFP cell-array',
    entityColumn: null,
    rowCount: 240603,
    derivedAlarmCount: 9366
  }];
  if (fs.existsSync(CASE_B_CSV)) {
    log('accumulating Case B CSV for sourceProfiles / figures / conflict');
    const t0 = Date.now();
    block = accumulateText(fs.readFileSync(CASE_B_CSV, 'utf8'), 'data_sys_6_stride80.csv');
    const built = blocksToPromptText([block]);
    sourceProfiles = built.sourceProfiles;
    extras = extrasFromBlock(block);
    extras.evidenceLedger = catalogEvidence(buildEvidenceLedger({
      blocks: [block],
      figures: extras.figureCatalog.length ? undefined : [],
      anomalyWindows: detectSo.anomalyWindows,
      commonMode: null
    }));
    // Rebuild ledger with real figures if we have the block.
    try {
      const figureSpecs = buildFigures([block]);
      extras.figureCatalog = slimCatalog(figureCatalog(figureSpecs));
      extras.attributionConflict = detectAttributionConflict({ blocks: [block], figures: figureSpecs });
      extras.evidenceLedger = catalogEvidence(buildEvidenceLedger({
        blocks: [block],
        figures: figureSpecs,
        anomalyWindows: detectSo.anomalyWindows,
        commonMode: null
      }));
    } catch (e) {
      log(`case B extras rebuild failed: ${e.message}`);
    }
    log(`case B accumulate+figures wall=${((Date.now() - t0) / 1000).toFixed(1)}s  conflict=${extras.attributionConflict?.status || '-'}  figures=${extras.figureCatalog.length}`);
  }

  writeJson('caseb-request-meta.json', {
    detectMeta,
    sourceProfiles,
    figureCatalogIds: extras.figureCatalog.map(f => `${f.id}:${f.available}`),
    attributionConflict: extras.attributionConflict || null,
    anomalyWindowCount: detectSo.anomalyWindows?.length || 0
  });

  const hyp = await postStage('generate-hypotheses', {
    issueStructured: detectSo.issueStructured,
    anomalyWindows: detectSo.anomalyWindows,
    priorCase: '없음',
    referenceDocsText: '',
    sourceProfiles
  });
  if (!hyp.ok) {
    return {
      path: 'caseb',
      detectMeta,
      stages: { hyp },
      stopped: hyp.is_429 ? '429' : 'hyp-failed'
    };
  }

  const hypotheses = hyp.json.hypotheses || [];
  const confirmedHyp = pickConfirmedHyp(hypotheses);
  const chosen = hypotheses[0];
  const humanReview = {
    note: 'Simulated engineer selecting the first hypothesis. Severity taken from severityDraft.',
    selectedId: chosen.id,
    finalSeverity: chosen.severityDraft,
    finalSeverityReason: chosen.severityReason
  };

  const draftBody = {
    issueStructured: detectSo.issueStructured,
    anomalyWindows: detectSo.anomalyWindows,
    confirmedHyp,
    finalSeverity: chosen.severityDraft,
    finalSeverityReason: chosen.severityReason,
    sourceProfiles,
    figureCatalog: extras.figureCatalog,
    evidenceLedger: extras.evidenceLedger
  };
  if (extras.attributionConflict) draftBody.attributionConflict = extras.attributionConflict;

  const draft = await postStage('draft-report', draftBody);
  return {
    path: 'caseb',
    detectMeta,
    humanReview,
    attributionConflict: extras.attributionConflict || null,
    stages: { hyp, draft },
    stopped: draft.ok ? null : (draft.is_429 ? '429' : 'draft-failed')
  };
}

const args = parseArgs(process.argv.slice(2));
fs.mkdirSync(OUT_DIR, { recursive: true });
const summary = {
  startedAt: new Date().toISOString(),
  apiBase: API_BASE,
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  which: args.path,
  sample: null,
  caseb: null
};
writeJson('progress.json', summary);

try {
  const ping = await postJson(`${API_BASE}/api/detect-anomaly`, { _ping: true }, 5_000);
  log(`api ping status=${ping.status} (400 from validation is healthy)`);
} catch (e) {
  log(`FATAL: cannot reach ${API_BASE}: ${e.message}`);
  process.exit(1);
}

if (args.path === 'sample' || args.path === 'all') {
  summary.sample = await measureSample(args.resumeDetect);
  summary.updatedAt = new Date().toISOString();
  writeJson('progress.json', summary);
  writeJson('sample-result.json', summary.sample);
}

if (args.path === 'caseb' || args.path === 'all') {
  const sampleBlocked = summary.sample?.stopped === '429';
  if (sampleBlocked) {
    log('sample path hit 429; still attempting Case B remaining stages once, then stopping');
  }
  summary.caseb = await measureCaseB();
  summary.updatedAt = new Date().toISOString();
  writeJson('progress.json', summary);
  writeJson('caseb-result.json', summary.caseb);
}

summary.finishedAt = new Date().toISOString();
writeJson('progress.json', summary);
writeJson('summary.json', summary);
log(`ALL DONE stopped.sample=${summary.sample?.stopped || '-'} stopped.caseb=${summary.caseb?.stopped || '-'}`);
const failed = Boolean(summary.sample?.stopped || summary.caseb?.stopped);
process.exit(failed ? 2 : 0);
