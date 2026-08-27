import { state, session, resetState, isHumanReviewComplete, CS_TEMPLATES, SAMPLE_CS, SAMPLE_CSV, SAMPLE_PRIOR } from './state.js';
import { render, showToast, copyText, refreshConfirmButtonState, refreshCompleteButtonState } from './render.js';
import { detectIssuesApi, detectAnomalyApi, generateHypothesesApi, draftReportApi } from './api.js';
import {
  CONTEXT_WINDOW, avgOf, makeAccumulator, feedLine,
  MAX_SELECTED_SOURCES, MAX_GROUPS_PER_SOURCE_IN_PROMPT, MAX_TOTAL_ALARM_CONTEXTS, MAX_LOG_TEXT_CHARS
} from './log-engine.js';
import { GENERIC_FORMAT, detectDelimiter } from './formats.js';
import JSZip from 'jszip';
import { extractHtmlText, extractPptxText, capDocText, buildReferenceDocsBlock } from './reference-docs.js';

/* =========================================================
   LOG BLOCK COLLECTION — turns selected sources (+ optional pasted text)
   into prompt-ready text blocks. Bounded regardless of source file size:
   stats/head-sample/alarm-context caps are enforced upstream in
   log-engine.js, and entity-group caps are enforced here.
========================================================= */
export function collectActiveLogBlocks() {
  const pastedEl = document.getElementById('inputCsv');
  const pastedText = (pastedEl ? pastedEl.value : state.csvText || '').trim();
  state.csvText = pastedText;

  const activeSources = state.logSources.filter(s => s.selected && s.status === 'ready');
  let pastedSummary = null;
  if (pastedText) {
    const acc = makeAccumulator(GENERIC_FORMAT);
    pastedText.split(/\r?\n/).forEach(line => { if (line.trim()) feedLine(acc, line); });
    pastedSummary = {
      label: '직접 붙여넣은 텍스트', columns: acc.columns || [], delimiter: acc.delimiter || ',',
      rowCount: acc.rowCount, alarmCount: acc.alarmCount, headSample: acc.headSample,
      alarmSamples: acc.alarmSamples, stats: acc.stats, groups: null
    };
  }

  return activeSources.map(s => ({
    label: s.path, columns: s.columns, delimiter: s.delimiter,
    rowCount: s.rowCount, alarmCount: s.alarmCount, headSample: s.headSample,
    alarmSamples: s.alarmSamples, stats: s.stats, groups: s.groups
  })).concat(pastedSummary ? [pastedSummary] : []);
}

// alarmBudget: how many more alarm-context windows this call is allowed to
// render (a running total shared across the whole request — see
// blocksToPromptText). Returns how many it actually used/had available so
// the caller can track the budget and report what got left out.
function renderFlatBlock(block, alarmBudget) {
  const d = block.delimiter || ',';
  const statsText = Object.entries(block.stats).map(([k, v]) => `  - ${k}: min=${v.min}, max=${v.max}, avg=${avgOf(v)}`).join('\n') || '  (수치 컬럼 없음)';
  const headText = block.headSample.map(r => block.columns.map(c => r[c]).join(d)).join('\n') || '  (없음)';
  const available = block.alarmSamples.length;
  const used = Math.max(0, Math.min(available, alarmBudget));
  const shown = block.alarmSamples.slice(0, used);
  const alarmCtxText = shown.length
    ? shown.map((win, i) => `  [알람#${i + 1}]\n` + win.map(r => '   ' + block.columns.map(c => r[c]).join(d)).join('\n')).join('\n')
    : (available ? '  (요청 전체 알람 컨텍스트 예산 초과로 이 출처 분은 생략됨)' : '  (알람 코드 발생 행 없음)');
  const text = `### 출처 파일: ${block.label}
- 총 행 수(스트리밍 집계): ${block.rowCount} / 알람·이상코드 발생 행: ${block.alarmCount}건 / 컬럼: ${block.columns.join(', ')}
- 수치 컬럼 통계 (전체 행 기준 running min/max/avg):
${statsText}
- 파일 시작부 샘플:
${d}${block.columns.join(d)}
${headText}
- 알람 발생 전후 컨텍스트 (이번 요청에 포함 ${used}건 / 감지 ${available}건, 각 최대 ${CONTEXT_WINDOW}행):
${alarmCtxText}`;
  return { text, used, available };
}

function renderGroupedBlock(src, alarmBudget) {
  const entries = Object.entries(src.groups);
  const sorted = entries.sort((a, b) => (b[1].alarmCount - a[1].alarmCount) || (b[1].rowCount - a[1].rowCount));
  const top = sorted.slice(0, MAX_GROUPS_PER_SOURCE_IN_PROMPT);
  const rest = sorted.slice(MAX_GROUPS_PER_SOURCE_IN_PROMPT);
  const restRowSum = rest.reduce((a, [, g]) => a + g.rowCount, 0);
  const restAlarmSum = rest.reduce((a, [, g]) => a + g.alarmCount, 0);

  const entityHeader = `### 출처 파일: ${src.label} (엔티티별 그룹 집계 · 총 ${entries.length}개 엔티티${rest.length ? `, 상위 ${top.length}개만 상세 표시` : ''})`;
  let remainingBudget = alarmBudget;
  let used = 0;
  let available = 0;
  const groupBlocks = top.map(([entityValue, g]) => {
    const r = renderFlatBlock({ ...g, label: `${src.label} · 엔티티 ${entityValue}`, delimiter: src.delimiter, columns: src.columns }, remainingBudget);
    remainingBudget -= r.used;
    used += r.used;
    available += r.available;
    return r.text;
  });
  const restNote = rest.length
    ? `\n(기타 ${rest.length}개 엔티티 상세 생략 — 합계 ${restRowSum}행, 알람 ${restAlarmSum}건)`
    : '';
  return { text: [entityHeader, ...groupBlocks].join('\n\n') + restNote, groupsExcluded: rest.length, used, available };
}

/**
 * Builds the AI-facing log text under a hard, non-silent budget:
 * - at most MAX_SELECTED_SOURCES sources
 * - at most MAX_GROUPS_PER_SOURCE_IN_PROMPT entity groups shown in detail per source
 * - at most MAX_TOTAL_ALARM_CONTEXTS alarm-context windows across the ENTIRE request
 * - the final text hard-capped at MAX_LOG_TEXT_CHARS
 * Whatever gets left out is reported in `truncation` (for the UI) and, when
 * anything was cut, prefixed as a note inside the prompt text itself so the
 * model doesn't silently treat a partial view as the complete picture.
 */
export function blocksToPromptText(allBlocks) {
  const truncation = {
    excludedSources: Math.max(0, allBlocks.length - MAX_SELECTED_SOURCES),
    excludedGroups: 0,
    excludedAlarmContexts: 0,
    textTruncatedChars: 0
  };

  const includedBlocks = allBlocks.slice(0, MAX_SELECTED_SOURCES);
  let totalRows = 0;
  let alarmBudget = MAX_TOTAL_ALARM_CONTEXTS;
  let alarmAvailableTotal = 0;
  let alarmUsedTotal = 0;

  const blockTexts = includedBlocks.map(block => {
    totalRows += block.rowCount;
    if (block.groups) {
      const r = renderGroupedBlock(block, alarmBudget);
      alarmBudget -= r.used;
      alarmUsedTotal += r.used;
      alarmAvailableTotal += r.available;
      truncation.excludedGroups += r.groupsExcluded;
      return r.text;
    }
    const r = renderFlatBlock(block, alarmBudget);
    alarmBudget -= r.used;
    alarmUsedTotal += r.used;
    alarmAvailableTotal += r.available;
    return r.text;
  });
  truncation.excludedAlarmContexts = Math.max(0, alarmAvailableTotal - alarmUsedTotal);

  let text = blockTexts.length ? blockTexts.join('\n\n') : '(입력된 로그 데이터 없음)';
  if (text.length > MAX_LOG_TEXT_CHARS) {
    truncation.textTruncatedChars = text.length - MAX_LOG_TEXT_CHARS;
    text = text.slice(0, MAX_LOG_TEXT_CHARS) + '\n...(문자 수 제한으로 이하 생략)';
  }

  const anyTruncation = truncation.excludedSources || truncation.excludedGroups || truncation.excludedAlarmContexts || truncation.textTruncatedChars;
  if (anyTruncation) {
    const parts = [];
    if (truncation.excludedSources) parts.push(`출처 파일 ${truncation.excludedSources}개 미포함`);
    if (truncation.excludedGroups) parts.push(`엔티티 그룹 ${truncation.excludedGroups}개 상세 생략`);
    if (truncation.excludedAlarmContexts) parts.push(`알람 컨텍스트 ${truncation.excludedAlarmContexts}건 생략`);
    if (truncation.textTruncatedChars) parts.push(`텍스트 ${truncation.textTruncatedChars.toLocaleString()}자 절단`);
    text = `[참고: 데이터 규모 제한으로 일부가 생략된 상태입니다 — ${parts.join(', ')}. 생략된 부분에 대한 판단은 "추가 확인 필요"로 명시하십시오.]\n\n${text}`;
  }

  return { text, totalRows, count: includedBlocks.length, truncation };
}

/* =========================================================
   STEP 1 AUTOMATION — detect candidate issues directly from uploaded logs
========================================================= */
let autoDetectTimer = null;

export function scheduleAutoDetect() {
  if (state.step !== 0) return;
  clearTimeout(autoDetectTimer);
  autoDetectTimer = setTimeout(() => {
    if (state.step !== 0) return;
    if (state.issueDetectionStatus === 'loading') return;
    const ta = document.getElementById('inputCsText');
    if (ta && ta.value.trim().length > 0) return; // don't clobber user-entered text
    if (!state.logSources.some(s => s.selected && s.status === 'ready')) return;
    detectIssuesFromLogs();
  }, 700);
}

export async function detectIssuesFromLogs() {
  const allBlocks = collectActiveLogBlocks();
  if (!allBlocks.length) {
    state.issueDetectionStatus = 'idle';
    render();
    return;
  }
  state.issueDetectionStatus = 'loading';
  render();

  const { text: combinedLogText, totalRows, count, truncation } = blocksToPromptText(allBlocks);
  state.lastTruncation = truncation;

  try {
    const json = await detectIssuesApi({ combinedLogText, totalRows, sourceCount: count });
    state.detectedIssues = json.issues || [];
    state.issueDetectionStatus = 'done';
    if (state.detectedIssues.length === 1) {
      selectDetectedIssue(state.detectedIssues[0].id, true);
    }
  } catch (e) {
    console.error(e);
    state.detectedIssues = [];
    state.issueDetectionStatus = 'error';
  }
  render();
}

export function selectDetectedIssue(id, skipRender) {
  const issue = state.detectedIssues.find(i => i.id === id);
  if (!issue) return;
  state.selectedIssueId = id;
  state.csText = issue.description;
  document.getElementById('warnCsText') && document.getElementById('warnCsText').classList.remove('show');
  if (!skipRender) render();
}

/* =========================================================
   PIPELINE STAGES 2-4
========================================================= */
export async function runAnomalyDetection() {
  state.error = null;
  state.loadingLabel = 'CS 의뢰 구조화 및 이상 구간 탐지 중';
  state.phase = 'loading-anomaly';
  state.step = 1;
  render();

  const allBlocks = collectActiveLogBlocks();
  const { text: combinedLogText, totalRows, count, truncation } = blocksToPromptText(allBlocks);
  state.lastTruncation = truncation;

  try {
    const json = await detectAnomalyApi({
      csText: state.csText, priorCase: state.priorCase,
      combinedLogText, totalRows, sourceCount: count
    });
    state.issueStructured = json.issueStructured || {};
    state.anomalyWindows = json.anomalyWindows || [];
    state.step = 1;
    state.phase = 'result-anomaly';
  } catch (e) {
    console.error(e);
    state.error = { stage: 'anomaly', message: e.message || String(e) };
    state.phase = 'idle';
  }
  render();
}

export async function runHypothesisGeneration() {
  state.error = null;
  state.loadingLabel = '이상 구간 패턴 기반 원인 가설 생성 중';
  state.phase = 'loading-hyp';
  state.step = 2;
  render();

  const { text: referenceDocsText } = buildReferenceDocsBlock(state.referenceDocs);

  try {
    const json = await generateHypothesesApi({
      issueStructured: state.issueStructured,
      anomalyWindows: state.anomalyWindows,
      priorCase: state.priorCase,
      referenceDocsText
    });
    state.hypotheses = json.hypotheses || [];
    // Human review checkpoint: nothing is pre-selected. The engineer must
    // explicitly pick (or write) a hypothesis and set severity themselves —
    // see selectHypothesis()/startCustomHypothesis() below.
    state.selectedHypId = null;
    state.confirmedHypothesis = null;
    state.finalSeverity = null;
    state.finalSeverityReason = '';
    state.step = 3;
    state.phase = 'result-hyp';
  } catch (e) {
    console.error(e);
    state.error = { stage: 'hypothesis', message: e.message || String(e) };
    state.phase = 'result-anomaly';
  }
  render();
}

function snapshotState(s) {
  // Drop non-serializable / heavy fields (File handles, JSZip entries, format
  // adapter functions) before the JSON round-trip so history snapshots never
  // throw on circular structures.
  const clone = {
    ...s,
    logSources: s.logSources.map(({ _ref, format, ...rest }) => ({ ...rest }))
  };
  return JSON.parse(JSON.stringify(clone));
}

function upsertCaseHistorySnapshot() {
  const idx = session.caseHistory.findIndex(c => c.id === state.id);
  const snapshot = snapshotState(state);
  if (idx >= 0) session.caseHistory[idx] = snapshot; else session.caseHistory.unshift(snapshot);
}

export async function runReportGeneration() {
  state.error = null;
  state.loadingLabel = '보고서 및 CS 회신 메일 초안 생성 중';
  state.phase = 'loading-report';
  state.step = 4;
  render();

  try {
    const json = await draftReportApi({
      issueStructured: state.issueStructured,
      anomalyWindows: state.anomalyWindows,
      confirmedHyp: state.confirmedHypothesis,
      finalSeverity: state.finalSeverity,
      finalSeverityReason: state.finalSeverityReason
    });
    state.report = json.report || {};
    state.email = json.email || {};
    // Editable working copies — the engineer edits these, never the raw AI
    // draft above, mirroring the confirmedHypothesis pattern from Task 2.
    state.reportEdits = { ...state.report };
    state.emailEdits = { ...state.email };
    state.finalReviewConfirmed = false;
    state.step = 5;
    state.phase = 'result-report';

    upsertCaseHistorySnapshot();
  } catch (e) {
    console.error(e);
    state.error = { stage: 'report', message: e.message || String(e) };
    state.phase = 'result-hyp';
  }
  render();
}

/* =========================================================
   REPORT/EMAIL EDITING — the engineer's edited copy (reportEdits/emailEdits)
   is what gets copied to clipboard and what "완료" locks in, never the raw
   AI draft (report/email). Field updates don't call render() (preserves
   textarea focus/cursor, same pattern as the intake step and Task 2's
   confirmedHypothesis editing).
========================================================= */
export function updateReportField(field, value) {
  if (!state.reportEdits) return;
  state.reportEdits[field] = value;
}

export function updateEmailField(field, value) {
  if (!state.emailEdits) return;
  state.emailEdits[field] = value;
}

export function copyReportText() {
  const r = state.reportEdits || {};
  const text = `[헤드라인] ${r.headline || ''}\n\n[발생 개요]\n${r.occurrence || ''}\n\n[이상 구간 요약]\n${r.anomalySummary || ''}\n\n[확정 원인]\n${r.rootCause || ''}\n\n[심각도] ${state.finalSeverity} — ${state.finalSeverityReason}\n\n[조치 권고]\n${r.actionRecommendation || ''}`;
  copyText(text, '보고서');
}

export function copyEmailText() {
  const e = state.emailEdits || {};
  copyText(`${e.subject || ''}\n\n${e.body || ''}`, '메일 본문');
}

export function onFinalReviewCheckboxChange(checked) {
  state.finalReviewConfirmed = checked;
  refreshCompleteButtonState();
}

export function completeCase() {
  if (!state.finalReviewConfirmed) return; // defense in depth — button should already be disabled
  upsertCaseHistorySnapshot(); // capture the edited report/email + review confirmation, not just the AI draft
  startNewCase();
}

/* =========================================================
   ACTIONS
========================================================= */
export function startNewCase() {
  resetState();
  render();
}

export function loadSample() {
  state.csText = SAMPLE_CS;
  state.csvText = SAMPLE_CSV;
  state.priorCase = SAMPLE_PRIOR;
  render();
}

export function applyCsTemplate(idx) {
  const tmpl = CS_TEMPLATES[idx];
  if (!tmpl) return;
  const ta = document.getElementById('inputCsText');
  if (!ta) return;
  ta.value = tmpl.text;
  state.csText = tmpl.text;
  state.selectedIssueId = null;
  document.getElementById('warnCsText').classList.remove('show');
  ta.focus();
  const match = tmpl.text.match(/\{[^}]+\}/);
  if (match) {
    ta.setSelectionRange(match.index, match.index + match[0].length);
  } else {
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

// Legacy small-input helper retained for the pasted-text path only.
function parseTable(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { columns: [] };
  const delimiter = detectDelimiter(lines[0]);
  const columns = lines[0].split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));
  return { columns };
}

/* =========================================================
   PRIVACY GUARDS — a checkbox confirmation (human judgment) plus a
   pattern scan (mechanical backstop for the obvious cases a regex can
   catch) are both required before any log/CS text leaves the browser.
   Neither substitutes for the other: the checkbox handles judgment calls
   a regex can't, the scan catches blatant leaks even if the box was
   checked carelessly.
========================================================= */
const SENSITIVE_PATTERNS = [
  { label: '이메일 주소', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { label: '전화번호', re: /\b0\d{1,2}-?\d{3,4}-?\d{4}\b/g },
  { label: '고객사/사이트/담당자 레이블', re: /(고객사|고객명|사이트명|담당자)\s*[:：]/g },
  { label: '주소로 추정되는 문자열', re: /[가-힣]+(특별시|광역시|자치시|도)\s?[가-힣]+(시|군|구)\s?[가-힣0-9]+(읍|면|동|로|길)/g }
];

export function detectSensitivePatterns(text) {
  const hits = [];
  for (const { label, re } of SENSITIVE_PATTERNS) {
    const matches = String(text || '').match(re);
    if (matches) hits.push({ label, samples: [...new Set(matches)].slice(0, 3) });
  }
  return hits;
}

export async function handleReferenceDocUpload(evt) {
  const files = Array.from(evt.target.files || []);
  evt.target.value = '';
  for (const file of files) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let rawText;
    try {
      if (ext === 'pptx') {
        rawText = await extractPptxText(JSZip, await file.arrayBuffer());
      } else if (ext === 'html' || ext === 'htm') {
        rawText = extractHtmlText(await file.text());
      } else {
        showToast(`${file.name}: 지원하지 않는 형식 (HTML 또는 PPTX만 가능)`);
        continue;
      }
    } catch (e) {
      console.error(e);
      showToast(`${file.name} 읽기 실패`);
      continue;
    }
    const { text, truncated } = capDocText(rawText);
    state.referenceDocs.push({
      id: 'REF-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: file.name, text, truncated, charCount: text.length
    });
  }
  render();
}

export function removeReferenceDoc(id) {
  state.referenceDocs = state.referenceDocs.filter(d => d.id !== id);
  render();
}

export function submitIntake() {
  const csText = document.getElementById('inputCsText').value.trim();
  const csvText = document.getElementById('inputCsv').value.trim();
  const priorCase = document.getElementById('inputPrior').value.trim();

  if (state.logSources.some(s => s.status === 'processing') || state.zipScanning) {
    showToast('로그 파일 스캔이 아직 진행 중입니다 — 완료 후 다시 시도해 주세요');
    return;
  }

  let hasError = false;

  const sensitiveCheckbox = document.getElementById('sensitiveConfirm');
  state.sensitiveDataConfirmed = !!(sensitiveCheckbox && sensitiveCheckbox.checked);
  if (!state.sensitiveDataConfirmed) {
    document.getElementById('warnSensitiveConfirm').classList.add('show');
    hasError = true;
  } else {
    document.getElementById('warnSensitiveConfirm').classList.remove('show');
  }

  // Mechanical backstop: even with the box checked, an obvious pattern
  // (email, phone, "고객사:" label, address-shaped string) blocks submission
  // — this is never auto-masked, only surfaced for the engineer to edit.
  const referenceText = state.referenceDocs.map(d => d.text).join('\n');
  state.sensitiveHits = detectSensitivePatterns([csText, priorCase, csvText, referenceText].join('\n'));
  if (state.sensitiveHits.length) {
    const listEl = document.getElementById('warnSensitiveHitsList');
    if (listEl) listEl.textContent = state.sensitiveHits.map(h => `${h.label}(예: ${h.samples.join(', ')})`).join('; ');
    document.getElementById('warnSensitiveHits').classList.add('show');
    hasError = true;
  } else {
    document.getElementById('warnSensitiveHits').classList.remove('show');
  }

  if (csText.length < 30) {
    document.getElementById('warnCsText').classList.add('show');
    hasError = true;
  } else {
    document.getElementById('warnCsText').classList.remove('show');
  }

  const selectedSources = state.logSources.filter(s => s.selected);
  const hasPastedTimestamp = csvText.length >= 20 && (() => {
    const { columns } = parseTable(csvText);
    return columns.some(c => /time|date/i.test(c));
  })();
  const hasSelectedTimestamp = selectedSources.some(s => s.columns.some(c => /time|date/i.test(c)));

  if (!selectedSources.length && !hasPastedTimestamp) {
    document.getElementById('warnCsv').classList.add('show');
    hasError = true;
  } else if (selectedSources.length && !hasSelectedTimestamp && !hasPastedTimestamp) {
    document.getElementById('warnCsv').classList.add('show');
    hasError = true;
  } else {
    document.getElementById('warnCsv').classList.remove('show');
  }
  if (hasError) return;

  state.csText = csText;
  state.csvText = csvText;
  state.priorCase = priorCase;
  runAnomalyDetection();
}

// Fields the engineer can edit once a hypothesis is chosen as the basis for
// the confirmed one. severity/severityReason stay separate (own UI section).
const EDITABLE_HYP_FIELDS = ['name', 'domain', 'expectedSignature', 'actualObservation', 'evidence'];

export function selectHypothesis(id) {
  state.selectedHypId = id;
  const h = state.hypotheses.find(x => x.id === id);
  if (h) {
    // Copy into an editable draft — the AI hypothesis object itself is left
    // untouched so its original text stays visible for comparison. Severity
    // is intentionally NOT copied from severityDraft here — the human must
    // set it themselves (the AI draft is still visible as a read-only hint
    // on the card) so the confirm button stays gated on a real action.
    state.confirmedHypothesis = Object.fromEntries(EDITABLE_HYP_FIELDS.map(f => [f, h[f] || '']));
    state.finalSeverity = null;
    state.finalSeverityReason = '';
  }
  render();
}

export function startCustomHypothesis() {
  state.selectedHypId = 'CUSTOM';
  state.confirmedHypothesis = Object.fromEntries(EDITABLE_HYP_FIELDS.map(f => [f, f === 'domain' ? 'Battery/BMS' : '']));
  state.finalSeverity = null;
  state.finalSeverityReason = '';
  render();
}

export function updateConfirmedHypField(field, value) {
  if (!state.confirmedHypothesis || !EDITABLE_HYP_FIELDS.includes(field)) return;
  state.confirmedHypothesis[field] = value;
  refreshConfirmButtonState();
}

export function onSeveritySelectChange(value) {
  state.finalSeverity = value || null;
  refreshConfirmButtonState();
}

export function onSeverityReasonInput(value) {
  state.finalSeverityReason = value;
  refreshConfirmButtonState();
}

export function confirmAndGenerateReport() {
  if (!isHumanReviewComplete()) return; // defense in depth — button should already be disabled
  runReportGeneration();
}

export function loadCaseFromHistory(id) {
  const c = session.caseHistory.find(x => x.id === id);
  if (!c) return;
  Object.assign(state, JSON.parse(JSON.stringify(c)));
  state.readOnly = true;
  session.activeCaseId = id;
  render();
}

export function retryStage(stage) {
  if (stage === 'anomaly') runAnomalyDetection();
  if (stage === 'hypothesis') runHypothesisGeneration();
  if (stage === 'report') runReportGeneration();
}
