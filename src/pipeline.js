import { state, session, resetState, isHumanReviewComplete, CS_TEMPLATES, SAMPLE_CS, SAMPLE_CSV, SAMPLE_PRIOR } from './state.js';
import { render, showToast, copyText, refreshConfirmButtonState, refreshCompleteButtonState } from './render.js';
import { detectIssuesApi, detectAnomalyApi, generateHypothesesApi, draftReportApi, comparePublishedApi } from './api.js';
import {
  CONTEXT_WINDOW, avgOf, makeAccumulator, feedLine, finalizeAccumulator,
  MAX_SELECTED_SOURCES, MAX_GROUPS_PER_SOURCE_IN_PROMPT, MAX_TOTAL_ALARM_CONTEXTS, MAX_LOG_TEXT_CHARS
} from './log-engine.js';
import { detectFormat, detectDelimiter } from './formats.js';
import { freezeSeries } from './series-engine.js';
import { normalizeResistanceEvents, resistanceEventsDroppedCount } from './forensics/lfp.js';
import { buildFigures, figureCatalog } from './figures.js';
import { detectAttributionConflict } from './attribution-conflict.js';
import { buildEvidenceLedger, catalogEvidence } from './evidence-ledger.js';
import JSZip from 'jszip';
import { extractHtmlText, extractPptxText, capDocText, buildReferenceDocsBlock } from './reference-docs.js';
import {
  formatTimeRange, formatCoveragePct, isLowTimeCoverage, buildTimeCoverageNote
} from './time-coverage.js';

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
    const firstLines = pastedText.split(/\r?\n/).filter(l => l.trim()).slice(0, 4);
    const pasteFormat = detectFormat(firstLines);
    const acc = makeAccumulator(pasteFormat);
    pastedText.split(/\r?\n/).forEach(line => { if (line.trim()) feedLine(acc, line); });
    finalizeAccumulator(acc);
    const seriesByEntity = {};
    const resistanceEventsByEntity = {};
    let droppedResistanceEvents = 0;
    if (acc.groups) {
      Object.entries(acc.groups).forEach(([id, bucket]) => {
        if (bucket.series) seriesByEntity[id] = freezeSeries(bucket.series);
        if (bucket.resistanceEvents?.length) {
          normalizeResistanceEvents(bucket.resistanceEvents);
          resistanceEventsByEntity[id] = bucket.resistanceEvents;
          droppedResistanceEvents += resistanceEventsDroppedCount(bucket.resistanceEvents);
        }
      });
    } else if (acc.series) {
      const frozen = freezeSeries(acc.series);
      if (frozen) seriesByEntity[frozen.entityId || '_file'] = frozen;
      if (acc.resistanceEvents?.length) {
        normalizeResistanceEvents(acc.resistanceEvents);
        resistanceEventsByEntity[frozen?.entityId || '_file'] = acc.resistanceEvents;
        droppedResistanceEvents += resistanceEventsDroppedCount(acc.resistanceEvents);
      }
    }
    pastedSummary = {
      label: '직접 붙여넣은 텍스트', columns: acc.columns || [], delimiter: acc.delimiter || ',',
      rowCount: acc.rowCount, alarmCount: acc.alarmCount, headSample: acc.headSample,
      alarmSamples: acc.alarmSamples, alarmAnnotations: acc.alarmAnnotations,
      stats: acc.stats, groups: acc.groups, formatId: pasteFormat.id,
      formatLabel: pasteFormat.label, entityColumn: acc.entityColumn || null, derived: acc.derived,
      seriesByEntity, resistanceEventsByEntity, entityFilter: null,
      droppedResistanceEvents,
      dataTimeRange: acc.dataTimeRange || null,
      evidenceTimeRange: acc.evidenceTimeRange || null,
      timeCoverageRatio: Number.isFinite(acc.timeCoverageRatio) ? acc.timeCoverageRatio : null,
      alarmDroppedCount: acc.alarmDroppedCount || 0,
      alarmSampleTimeDistribution: acc.alarmSampleTimeDistribution || [],
      alarmSampleTimes: acc.alarmSampleTimes || []
    };
  }

  return activeSources.map(s => ({
    label: s.path, columns: s.columns, delimiter: s.delimiter,
    rowCount: s.rowCount, alarmCount: s.alarmCount, headSample: s.headSample,
    alarmSamples: s.alarmSamples, alarmAnnotations: s.alarmAnnotations,
    stats: s.stats, groups: s.groups, formatId: s.format?.id || 'generic',
    formatLabel: s.format?.label || '일반 CSV/TSV', entityColumn: s.entityColumn || null,
    derived: s.derived,
    seriesByEntity: s.seriesByEntity || {},
    resistanceEventsByEntity: s.resistanceEventsByEntity || {},
    entityFilter: s.entityFilter || null,
    droppedResistanceEvents: s.droppedResistanceEvents || 0,
    dataTimeRange: s.dataTimeRange || null,
    evidenceTimeRange: s.evidenceTimeRange || null,
    timeCoverageRatio: Number.isFinite(s.timeCoverageRatio) ? s.timeCoverageRatio : null,
    alarmDroppedCount: s.alarmDroppedCount || 0,
    alarmSampleTimeDistribution: s.alarmSampleTimeDistribution || [],
    alarmSampleTimes: s.alarmSampleTimes || []
  })).concat(pastedSummary ? [pastedSummary] : []);
}



function formatDerivedDetails(derived) {
  if (!derived || !derived.label) return '';
  const metricText = Object.entries(derived.metricStats || {})
    .slice(0, 20)
    .map(([key, value]) => `  - ${key}: min=${value.min}, max=${value.max}, avg=${avgOf(value)}`)
    .join('\n') || '  (파생 수치 없음)';
  const reasonEntries = Object.entries(derived.reasonCounts || {}).sort((a, b) => b[1] - a[1]);
  const reasonText = reasonEntries.slice(0, 8)
    .map(([reason, count]) => `  - ${reason}: ${count}건`).join('\n') || '  (파생 알람 없음)';
  const reasonRest = reasonEntries.length > 8
    ? `\n  - 기타 파생 알람 사유 ${reasonEntries.slice(8).reduce((sum, [, count]) => sum + count, 0)}건`
    : '';
  const categoryEntries = Object.entries(derived.categoryCounts || {}).flatMap(([key, values]) =>
    Object.entries(values).map(([value, count]) => `${key}=${value}: ${count}건`)
  );
  const categoryText = categoryEntries.length
    ? `\n- 파생 범주 집계:\n  - ${categoryEntries.slice(0, 8).join('\n  - ')}`
    : '';
  return `- 파생 탐지 방식: ${derived.label}
- 파생 이상 행 수: ${derived.alarmCount || 0}건
- 파생 지표 통계 (bounded running summary):
${metricText}
- 파생 이상 사유 집계:
${reasonText}${reasonRest}${categoryText}`;
}

function formatAlarmAnnotations(annotations) {
  if (!Array.isArray(annotations) || !annotations.length) return '';
  return annotations.map(annotation => {
    if (annotation.kind === 'derived') {
      const details = Object.entries(annotation.details || {})
        .filter(([key, value]) => key !== 'evidenceTier' && value !== null && value !== undefined)
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join(', ');
      return `파생(${annotation.reason}${details ? `; ${details}` : ''})`;
    }
    return `${annotation.kind || 'signal'}(${annotation.reason || ''})`;
  }).join(' | ');
}

function hasSizeTruncation(truncation) {
  return Boolean(
    truncation.excludedSources || truncation.excludedGroups
      || truncation.excludedAlarmContexts || truncation.droppedResistanceEvents
      || truncation.droppedAnomalyWindows || truncation.textTruncatedChars
  );
}

function buildTruncationNote(truncation) {
  const parts = [];
  if (truncation.excludedSources) parts.push(`출처 파일 ${truncation.excludedSources}개 미포함`);
  if (truncation.excludedGroups) parts.push(`엔티티 그룹 ${truncation.excludedGroups}개 상세 생략`);
  if (truncation.excludedAlarmContexts) parts.push(`알람 컨텍스트 ${truncation.excludedAlarmContexts}건 생략`);
  if (truncation.droppedResistanceEvents) parts.push(`저항 이벤트 ${truncation.droppedResistanceEvents.toLocaleString()}건 생략(초기 기준선+최근 창 유지)`);
  if (truncation.droppedAnomalyWindows) parts.push(`이상 구간 ${truncation.droppedAnomalyWindows.toLocaleString()}건 생략(상한 16, Case B 골드런 16건)`);
  if (truncation.textTruncatedChars) parts.push(`텍스트 ${truncation.textTruncatedChars.toLocaleString()}자 절단`);
  return `[참고: 데이터 규모 제한으로 일부가 생략된 상태입니다 — ${parts.join(', ')}. 생략된 부분에 대한 판단은 "추가 확인 필요"로 명시하십시오.]`;
}

function buildPromptPrefixNotes(truncation) {
  const notes = [];
  if (hasSizeTruncation(truncation)) notes.push(buildTruncationNote(truncation));
  if (truncation.lowTimeCoverage) notes.push(buildTimeCoverageNote(truncation.timeCoverageDetails));
  return notes.join('\n\n');
}

function formatTimeCoverageLines(block) {
  if (!block.dataTimeRange && !block.evidenceTimeRange) return '';
  const ratio = block.timeCoverageRatio;
  const pct = Number.isFinite(ratio) ? ` (커버리지 ${formatCoveragePct(ratio)})` : '';
  const dist = Array.isArray(block.alarmSampleTimeDistribution) && block.alarmSampleTimeDistribution.length
    ? `\n- 유지된 알람 샘플 시간 분포: ${block.alarmSampleTimeDistribution.map(b => `${(b.start || '').slice(0, 10)}:${b.count}`).join(', ')}`
    : '';
  const dropped = block.alarmDroppedCount
    ? `\n- 알람 컨텍스트 생략: ${Number(block.alarmDroppedCount).toLocaleString()}건 (시간 계층화 유지)`
    : '';
  return `- 데이터 시간 범위: ${formatTimeRange(block.dataTimeRange)}
- 알람 근거 시간 범위: ${formatTimeRange(block.evidenceTimeRange)}${pct}${dist}${dropped}
`;
}

function buildSourceProfile(block) {
  const derivedAlarmCount = block.groups
    ? Object.values(block.groups).reduce((sum, group) => sum + (group.derived?.alarmCount || 0), 0)
    : (block.derived?.alarmCount || 0);
  return {
    sourceFile: block.label,
    formatId: block.formatId || 'generic',
    formatLabel: block.formatLabel || '일반 CSV/TSV',
    entityColumn: block.entityColumn || null,
    rowCount: Number.isInteger(block.rowCount) ? block.rowCount : 0,
    derivedAlarmCount,
    dataTimeRange: block.dataTimeRange || null,
    evidenceTimeRange: block.evidenceTimeRange || null,
    timeCoverageRatio: Number.isFinite(block.timeCoverageRatio) ? block.timeCoverageRatio : null,
    alarmDroppedCount: Number.isInteger(block.alarmDroppedCount) ? block.alarmDroppedCount : 0,
    alarmSampleTimeDistribution: Array.isArray(block.alarmSampleTimeDistribution)
      ? block.alarmSampleTimeDistribution
      : []
  };
}

// alarmBudget: how many more alarm-context windows this call is allowed to
// render (a running total shared across the whole request — see
// blocksToPromptText). Returns how many it actually used/had available so
// the caller can track the budget and report what got left out.
function renderFlatBlock(block, alarmBudget) {
  const d = block.delimiter || ',';
  const statsText = Object.entries(block.stats || {}).map(([k, v]) => `  - ${k}: min=${v.min}, max=${v.max}, avg=${avgOf(v)}`).join('\n') || '  (수치 컬럼 없음)';
  const headText = block.headSample.map(r => block.columns.map(c => r[c]).join(d)).join('\n') || '  (없음)';
  const available = (block.alarmSamples || []).length;
  const used = Math.max(0, Math.min(available, alarmBudget));
  const shown = (block.alarmSamples || []).slice(0, used);
  const alarmCtxText = shown.length
    ? shown.map((win, i) => {
      const annotation = formatAlarmAnnotations((block.alarmAnnotations || [])[i]);
      return `  [알람#${i + 1}]${annotation ? ` · ${annotation}` : ''}\n` +
        win.map(r => '   ' + block.columns.map(c => r[c]).join(d)).join('\n');
    }).join('\n')
    : (available ? '  (요청 전체 알람 컨텍스트 예산 초과로 이 출처 분은 생략됨)' : '  (알람 코드 발생 행 없음)');
  const derivedText = formatDerivedDetails(block.derived);
  const timeText = formatTimeCoverageLines(block);
  const text = `### 출처 파일: ${block.label}
- 감지 포맷: ${block.formatLabel || block.formatId || '일반 CSV/TSV'}
- 총 행 수(스트리밍 집계): ${block.rowCount} / 알람·이상코드 발생 행: ${block.alarmCount}건 / 컬럼: ${block.columns.join(', ')}
${timeText}- 수치 컬럼 통계 (전체 행 기준 running min/max/avg):
${statsText}
${derivedText ? derivedText + '\n' : ''}- 파일 시작부 샘플:
${d}${block.columns.join(d)}
${headText}
- 알람·파생 이상 발생 전후 컨텍스트 (이번 요청에 포함 ${used}건 / 감지 ${available}건, 각 최대 ${CONTEXT_WINDOW}행):
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

  const entityHeader = `### 출처 파일: ${src.label} (엔티티별 그룹 집계 · 총 ${entries.length}개 엔티티${rest.length ? `, 상위 ${top.length}개만 상세 표시` : ''})
${formatTimeCoverageLines(src)}`.trimEnd();
  let remainingBudget = alarmBudget;
  let used = 0;
  let available = 0;
  const groupBlocks = top.map(([entityValue, g]) => {
    const r = renderFlatBlock({
      ...g,
      label: `${src.label} · 엔티티 ${entityValue}`,
      delimiter: src.delimiter,
      columns: src.columns,
      formatId: src.formatId,
      formatLabel: src.formatLabel
    }, remainingBudget);
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
    droppedResistanceEvents: 0,
    textTruncatedChars: 0,
    lowTimeCoverage: false,
    timeCoverageDetails: []
  };

  const includedBlocks = allBlocks.slice(0, MAX_SELECTED_SOURCES);
  const sourceProfiles = includedBlocks.map(buildSourceProfile);
  truncation.timeCoverageDetails = sourceProfiles
    .filter(profile => isLowTimeCoverage(profile.timeCoverageRatio))
    .map(profile => ({
      sourceFile: profile.sourceFile,
      ratio: profile.timeCoverageRatio,
      dataTimeRange: profile.dataTimeRange,
      evidenceTimeRange: profile.evidenceTimeRange
    }));
  truncation.lowTimeCoverage = truncation.timeCoverageDetails.length > 0;
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
  truncation.droppedResistanceEvents = includedBlocks.reduce((sum, block) => {
    const scalar = Number(block.droppedResistanceEvents) || 0;
    if (scalar) return sum + scalar;
    let n = 0;
    Object.values(block.resistanceEventsByEntity || {}).forEach(list => {
      n += resistanceEventsDroppedCount(list);
    });
    n += resistanceEventsDroppedCount(block.resistanceEvents);
    return sum + n;
  }, 0);

  const rawText = blockTexts.length ? blockTexts.join('\n\n') : '(입력된 로그 데이터 없음)';
  const hasStructuralTruncation = Boolean(
    truncation.excludedSources || truncation.excludedGroups
      || truncation.excludedAlarmContexts || truncation.droppedResistanceEvents
  );
  let text = rawText;

  // Reserve room for the omission / time-coverage notices themselves. The
  // client and server share MAX_LOG_TEXT_CHARS, so the serialized
  // combinedLogText must remain within that exact limit even when a note
  // is required. Time-coverage divergence is never silent either.
  if (hasStructuralTruncation || truncation.lowTimeCoverage || rawText.length > MAX_LOG_TEXT_CHARS) {
    let contentLimit = Math.min(rawText.length, MAX_LOG_TEXT_CHARS);
    let note = '';
    for (let i = 0; i < 20; i++) {
      truncation.textTruncatedChars = Math.max(0, rawText.length - contentLimit);
      note = buildPromptPrefixNotes(truncation);
      const nextLimit = Math.min(rawText.length, Math.max(0, MAX_LOG_TEXT_CHARS - note.length - 2));
      if (nextLimit === contentLimit) break;
      contentLimit = nextLimit;
    }
    truncation.textTruncatedChars = Math.max(0, rawText.length - contentLimit);
    note = buildPromptPrefixNotes(truncation);
    const finalLimit = Math.min(contentLimit, Math.max(0, MAX_LOG_TEXT_CHARS - note.length - 2));
    if (finalLimit !== contentLimit) {
      contentLimit = finalLimit;
      truncation.textTruncatedChars = Math.max(0, rawText.length - contentLimit);
      note = buildPromptPrefixNotes(truncation);
    }
    text = note + '\n\n' + rawText.slice(0, contentLimit);
  }

  return { text, totalRows, count: includedBlocks.length, truncation, sourceProfiles };
}

/* =========================================================
   LOADING PROGRESS — a live elapsed-time readout for the loading-* phases.
   Real CLI calls against a real large source have been observed to take
   100-240s (the format-aware anomaly/hypothesis prompts ask for more
   cross-referenced, evidence-tiered reasoning than the original simpler
   ones) — this exists so a slow-but-healthy call reads to the engineer as
   "still working", not a frozen UI, without claiming granular server-side
   progress we don't actually have (the CLI call returns once, atomically).
========================================================= */
let loadingTickTimer = null;

function beginLoadingTick() {
  state.loadingStartedAt = Date.now();
  clearInterval(loadingTickTimer);
  loadingTickTimer = setInterval(render, 1000);
}

function endLoadingTick() {
  clearInterval(loadingTickTimer);
  loadingTickTimer = null;
  state.loadingStartedAt = null;
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

  const { text: combinedLogText, totalRows, count, truncation, sourceProfiles } = blocksToPromptText(allBlocks);
  state.lastTruncation = truncation;
  state.sourceProfiles = sourceProfiles;

  try {
    const json = await detectIssuesApi({ combinedLogText, totalRows, sourceCount: count, sourceProfiles });
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
  beginLoadingTick();
  render();

  const allBlocks = collectActiveLogBlocks();
  const { text: combinedLogText, totalRows, count, truncation, sourceProfiles } = blocksToPromptText(allBlocks);
  state.lastTruncation = truncation;
  state.sourceProfiles = sourceProfiles;
  try {
    state.figureSpecs = buildFigures(allBlocks);
  } catch (e) {
    console.warn('figure build failed', e);
    state.figureSpecs = [];
  }
  state.attributionConflict = detectAttributionConflict({
    blocks: allBlocks,
    figures: state.figureSpecs
  });

  try {
    const json = await detectAnomalyApi({
      csText: state.csText, priorCase: state.priorCase,
      combinedLogText, totalRows, sourceCount: count, sourceProfiles
    });
    state.issueStructured = json.issueStructured || {};
    state.anomalyWindows = json.anomalyWindows || [];
    if (json.truncation?.droppedAnomalyWindows) {
      state.lastTruncation = {
        ...(state.lastTruncation || {}),
        droppedAnomalyWindows: json.truncation.droppedAnomalyWindows
      };
    }
    const af4 = (state.figureSpecs || []).find(f => f.id === 'A-F4');
    state.evidenceLedger = buildEvidenceLedger({
      blocks: allBlocks,
      figures: state.figureSpecs,
      anomalyWindows: state.anomalyWindows,
      commonMode: af4 ? af4.summaryStats : null
    });
    state.step = 1;
    state.phase = 'result-anomaly';
  } catch (e) {
    console.error(e);
    state.error = { stage: 'anomaly', message: e.message || String(e) };
    state.phase = 'idle';
  }
  endLoadingTick();
  render();
}

export async function runHypothesisGeneration() {
  state.error = null;
  state.loadingLabel = '이상 구간 패턴 기반 원인 가설 생성 중';
  state.phase = 'loading-hyp';
  state.step = 2;
  beginLoadingTick();
  render();

  const { text: referenceDocsText } = buildReferenceDocsBlock(state.referenceDocs);

  try {
    const json = await generateHypothesesApi({
      issueStructured: state.issueStructured,
      anomalyWindows: state.anomalyWindows,
      priorCase: state.priorCase,
      referenceDocsText,
      sourceProfiles: state.sourceProfiles || []
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
  endLoadingTick();
  render();
}

// Single place for snapshot omit-lists. stripBucketHeavy and the
// logSources.map destructure used to each have their own blocklist and
// silently drifted when a new heavy field was added.
const SNAPSHOT_DROP_FROM_SOURCE = ['_ref', 'format', 'seriesByEntity', 'resistanceEventsByEntity'];
const SNAPSHOT_DROP_FROM_BUCKET = ['series', 'resistanceEvents', 'recentWindow', '_lfpPrev', '_seriesPrevMw'];

function omitFields(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = { ...obj };
  for (const key of keys) delete copy[key];
  return copy;
}

function stripBucketHeavy(bucket) {
  return omitFields(bucket, SNAPSHOT_DROP_FROM_BUCKET);
}

export function snapshotState(s) {
  // Drop non-serializable / heavy fields (File handles, JSZip entries, format
  // adapter functions, downsampled series, PNG specs) before the JSON round-trip.
  const clone = {
    ...s,
    figureSpecs: undefined,
    logSources: s.logSources.map((src) => {
      const rest = omitFields(src, SNAPSHOT_DROP_FROM_SOURCE);
      return {
        ...rest,
        groups: src.groups
          ? Object.fromEntries(Object.entries(src.groups).map(([id, bucket]) => [id, stripBucketHeavy(bucket)]))
          : src.groups
      };
    })
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
  beginLoadingTick();
  render();

  try {
    const json = await draftReportApi({
      issueStructured: state.issueStructured,
      anomalyWindows: state.anomalyWindows,
      confirmedHyp: state.confirmedHypothesis,
      finalSeverity: state.finalSeverity,
      finalSeverityReason: state.finalSeverityReason,
      sourceProfiles: state.sourceProfiles || [],
      figureCatalog: figureCatalog(state.figureSpecs || []),
      evidenceLedger: catalogEvidence(state.evidenceLedger || []),
      ...(state.attributionConflict ? { attributionConflict: state.attributionConflict } : {})
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
  endLoadingTick();
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
  const figs = (state.figureSpecs || []).filter(f => f.available).map(f => f.id).join(', ') || '(없음)';
  const text = `[헤드라인] ${r.headline || ''}\n\n[발생 개요]\n${r.occurrence || ''}\n\n[이상 구간 요약]\n${r.anomalySummary || ''}\n\n[확정 원인]\n${r.rootCause || ''}\n\n[데이터가 입증하는 것]\n${r.provenBox || ''}\n\n[데이터가 시사하는 것]\n${r.suggestedBox || ''}\n\n[데이터가 판단할 수 없는 것]\n${r.unknownBox || ''}\n\n[심각도] ${state.finalSeverity} — ${state.finalSeverityReason}\n\n[조치 권고]\n${r.actionRecommendation || ''}\n\n[Figure] ${figs}`;
  copyText(text, '보고서');
}

export function downloadReportHtml() {
  import('./report-export.js').then(({ buildReportHtml }) => {
    const html = buildReportHtml({
      report: state.reportEdits || state.report || {},
      figures: state.figureSpecs || [],
      comparison: state.publishedComparison,
      severity: state.finalSeverity,
      severityReason: state.finalSeverityReason,
      hypothesis: state.confirmedHypothesis,
      createdAt: state.createdAt
    });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ESS_분석보고서_${state.id}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('HTML 보고서를 저장했습니다');
  }).catch(e => showToast(e.message || '내보내기 실패'));
}

export async function runPublishedComparison() {
  const excerptEl = document.getElementById('publishedExcerpt');
  const excerpt = (excerptEl ? excerptEl.value : '').trim();
  if (!excerpt || excerpt.length < 40) {
    showToast('공개 보고서/논문 발췌를 40자 이상 붙여넣으세요');
    return;
  }
  const findings = (state.reportEdits?.independentFindings || state.report?.independentFindings || []).filter(Boolean);
  if (!findings.length) {
    showToast('독립 findings가 없어 대조할 수 없습니다 — 보고서를 먼저 생성하세요');
    return;
  }
  state.phase = 'loading-report';
  state.loadingLabel = '공개 결과와 대조 중 (독립 findings는 동결)';
  beginLoadingTick();
  render();
  try {
    const json = await comparePublishedApi({
      independentFindings: findings,
      figureCatalog: figureCatalog(state.figureSpecs || []).map(({ id, claim, available }) => ({ id, claim, available })),
      publishedExcerpt: excerpt.slice(0, 60000),
      sourceProfiles: state.sourceProfiles || []
    });
    state.publishedComparison = json.rows || [];
    state.phase = 'result-report';
    state.step = 5;
  } catch (e) {
    state.error = { stage: 'report', message: e.message || String(e) };
    state.phase = 'result-report';
  }
  endLoadingTick();
  render();
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
const EDITABLE_HYP_FIELDS = [
  'name', 'domain', 'expectedSignature', 'actualObservation', 'evidence',
  'evidenceTier', 'disconfirmingEvidence', 'missingSignals', 'claimLimit'
];

function isCellArrayCase() {
  return (state.sourceProfiles || []).some(profile => profile.formatId === 'lfp-cell-array');
}

function defaultHypothesisFields() {
  const cellArray = isCellArrayCase();
  return {
    name: '',
    domain: cellArray ? 'Cell/Pack' : 'Battery/BMS',
    expectedSignature: '',
    actualObservation: '',
    evidence: '',
    evidenceTier: 'Inferred',
    disconfirmingEvidence: '추가 확인 필요: 이 가설을 반증할 신호를 확인하십시오.',
    missingSignals: '추가 확인 필요: 현재 공개 로그에 없는 검증 신호입니다.',
    claimLimit: cellArray
      ? '현재 데이터로는 Cell N 경로의 유효 직렬저항 증가 수준까지만 입증 가능하며 물리적 원인은 확정할 수 없다.'
      : '현재 로그가 직접 입증하는 범위와 추가 확인이 필요한 인과 해석을 구분한다.'
  };
}

export function selectHypothesis(id) {
  state.selectedHypId = id;
  const h = state.hypotheses.find(x => x.id === id);
  if (h) {
    // Copy into an editable draft — the AI hypothesis object itself is left
    // untouched so its original text stays visible for comparison. Severity
    // is intentionally NOT copied from severityDraft here — the human must
    // set it themselves (the AI draft is still visible as a read-only hint
    // on the card) so the confirm button stays gated on a real action.
    const defaults = defaultHypothesisFields();
    state.confirmedHypothesis = Object.fromEntries(EDITABLE_HYP_FIELDS.map(f => [f, h[f] || defaults[f] || '']));
    state.finalSeverity = null;
    state.finalSeverityReason = '';
  }
  render();
}

export function startCustomHypothesis() {
  state.selectedHypId = 'CUSTOM';
  const defaults = defaultHypothesisFields();
  state.confirmedHypothesis = Object.fromEntries(EDITABLE_HYP_FIELDS.map(f => [f, defaults[f] || '']));
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
