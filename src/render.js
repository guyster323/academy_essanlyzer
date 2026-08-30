import { state, session, STEPS, CS_TEMPLATES, HYPOTHESIS_DOMAINS, isHumanReviewComplete, describeLoadingProgress } from './state.js';
import { formatBytes, MAX_SELECTED_SOURCES } from './log-engine.js';
import { formatTimeRange, formatCoveragePct, isLowTimeCoverage } from './time-coverage.js';
import { paintFigureCanvases } from './charts.js';
import { detectAttributionConflict, describeAttributionConflict } from './attribution-conflict.js';

export function esc(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// Toggles just the confirm button's disabled attribute in place (no full
// render()) so field edits stay reactive without stealing input focus.
export function refreshConfirmButtonState() {
  const btn = document.getElementById('confirmReportBtn');
  if (btn) btn.disabled = !isHumanReviewComplete();
}

// Same pattern as refreshConfirmButtonState — a targeted DOM update so
// checking the final-review box doesn't disturb any in-progress edits to
// the report/email textareas via a full render().
export function refreshCompleteButtonState() {
  const btn = document.getElementById('completeBtn');
  if (btn) btn.disabled = !state.finalReviewConfirmed;
}

export function copyText(text, label) {
  navigator.clipboard.writeText(text).then(() => {
    showToast((label || '내용') + ' 복사됨');
  }).catch(() => {
    showToast('복사 실패 — 브라우저 권한을 확인하세요');
  });
}

function renderStepper() {
  const cur = state.step;
  let html = '';
  STEPS.forEach((label, i) => {
    let cls = 'step-node';
    if (i < cur) cls += ' done';
    else if (i === cur) cls += ' active';
    html += `<div class="${cls}" style="flex:1;position:relative;">
      <div class="step-trace"></div>
      <div class="step-circle">${i < cur ? '✓' : i + 1}</div>
      <div class="step-label">${label}</div>
    </div>`;
  });
  document.getElementById('stepper').innerHTML = html;
}

function renderCaseList() {
  const el = document.getElementById('caseList');
  if (!session.caseHistory.length) {
    el.innerHTML = '<div class="case-empty">아직 처리한 케이스가 없습니다.<br>신규 이슈 분석을 시작하세요.</div>';
    return;
  }
  el.innerHTML = session.caseHistory.map(c => {
    const active = c.id === session.activeCaseId ? ' active' : '';
    const title = (c.issueStructured && c.issueStructured.issueType) ? c.issueStructured.issueType : 'CS 이슈 분석';
    const sevClass = c.finalSeverity ? ('sev-' + c.finalSeverity) : 'sev-pending';
    return `<div class="case-item${active}" onclick="loadCaseFromHistory('${c.id}')">
      <div class="case-item-title">${esc(title)}</div>
      <div class="case-item-meta">
        <span class="sev-dot ${sevClass}"></span>
        <span>${esc(c.finalSeverity || '검토중')}</span>
        <span>·</span>
        <span>${esc(c.createdAt.split(' ')[0] || '')}</span>
      </div>
    </div>`;
  }).join('');
}

function renderIntake() {
  document.getElementById('pageTitle').textContent = '신규 이슈 분석 — 의뢰 입력';
  document.getElementById('pageDesc').textContent = '로그를 업로드하면 이슈를 자동으로 감지해 CS 의뢰 내용을 채워드립니다. 실제 고객 데이터가 아닌 샘플/가상 데이터를 사용하시기 바랍니다.';

  return `
  <div class="panel">
    <div class="panel-head"><div class="panel-tag"></div><div class="panel-title">Step 1 · BMS/EMS 로그 업로드 → 이슈 자동 감지</div></div>
    <div class="panel-desc">로그를 올리면 잠시 후 아래에 감지된 이슈 후보가 나타납니다. 후보를 클릭하면 CS 의뢰 내용이 자동으로 채워지며, 이후 직접 수정할 수 있습니다. ZIP은 중첩된 zip(zip-in-zip)까지 목록으로 카탈로그되며, 대용량 항목은 선택해야 실제로 처리됩니다.</div>

    <div class="field-group">
      <label class="field-label">BMS/EMS 로그 데이터 <span class="req">*</span></label>
      <div class="file-row">
        <button class="btn btn-sm btn-ghost" onclick="document.getElementById('csvFileInput').click()">CSV/TXT/LOG 파일 추가</button>
        <input type="file" id="csvFileInput" accept=".csv,.txt,.log,.tsv" multiple onchange="handleCsvFileUpload(event)">
        <button class="btn btn-sm btn-ghost" onclick="document.getElementById('zipFileInput').click()">ZIP 아카이브 업로드</button>
        <input type="file" id="zipFileInput" accept=".zip" onchange="handleZipUpload(event)">
        ${state.zipScanning ? `<span class="scan-spinner"><span class="dot"></span>ZIP 내부 스캔 중...</span>` : ''}
      </div>
      <div class="field-hint">ZIP 업로드 시 내부 폴더 구조·중첩 zip과 무관하게 모든 하위 파일을 카탈로그합니다. 20MB 이하 항목은 즉시 스트리밍 집계되고, 그보다 큰 항목(수백 MB급 대용량 로그 포함)은 목록에만 표시되며 "분석 포함" 버튼을 눌러야 실제 스트리밍이 시작됩니다. 구분자·인코딩(UTF-8/EUC-KR)·로그 포맷(일반 CSV / AEMO MMS 리포트)은 자동 감지되며 필요 시 수동 조정할 수 있습니다.</div>

      ${renderSourceList()}

      <div style="margin-top:14px;">
        <label class="field-label" style="font-weight:500;color:var(--text-muted);">또는 텍스트 직접 붙여넣기 (선택 — 위 업로드와 함께 사용 가능)</label>
        <textarea id="inputCsv" rows="5" oninput="state.csvText=this.value" placeholder="timestamp,voltage_V,current_A,temp_C,soc_pct,alarm_code&#10;2024-06-03 10:30:01,3.61,12.3,28.1,81,0&#10;...">${esc(state.csvText)}</textarea>
      </div>
      <div class="field-warn" id="warnCsv">최소 1개 이상의 로그 소스(업로드 파일 또는 붙여넣기)가 필요합니다. timestamp에 해당하는 컬럼이 포함되어야 이상 구간을 탐지할 수 있습니다.</div>
    </div>

    ${renderDetectedIssues()}

    <div class="field-group">
      <label class="field-label">CS 이슈 의뢰 내용 <span class="req">*</span></label>
      <div class="tmpl-chip-row" style="margin-bottom:9px;">
        ${CS_TEMPLATES.map((t, i) => `<button type="button" class="tmpl-chip" onclick="applyCsTemplate(${i})">${esc(t.label)}</button>`).join('')}
      </div>
      <textarea id="inputCsText" rows="4" oninput="state.csText=this.value" placeholder="예: 2024년 6월 3일 현장 ESS 랙 #3에서 과전압 경보 발생. 오전 10시 32분경 BMS 알람 후 자동 차단됨. 최근 3개월간 동일 증상 2회 이력.">${esc(state.csText)}</textarea>
      <div class="field-hint">위 감지된 이슈를 클릭해 자동으로 채우거나, 빠른 입력 템플릿을 눌러 직접 작성할 수 있습니다.</div>
      <div class="field-warn" id="warnCsText">CS 이슈 의뢰 내용을 30자 이상 입력해 주세요. 발생 일시·증상·이력 정보가 있으면 분석 정확도가 높아집니다.</div>
    </div>

    <div class="field-group">
      <label class="field-label">참고할 과거 유사 케이스 (선택)</label>
      <input type="text" id="inputPrior" oninput="state.priorCase=this.value" placeholder="예: 2024년 3월 동일 모델 랙 #1 과전압, 원인은 셀 밸런싱 로직 오작동으로 판정." value="${esc(state.priorCase)}">
      <div class="field-hint">아래에서 과거 유사 사례 보고서(HTML/PPTX)를 첨부하면 원인 가설 생성 단계에서 더 풍부한 참고자료로 활용됩니다. 반드시 고객명·사이트명 등을 제거(redact)한 파일만 첨부하세요 — 원본 파일은 서버로 전송되지 않고 브라우저에서만 텍스트를 추출합니다.</div>
      <div class="file-row" style="margin-top:8px;">
        <button class="btn btn-sm btn-ghost" onclick="document.getElementById('refDocInput').click()">과거 보고서 첨부 (HTML/PPTX)</button>
        <input type="file" id="refDocInput" accept=".html,.htm,.pptx" multiple onchange="handleReferenceDocUpload(event)">
      </div>
      ${renderReferenceDocList()}
    </div>

    <div class="field-group">
      <label style="display:flex;align-items:flex-start;gap:8px;font-size:11.5px;color:var(--text-secondary);cursor:pointer;">
        <input type="checkbox" id="sensitiveConfirm" ${state.sensitiveDataConfirmed ? 'checked' : ''} style="margin-top:2px;accent-color:var(--amber);width:14px;height:14px;flex-shrink:0;" onchange="state.sensitiveDataConfirmed=this.checked">
        <span>고객명·사이트 위치·실 설비 식별자·개인정보를 제거했음을 확인합니다. <span class="req">*</span></span>
      </label>
      <div class="field-warn" id="warnSensitiveConfirm">위 확인란에 체크해야 분석을 시작할 수 있습니다.</div>
      <div class="field-warn" id="warnSensitiveHits">민감정보로 의심되는 패턴이 감지되었습니다: <span id="warnSensitiveHitsList"></span> — 위 텍스트에서 해당 부분을 직접 확인·수정한 뒤 다시 시도하세요. 자동으로 변경되지 않습니다.</div>
    </div>

    <div class="form-actions">
      <button class="sample-btn" onclick="loadSample()">샘플 케이스 불러오기 (OV001 과전압 예시)</button>
      <button class="btn btn-primary" onclick="submitIntake()">이상 구간 탐지 시작 →</button>
    </div>
  </div>`;
}

function renderReferenceDocList() {
  if (!state.referenceDocs.length) return '';
  return `<div class="source-list" style="margin-top:8px;">` +
    state.referenceDocs.map(d => `<div class="source-item">
      <div class="source-main">
        <div class="source-path">${esc(d.name)}</div>
        <div class="source-sub">${d.charCount.toLocaleString()}자 추출됨${d.truncated ? ` · <span style="color:var(--amber)">파일당 상한(20,000자) 초과로 일부 생략됨</span>` : ''}</div>
      </div>
      <button class="source-remove" onclick="removeReferenceDoc('${d.id}')" title="제거">✕</button>
    </div>`).join('') +
    `</div>`;
}

function renderDetectedIssues() {
  if (state.issueDetectionStatus === 'idle') return '';

  if (state.issueDetectionStatus === 'loading') {
    return `<div class="issue-detect-box loading">
      <span class="scan-spinner"><span class="dot"></span>업로드된 로그에서 이슈 자동 감지 중...</span>
    </div>`;
  }
  if (state.issueDetectionStatus === 'error') {
    return `<div class="issue-detect-box error">
      <span>자동 이슈 감지에 실패했습니다.</span>
      <button class="btn btn-sm btn-ghost" onclick="detectIssuesFromLogs()">다시 시도</button>
    </div>`;
  }
  if (!state.detectedIssues.length) {
    return `<div class="issue-detect-box empty">
      <span>업로드된 로그에서 뚜렷한 이상 징후가 감지되지 않았습니다. 아래 CS 의뢰 내용을 직접 작성해 주세요.</span>
      <button class="btn btn-sm btn-ghost" onclick="detectIssuesFromLogs()">다시 감지</button>
    </div>`;
  }

  let html = `<div class="issue-detect-box">
    <div class="issue-detect-label">자동 감지된 이슈 후보 (${state.detectedIssues.length}건) — 클릭하면 아래 CS 의뢰 내용이 채워집니다</div>
    <div class="issue-card-list">`;
  state.detectedIssues.forEach(iss => {
    const sel = iss.id === state.selectedIssueId;
    const codes = (iss.alarmCodes && iss.alarmCodes.length) ? iss.alarmCodes.join(', ') : '';
    html += `<div class="issue-card ${sel ? 'selected' : ''}" onclick="selectDetectedIssue('${iss.id}')">
      <div class="issue-card-top">
        <span class="lv-badge lv-${esc(iss.level) || '중'}">${esc(iss.level) || '중'}</span>
        <span class="issue-card-title">${esc(iss.title)}</span>
      </div>
      <div class="issue-card-meta">${esc(iss.occurredAt) || '시각 미상'} · ${esc(iss.sourceFile) || '—'}${codes ? ' · ' + esc(codes) : ''}</div>
    </div>`;
  });
  html += `</div>
    <button class="btn btn-sm btn-ghost" style="margin-top:9px;" onclick="detectIssuesFromLogs()">다시 감지</button>
  </div>`;
  return html;
}

function renderSourceList() {
  let html = '';
  if (!state.logSources.length && !state.zipSkipped.length) {
    return `<div class="source-empty">업로드된 파일이 없습니다. CSV/TXT/LOG 파일 또는 ZIP 아카이브를 추가하세요. 500MB급 대용량 로그, 중첩 zip도 카탈로그 후 선택 처리됩니다.</div>`;
  }

  if (state.logSources.length) {
    const selCount = state.logSources.filter(s => s.selected).length;
    const processingCount = state.logSources.filter(s => s.status === 'processing').length;
    const catalogedCount = state.logSources.filter(s => s.status === 'cataloged').length;
    html += `<div class="zip-summary-bar">인식된 파일 <b>${state.logSources.length}개</b> · 분석에 포함 <b>${selCount}개</b> 선택됨` +
      (processingCount ? ` · <span style="color:var(--amber)">${processingCount}개 처리 중</span>` : '') +
      (catalogedCount ? ` · <span style="color:var(--cyan)">${catalogedCount}개 카탈로그됨(미처리)</span>` : '') + `</div>`;
    if (selCount > MAX_SELECTED_SOURCES) {
      html += `<div class="skipped-note" style="color:var(--amber);">선택 ${selCount}개 중 최대 ${MAX_SELECTED_SOURCES}개까지만 분석에 포함됩니다 — 나머지 ${selCount - MAX_SELECTED_SOURCES}개는 이번 요청에서 제외됩니다.</div>`;
    }
    html += `<div class="source-list">`;
    const sorted = [...state.logSources].sort((a, b) => b.score - a.score);
    sorted.forEach(s => {
      html += renderSourceItem(s);
    });
    html += `</div>`;
  }

  if (state.zipSkipped.length) {
    const infoNotes = state.zipSkipped.filter(x => x.level === 'info');
    const skipNotes = state.zipSkipped.filter(x => x.level !== 'info');
    if (infoNotes.length) {
      html += `<div class="skipped-note" style="color:var(--cyan);">` +
        infoNotes.map(x => esc(x.name.split('/').pop()) + ' — ' + esc(x.reason)).join('<br>') + `</div>`;
    }
    if (skipNotes.length) {
      const errorNotes = skipNotes.filter(x => x.level === 'error');
      const ordinaryNotes = skipNotes.filter(x => x.level !== 'error');
      if (errorNotes.length) {
        html += `<div class="skipped-note" style="color:var(--red);">ZIP 항목별 읽기 실패 ${errorNotes.length}건(나머지 항목은 계속 처리됨): ` +
          errorNotes.slice(0, 6).map(x => esc(x.name.split('/').pop()) + '(' + esc(x.reason) + ')').join(', ') +
          (errorNotes.length > 6 ? ` 외 ${errorNotes.length - 6}건` : '') + `</div>`;
      }
      if (ordinaryNotes.length) {
        html += `<div class="skipped-note">ZIP 내 제외된 파일 ${ordinaryNotes.length}건: ` +
          ordinaryNotes.slice(0, 6).map(x => esc(x.name.split('/').pop()) + '(' + esc(x.reason) + ')').join(', ') +
          (ordinaryNotes.length > 6 ? ` 외 ${ordinaryNotes.length - 6}건` : '') + `</div>`;
      }
    }
  }

  return html;
}

function renderEntityFilterRow(s) {
  if (!s.entityColumn) return '';
  return `<div class="source-entity-row">
    <label>엔티티 필터 (${esc(s.entityColumn)}에 포함된 문자열, 비우면 전체 — 대용량 시 상위 10개 그룹만 상세 표시):</label>
    <input type="text" value="${esc(s.entityFilter || '')}" placeholder="예: BESS" onchange="setSourceEntityFilter('${s.id}', this.value)">
    ${s.entityFilterAuto && s.entityFilter ? '<span class="source-sub" style="color:var(--cyan);">자동 제안됨</span>' : ''}
  </div>`;
}

function renderTimeCoverage(s) {
  if (!s.dataTimeRange && !s.evidenceTimeRange) return '';
  const ratio = s.timeCoverageRatio;
  const warn = isLowTimeCoverage(ratio);
  const pct = formatCoveragePct(ratio);
  const dist = Array.isArray(s.alarmSampleTimeDistribution) && s.alarmSampleTimeDistribution.length
    ? s.alarmSampleTimeDistribution.map(b => `${esc((b.start || '').slice(0, 10))}:${b.count}`).join(' · ')
    : '';
  return `<div class="time-coverage${warn ? ' warn' : ''}" data-time-coverage="${warn ? 'low' : 'ok'}">
    <div>데이터 구간 ${esc(formatTimeRange(s.dataTimeRange))}</div>
    <div>알람 근거 구간 ${esc(formatTimeRange(s.evidenceTimeRange))} · 커버리지 ${esc(pct)}${warn ? ' — 전체 구간의 일부만 덮음' : ''}</div>
    ${dist ? `<div data-alarm-time-dist="1">유지 샘플 분포 ${dist}</div>` : ''}
  </div>`;
}

function renderSourceProfilesCoverage(profiles) {
  const list = Array.isArray(profiles) ? profiles.filter(p => p.dataTimeRange || p.evidenceTimeRange) : [];
  if (!list.length) return '';
  const cards = list.map(p => {
    const warn = isLowTimeCoverage(p.timeCoverageRatio);
    const dist = Array.isArray(p.alarmSampleTimeDistribution) && p.alarmSampleTimeDistribution.length
      ? p.alarmSampleTimeDistribution.map(b => `${esc((b.start || '').slice(0, 10))}:${b.count}`).join(' · ')
      : '';
    return `<div class="time-coverage${warn ? ' warn' : ''}" data-time-coverage="${warn ? 'low' : 'ok'}">
      <div>${esc(p.sourceFile || '출처')}</div>
      <div>데이터 ${esc(formatTimeRange(p.dataTimeRange))} · 알람 근거 ${esc(formatTimeRange(p.evidenceTimeRange))} · 커버리지 ${esc(formatCoveragePct(p.timeCoverageRatio))}${warn ? ' — 전체 구간의 일부만 덮음' : ''}</div>
      ${dist ? `<div data-alarm-time-dist="1">유지 샘플 분포 ${dist}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="panel" data-time-coverage-panel="1">
    <div class="panel-head"><div class="panel-tag"></div><div class="panel-title">시간 커버리지</div></div>
    ${cards}
  </div>`;
}

function renderSourceItem(s) {
  const pathParts = s.path.split('/');
  const fileName = pathParts.pop();
  const folderPart = pathParts.length ? pathParts.join('/') + '/' : '';
  const dispDelim = s.delimiter === '\t' ? 'TAB' : (s.delimiter || ',');
  const formatLabel = s.format && s.format.label ? s.format.label : null;
  const derivedAlarmCount = s.groups
    ? Object.values(s.groups).reduce((sum, g) => sum + (g.derived?.alarmCount || 0), 0)
    : (s.derived?.alarmCount || 0);

  let badge, statusLine, entityRow = '';
  if (s.status === 'cataloged') {
    badge = `<span class="source-badge badge-cataloged">카탈로그됨 · 미처리</span>` +
      (formatLabel ? ` <span class="source-badge badge-format">${formatLabel}</span>` : '');
    statusLine = `<span class="source-sub">${esc(s.sizeLabel)} · 스트리밍 집계 대기 중</span>
      <button class="btn btn-sm btn-ghost" onclick="startSourceProcessing('${s.id}')">분석 포함 (스트리밍 시작)</button>`;
    entityRow = renderEntityFilterRow(s);
  } else if (s.status === 'processing') {
    const pct = s.sizeBytes ? Math.min(100, Math.round((s.processedBytes / s.sizeBytes) * 100)) : null;
    badge = `<span class="source-badge badge-low">스캔 중</span>`;
    statusLine = `<div class="progress-track"><div class="progress-fill" style="width:${pct !== null ? pct : 8}%"></div></div>
      <span class="source-sub">${pct !== null ? pct + '%' : formatBytes(s.processedBytes) + ' 처리됨'} · ${esc(s.sizeLabel)}</span>`;
  } else if (s.status === 'error') {
    badge = `<span class="source-badge badge-skip">읽기 실패</span>`;
    statusLine = `<span class="source-sub" style="color:var(--red)">${esc(s.errorMsg)}</span>`;
  } else {
    badge = (s.score >= 3
      ? `<span class="source-badge badge-recommend">BMS 로그 후보</span>`
      : `<span class="source-badge badge-low">일반 파일</span>`) +
      (formatLabel ? ` <span class="source-badge badge-format">${formatLabel}</span>` : '') +
      (s.groups ? ` <span class="source-badge badge-format">엔티티 ${Object.keys(s.groups).length}개</span>` : '');
    const previewHeader = s.columns.join(' | ');
    const previewRows = s.headSample.length
      ? s.headSample.slice(0, 5).map(r => s.columns.map(c => r[c]).join(' | ')).join('\n')
      : (s.groups ? Object.entries(s.groups).slice(0, 3).map(([k, g]) => `[${k}] ` + (g.headSample[0] ? s.columns.map(c => g.headSample[0][c]).join(' | ') : '')).join('\n') : '');
    statusLine = `<span class="source-sub">${esc(s.sizeLabel)} · ${s.rowCount.toLocaleString()}행 · 알람 ${s.alarmCount}건 · 파생 이상 ${derivedAlarmCount}건${s.malformedRowCount ? ` · <span style="color:var(--amber)">손상 행 ${s.malformedRowCount}건(파싱 제외)</span>` : ''}${s.droppedResistanceEvents ? ` · <span style="color:var(--amber)">저항 이벤트 ${s.droppedResistanceEvents.toLocaleString()}건 생략(초기 기준선+최근 창 유지)</span>` : ''}${s.alarmDroppedCount ? ` · <span style="color:var(--amber)">알람 컨텍스트 ${s.alarmDroppedCount.toLocaleString()}건 생략</span>` : ''} · 구분자 '${dispDelim}'</span>
      <select class="enc-select" onchange="setSourceEncoding('${s.id}', this.value)">
        <option value="utf-8" ${s.encoding === 'utf-8' ? 'selected' : ''}>UTF-8</option>
        <option value="euc-kr" ${s.encoding === 'euc-kr' ? 'selected' : ''}>EUC-KR</option>
      </select>
      <button class="source-preview-toggle" onclick="toggleSourcePreview('${s.id}')">${s.showPreview ? '미리보기 닫기' : '미리보기'}</button>
      <div class="source-preview ${s.showPreview ? 'show' : ''}">${esc(previewHeader)}\n${esc(previewRows)}</div>`;
    entityRow = renderEntityFilterRow(s);
  }

  return `<div class="source-item ${s.selected ? '' : 'excluded'}">
    <input type="checkbox" ${s.selected ? 'checked' : ''} ${s.status !== 'ready' ? 'disabled' : ''} onchange="toggleSourceSelected('${s.id}')">
    <div class="source-main">
      <div class="source-path"><span class="folder-part">${esc(folderPart)}</span>${esc(fileName)}</div>
      <div class="source-meta-row">${badge}</div>
      <div class="source-status-line">${statusLine}</div>
      ${s.status === 'ready' ? renderTimeCoverage(s) : ''}
      ${entityRow}
    </div>
    <button class="source-remove" onclick="removeSource('${s.id}')" title="제거">✕</button>
  </div>`;
}

function renderLoading() {
  const elapsedSec = state.loadingStartedAt ? Math.floor((Date.now() - state.loadingStartedAt) / 1000) : 0;
  const progressNote = describeLoadingProgress(elapsedSec);
  return `<div class="panel"><div class="loading-box">
    <div class="scan-bar"></div>
    <div class="loading-text">${esc(state.loadingLabel)}</div>
    <div class="loading-sub">Claude · 백엔드 API 경유 · 실시간 추론 진행 중 · 경과 ${elapsedSec}초</div>
    ${progressNote ? `<div class="loading-sub loading-progress-note">${esc(progressNote)}</div>` : ''}
  </div></div>`;
}

function renderError() {
  const stageLabel = { anomaly: '이상 구간 탐지', hypothesis: '가설 생성', report: '보고서 생성' }[state.error.stage] || '분석';
  return `<div class="error-box">
    <div class="msg"><b>${esc(stageLabel)} 단계 오류.</b> ${esc(state.error.message)}<br>네트워크 상태를 확인하고 다시 시도해 주세요. 반복 실패 시 입력 데이터 형식을 점검하시기 바랍니다.</div>
    <button class="btn btn-sm" onclick="retryStage('${state.error.stage}')">다시 시도</button>
  </div>`;
}

function renderFigurePanel(fig) {
  const cap = fig.available
    ? `<figcaption class="figure-claim">${esc(fig.claim)}</figcaption>
       <canvas data-figure-id="${esc(fig.id)}" width="1200" height="480"></canvas>`
    : `<div class="figure-claim">${esc(fig.claim)}</div>
       <div class="figure-missing">${esc(fig.unavailableReason || '시계열 부족 — 추가 확인 필요')}</div>`;
  return `<figure class="analysis-figure ${fig.available ? '' : 'unavailable'}" id="figure-${esc(fig.id)}" data-figure-id="${esc(fig.id)}">
    <div class="figure-id">${esc(fig.id)}</div>
    ${cap}
  </figure>`;
}

function currentFigures() {
  return Array.isArray(state.figureSpecs) ? state.figureSpecs : [];
}

function currentAttributionConflict() {
  if (state.attributionConflict) return state.attributionConflict;
  return detectAttributionConflict({
    blocks: (state.logSources || []).filter(s => s.selected && s.status === 'ready'),
    figures: currentFigures()
  });
}

function renderAttributionConflictBanner(conflict) {
  const desc = describeAttributionConflict(conflict);
  if (!desc) return '';
  const sides = desc.sides.map(side => `<div class="attribution-conflict-side">
      <div class="attribution-conflict-method">${esc(side.method)}</div>
      <div class="attribution-conflict-cell">${esc(side.cell)}</div>
      <div class="attribution-conflict-stats">${esc(side.stats)}</div>
      <div class="ev-block" style="margin-top:8px;">
        <div class="ev-label">말할 수 있는 것</div>
        <div class="ev-text">${esc(side.canProve)}</div>
      </div>
      <div class="ev-block" style="margin-top:8px;">
        <div class="ev-label">말할 수 없는 것</div>
        <div class="ev-text">${esc(side.cannotProve)}</div>
      </div>
    </div>`).join('');
  return `<section class="attribution-conflict-banner" data-attribution-status="conflict">
    <div class="attribution-conflict-title">${esc(desc.title)}</div>
    <div class="attribution-conflict-caution">${esc(desc.caution)}</div>
    <div class="attribution-conflict-sides">${sides}</div>
  </section>`;
}

function renderAnomalyView() {
  document.getElementById('pageTitle').textContent = '이상 구간 탐지 결과';
  document.getElementById('pageDesc').textContent = 'AI가 로그를 스캔해 이상 구간을 자동 식별했습니다. 필요 시 원인 가설 생성 단계로 진행하십시오.';

  const s = state.issueStructured || {};
  let out = '';
  if (state.error && state.error.stage === 'anomaly') out += renderError();

  const t = state.lastTruncation;
  if (t && (t.excludedSources || t.excludedGroups || t.excludedAlarmContexts || t.droppedResistanceEvents || t.droppedAnomalyWindows || t.textTruncatedChars)) {
    const parts = [];
    if (t.excludedSources) parts.push(`출처 파일 ${t.excludedSources}개 미포함`);
    if (t.excludedGroups) parts.push(`엔티티 그룹 ${t.excludedGroups}개 상세 생략`);
    if (t.excludedAlarmContexts) parts.push(`알람 컨텍스트 ${t.excludedAlarmContexts}건 생략`);
    if (t.droppedResistanceEvents) parts.push(`저항 이벤트 ${t.droppedResistanceEvents.toLocaleString()}건 생략(초기 기준선+최근 창 유지)`);
    if (t.droppedAnomalyWindows) parts.push(`이상 구간 ${t.droppedAnomalyWindows.toLocaleString()}건 생략(상한 16)`);
    if (t.textTruncatedChars) parts.push(`텍스트 ${t.textTruncatedChars.toLocaleString()}자 절단`);
    out += `<div class="skipped-note" style="color:var(--amber);margin-bottom:12px;">⚠ 프롬프트 규모 제한으로 일부가 생략된 상태로 분석되었습니다: ${parts.join(', ')}.</div>`;
  }
  if (t && t.lowTimeCoverage && t.timeCoverageDetails?.length) {
    const bits = t.timeCoverageDetails.map(d =>
      `${d.sourceFile || '출처'} 근거 ${formatTimeRange(d.evidenceTimeRange)} / 데이터 ${formatTimeRange(d.dataTimeRange)} (${formatCoveragePct(d.ratio)})`
    );
    out += `<div class="skipped-note" data-time-coverage="low" style="color:var(--amber);margin-bottom:12px;">⚠ 알람 근거 시간 범위가 데이터 전체 구간의 일부만 덮습니다: ${esc(bits.join('; '))}. 이 구간 밖의 거동은 추가 확인 필요.</div>`;
  }
  out += renderSourceProfilesCoverage(state.sourceProfiles);

  out += `<div class="panel">
    <div class="panel-head"><div class="panel-tag"></div><div class="panel-title">이슈 구조화 요약</div></div>
    <div class="stat-strip">
      <div class="stat-chip">이슈 유형 <b>${esc(s.issueType || '—')}</b></div>
      <div class="stat-chip">설비 <b>${esc(s.facility || '—')}</b></div>
      <div class="stat-chip">발생 시각 <b>${esc(s.occurredAt || '—')}</b></div>
    </div>
    <div class="report-section-body" style="color:var(--text-secondary);font-size:11.5px;">${esc(s.priorHistory || '이력 정보 없음')}</div>
  </div>`;

  const figs = currentFigures();
  out += renderAttributionConflictBanner(currentAttributionConflict());
  if (figs.length) {
    out += `<div class="panel">
      <div class="panel-head"><div class="panel-tag"></div><div class="panel-title">근거 그래프</div></div>
      <div class="figure-grid">${figs.map(renderFigurePanel).join('')}</div>
    </div>`;
  }

  out += `<div class="panel">
    <div class="panel-head"><div class="panel-tag"></div><div class="panel-title">이상 구간 목록 (${state.anomalyWindows.length}건)</div></div>`;

  if (!state.anomalyWindows.length) {
    out += `<div class="issue-detect-box empty" style="display:block;">판단 불가 — 추가 확인 필요: 로그 범위, 임계값, 관련 PCS/EMS 로그를 확인하세요.</div>`;
  } else {
    out += `<table><thead><tr><th>Timestamp</th><th>출처 파일</th><th>이상 파라미터</th><th>관측값</th><th>정상범위</th><th>편차</th><th>알람코드</th><th>근거 계층</th><th>수준</th></tr></thead><tbody>`;
    state.anomalyWindows.forEach(a => {
      out += `<tr>
        <td class="mono">${esc(a.timestamp)}</td>
        <td class="mono" style="color:var(--text-muted);font-size:10px;">${esc(a.sourceFile) || '—'}</td>
        <td>${esc(a.parameter)}</td>
        <td class="mono">${esc(a.observedValue)}</td>
        <td class="mono">${esc(a.normalRange)}</td>
        <td class="mono">${esc(a.deviation)}</td>
        <td class="mono">${esc(a.alarmCode) || '—'}</td>
        <td>${esc(a.evidenceTier) || '—'}</td>
        <td><span class="lv-badge lv-${esc(a.level) || '중'}">${esc(a.level) || '중'}</span></td>
      </tr>`;
    });
    out += `</tbody></table>`;
  }

  out += `<div class="btn-row">
    <button class="btn btn-ghost" onclick="startNewCase()">처음부터 다시</button>
    <button class="btn btn-primary" onclick="runHypothesisGeneration()" ${!state.anomalyWindows.length ? 'disabled title="이상 구간이 없으면 가설을 생성할 근거가 없습니다"' : ''}>원인 가설 생성 →</button>
  </div></div>`;

  return out;
}

function renderHypothesisView() {
  document.getElementById('pageTitle').textContent = '원인 가설 검토 및 심각도 확정';
  document.getElementById('pageDesc').textContent = state.readOnly ? '완료된 케이스의 검토 기록입니다.' : 'AI가 생성한 가설 중 유력 가설을 선택하고, 심각도를 최종 확정하십시오. 이 단계는 반드시 엔지니어가 수행합니다.';

  let out = '';
  if (state.error && state.error.stage === 'hypothesis') out += renderError();

  const keyFigs = currentFigures().filter(f => f.id === 'A-F4' || f.id === 'B-F1' || f.id === 'B-F2' || f.id === 'F-generic-1');
  if (keyFigs.length) {
    out += `<div class="panel"><div class="panel-head"><div class="panel-tag"></div><div class="panel-title">반증·지지 그래프</div></div>
      <div class="figure-grid">${keyFigs.map(renderFigurePanel).join('')}</div></div>`;
  }

  out += `<div class="checkpoint-banner">
    <span>◈</span>
    <span><b>사람 검토 체크포인트</b> — AI가 제시한 가설은 초안입니다. 방향이 맞는지 확인 후 유력 가설을 선택하고 심각도를 최종 확정해 주세요.</span>
  </div>`;
  out += renderAttributionConflictBanner(currentAttributionConflict());

  state.hypotheses.forEach(h => {
    const selected = h.id === state.selectedHypId;
    out += `<div class="hyp-card ${selected ? 'selected' : ''}">
      <div class="hyp-top">
        <div class="hyp-name-row">
          <input type="radio" name="hypSelect" class="hyp-radio" ${selected ? 'checked' : ''} ${state.readOnly ? 'disabled' : ''} onchange="selectHypothesis('${h.id}')">
          <span class="hyp-name">${esc(h.name)}</span>
          <span class="domain-badge">${esc(h.domain)}</span>
          <span class="conf-badge conf-${esc(h.confidence)}">신뢰도 ${esc(h.confidence)}</span>
        </div>
      </div>
      <div class="evidence-grid">
        <div class="ev-block"><div class="ev-label">Expected Signature</div><div class="ev-text">${esc(h.expectedSignature)}</div></div>
        <div class="ev-block"><div class="ev-label">Actual Observation</div><div class="ev-text">${esc(h.actualObservation)}</div></div>
      </div>
      <div class="ev-block"><div class="ev-label">Evidence</div><div class="ev-text support">${esc(h.evidence)}</div></div>
      <div class="sev-row"><label>근거 계층:</label> <span class="domain-badge">${esc(h.evidenceTier || 'Inferred')}</span></div>
      <div class="evidence-grid">
        <div class="ev-block"><div class="ev-label">Disconfirming Evidence</div><div class="ev-text">${esc(h.disconfirmingEvidence || '추가 확인 필요')}</div></div>
        <div class="ev-block"><div class="ev-label">Missing Signals</div><div class="ev-text">${esc(h.missingSignals || '추가 확인 필요')}</div></div>
      </div>
      <div class="ev-block"><div class="ev-label">Claim Limit</div><div class="ev-text">${esc(h.claimLimit || '추가 확인 필요')}</div></div>
      <div class="sev-row">
        <label>AI 심각도 초안:</label> <span class="lv-badge lv-${esc(h.severityDraft)}">${esc(h.severityDraft)}</span>
        <span style="font-size:10.5px;color:var(--text-muted);">${esc(h.severityReason)}</span>
      </div>
    </div>`;
  });

  if (!state.readOnly) {
    out += `<div class="btn-row" style="margin-top:0;">
      <button class="btn btn-ghost btn-sm" onclick="startCustomHypothesis()" ${state.selectedHypId === 'CUSTOM' ? 'disabled' : ''}>AI 가설 대신 직접 작성</button>
    </div>`;

    const ch = state.confirmedHypothesis || { name: '', domain: 'Battery/BMS', expectedSignature: '', actualObservation: '', evidence: '', evidenceTier: 'Inferred', disconfirmingEvidence: '', missingSignals: '', claimLimit: '' };
    const locked = !state.confirmedHypothesis; // no hypothesis chosen yet — fields exist but are inert
    out += `<div class="panel">
      <div class="panel-head"><div class="panel-tag"></div><div class="panel-title">확정 가설 (수정 가능) · 심각도 최종 판정</div></div>
      <div class="panel-desc" style="margin-left:0;">위 가설 중 하나를 선택하거나 "AI 가설 대신 직접 작성"을 눌러야 아래 입력이 활성화됩니다. 이 화면은 AI가 자동으로 채우지 않습니다 — 반드시 엔지니어의 명시적 선택/입력이 필요합니다.</div>
      <div class="field-group">
        <label class="field-label">가설명 <span class="req">*</span></label>
        <input type="text" id="confirmedHypName" ${locked ? 'disabled' : ''} value="${esc(ch.name)}" oninput="updateConfirmedHypField('name', this.value)" placeholder="확정할 가설을 입력하세요">
      </div>
      <div class="field-group">
        <label class="field-label">Domain</label>
        <select id="confirmedHypDomain" ${locked ? 'disabled' : ''} onchange="updateConfirmedHypField('domain', this.value)">
          ${HYPOTHESIS_DOMAINS.map(d =>
            `<option value="${d}" ${ch.domain === d ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </div>
      <div class="evidence-grid">
        <div class="field-group" style="margin-bottom:0;">
          <label class="field-label">Expected Signature</label>
          <textarea rows="2" ${locked ? 'disabled' : ''} oninput="updateConfirmedHypField('expectedSignature', this.value)">${esc(ch.expectedSignature)}</textarea>
        </div>
        <div class="field-group" style="margin-bottom:0;">
          <label class="field-label">Actual Observation</label>
          <textarea rows="2" ${locked ? 'disabled' : ''} oninput="updateConfirmedHypField('actualObservation', this.value)">${esc(ch.actualObservation)}</textarea>
        </div>
      </div>
      <div class="field-group">
        <label class="field-label">Evidence</label>
        <textarea rows="2" ${locked ? 'disabled' : ''} oninput="updateConfirmedHypField('evidence', this.value)">${esc(ch.evidence)}</textarea>
      </div>
      <div class="field-group">
        <label class="field-label">근거 계층</label>
        <input type="text" value="${esc(ch.evidenceTier || 'Inferred')}" disabled>
      </div>
      <div class="evidence-grid">
        <div class="field-group" style="margin-bottom:0;">
          <label class="field-label">반증 가능 증거</label>
          <textarea rows="2" ${locked ? 'disabled' : ''} oninput="updateConfirmedHypField('disconfirmingEvidence', this.value)">${esc(ch.disconfirmingEvidence)}</textarea>
        </div>
        <div class="field-group" style="margin-bottom:0;">
          <label class="field-label">확인에 필요한 누락 신호</label>
          <textarea rows="2" ${locked ? 'disabled' : ''} oninput="updateConfirmedHypField('missingSignals', this.value)">${esc(ch.missingSignals)}</textarea>
        </div>
      </div>
      <div class="field-group">
        <label class="field-label">주장 한계</label>
        <textarea rows="2" ${locked ? 'disabled' : ''} oninput="updateConfirmedHypField('claimLimit', this.value)">${esc(ch.claimLimit)}</textarea>
      </div>
      <div class="sev-row" style="border-top:1px solid var(--border-soft);padding-top:12px;">
        <label>최종 심각도 <span class="req">*</span></label>
        <select id="sevSelect" class="sev-select" ${locked ? 'disabled' : ''} onchange="onSeveritySelectChange(this.value)">
          <option value="" ${!state.finalSeverity ? 'selected' : ''} disabled>심각도 선택...</option>
          <option value="상" ${state.finalSeverity === '상' ? 'selected' : ''}>상</option>
          <option value="중" ${state.finalSeverity === '중' ? 'selected' : ''}>중</option>
          <option value="하" ${state.finalSeverity === '하' ? 'selected' : ''}>하</option>
        </select>
        <input type="text" id="sevReasonInput" class="sev-reason-input" ${locked ? 'disabled' : ''} placeholder="판정 근거 (필수)" value="${esc(state.finalSeverityReason)}" oninput="onSeverityReasonInput(this.value)">
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost" onclick="runHypothesisGeneration()">가설 다시 생성</button>
        <button id="confirmReportBtn" class="btn btn-primary" onclick="confirmAndGenerateReport()" ${!isHumanReviewComplete() ? 'disabled' : ''}>가설·심각도 확정 → 보고서 생성</button>
      </div>
    </div>`;
  }

  return out;
}

function renderReportView() {
  document.getElementById('pageTitle').textContent = '분석 보고서 및 CS 회신 메일 초안';
  document.getElementById('pageDesc').textContent = state.readOnly ? '완료된 케이스 기록입니다.' : '최종 검토 후 발송하십시오. 심각도 최종 판정 및 공식 발송본 확정은 담당 엔지니어의 책임입니다.';

  let out = '';
  if (state.error && state.error.stage === 'report') out += renderError();

  if (state.readOnly) {
    out += `<div class="readonly-flag"><span class="readonly-dot"></span>READ-ONLY · ${esc(state.createdAt)} 생성</div>`;
  }

  const r = state.reportEdits || state.report || {};
  const confirmedHyp = state.confirmedHypothesis || {};
  const ro = state.readOnly; // read-only history view: show the saved text, no editing

  out += `<div class="headline-box">
    <div class="headline-eyebrow">HEADLINE MESSAGE</div>
    ${ro
      ? `<div class="headline-text">${esc(r.headline)}</div>`
      : `<textarea id="reportHeadline" class="headline-text" rows="2" style="width:100%;background:transparent;border:1px solid rgba(255,171,46,0.4);border-radius:3px;color:#FFE1AD;font-family:var(--font-sans);resize:vertical;padding:6px 8px;" oninput="updateReportField('headline', this.value)">${esc(r.headline)}</textarea>`}
  </div>`;

  out += `<div class="panel">
    <div class="panel-head"><div class="panel-tag"></div><div class="panel-title">분석 보고서 초안 (수정 가능)</div></div>
    ${renderReportSection('발생 개요', 'reportOccurrence', 'occurrence', r.occurrence, ro)}
    ${renderReportSection('이상 구간 요약', 'reportAnomalySummary', 'anomalySummary', r.anomalySummary, ro)}
    <div class="report-section"><div class="report-section-label">확정 원인 (${esc(confirmedHyp.name || '')})</div>
      ${ro ? `<div class="report-section-body">${esc(r.rootCause)}</div>`
           : `<textarea id="reportRootCause" rows="3" oninput="updateReportField('rootCause', this.value)">${esc(r.rootCause)}</textarea>`}
    </div>
    <div class="report-section"><div class="report-section-label">심각도</div><div class="report-section-body"><span class="lv-badge lv-${esc(state.finalSeverity)}">${esc(state.finalSeverity)}</span> &nbsp;${esc(state.finalSeverityReason)}</div></div>
    ${renderReportSection('조치 권고', 'reportActionRecommendation', 'actionRecommendation', r.actionRecommendation, ro)}
    ${currentFigures().length ? `<div class="report-section"><div class="report-section-label">근거 그래프</div>
      <div class="figure-grid">${currentFigures().map(renderFigurePanel).join('')}</div>
      <div class="human-note">시계열·PNG는 이 세션에서만 재생성됩니다. 히스토리 재열람 시 그림은 비어 있을 수 있습니다.</div>
    </div>` : ''}
    <div class="three-box-grid">
      <div class="three-box proven"><h3>데이터가 입증하는 것</h3>${ro ? `<p>${esc(r.provenBox || '—')}</p>` : `<textarea rows="4" oninput="updateReportField('provenBox', this.value)">${esc(r.provenBox || '')}</textarea>`}</div>
      <div class="three-box suggested"><h3>데이터가 시사하는 것</h3>${ro ? `<p>${esc(r.suggestedBox || '—')}</p>` : `<textarea rows="4" oninput="updateReportField('suggestedBox', this.value)">${esc(r.suggestedBox || '')}</textarea>`}</div>
      <div class="three-box unknown"><h3>데이터가 판단할 수 없는 것</h3>${ro ? `<p>${esc(r.unknownBox || '—')}</p>` : `<textarea rows="4" oninput="updateReportField('unknownBox', this.value)">${esc(r.unknownBox || '')}</textarea>`}</div>
    </div>
    ${(r.independentFindings || []).length ? `<div class="report-section"><div class="report-section-label">Independent Findings</div>
      <ol>${(r.independentFindings || []).map(f => `<li>${esc(f)}</li>`).join('')}</ol></div>` : ''}
    ${(r.ftaLeaves || []).length ? `<div class="report-section"><div class="report-section-label">FTA</div>
      ${(r.ftaLeaves || []).map(l => `<div class="fta-leaf"><span>${esc(l.branch)}</span><span class="fta-disp">${esc(l.disposition)}</span></div>`).join('')}</div>` : ''}
    ${(r.managementImplications || []).length ? `<div class="report-section"><div class="report-section-label">Management</div>
      <ul>${(r.managementImplications || []).map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
    <div class="btn-row">
      <button class="btn btn-sm copy-btn" onclick="copyReportText()">보고서 전체 복사</button>
      <button class="btn btn-sm" onclick="downloadReportHtml()">HTML로 저장</button>
    </div>
  </div>`;

  if (!ro) {
    out += `<div class="panel">
      <div class="panel-head"><div class="panel-tag"></div><div class="panel-title">공개 결과와 대조 (선택)</div></div>
      <div class="panel-desc" style="margin-left:0;">독립 분석이 끝난 뒤에만 실행합니다. AEMO/논문 결론을 먼저 읽고 끼워 맞추지 않습니다.</div>
      <textarea id="publishedExcerpt" rows="6" placeholder="공개 보고서 또는 논문에서 대조할 발췌를 붙여넣으세요."></textarea>
      <div class="btn-row"><button class="btn btn-ghost" onclick="runPublishedComparison()">공개 결과와 대조</button></div>
      ${Array.isArray(state.publishedComparison) ? `<table class="comparison-table"><thead><tr><th>항목</th><th>독립분석</th><th>공개결과</th><th>일치</th><th>RAW</th><th>비고</th></tr></thead><tbody>
        ${state.publishedComparison.map(row => `<tr>
          <td>${esc(row.item)}</td><td>${esc(row.independentFinding)}</td><td>${esc(row.publishedFinding)}</td>
          <td>${esc(row.agree)}</td><td>${row.rawSufficient ? '충분' : '불가'}</td><td>${esc(row.notes)}</td>
        </tr>`).join('')}
      </tbody></table>` : ''}
    </div>`;
  } else if (Array.isArray(state.publishedComparison)) {
    out += `<div class="panel"><div class="panel-head"><div class="panel-tag"></div><div class="panel-title">공개 결과 대조</div></div>
      <table class="comparison-table"><tbody>${state.publishedComparison.map(row => `<tr><td>${esc(row.item)}</td><td>${esc(row.agree)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  const e = state.emailEdits || state.email || {};
  out += `<div class="panel">
    <div class="panel-head"><div class="panel-tag"></div><div class="panel-title">CS 회신 메일 초안 (수정 가능)</div></div>
    <div class="email-box">
      <div class="email-meta">수신: ${esc(e.to)}</div>
      ${ro
        ? `<div class="email-subject">${esc(e.subject)}</div><div class="email-body">${esc(e.body)}</div>`
        : `<input type="text" id="emailSubject" class="email-subject" style="margin-bottom:12px;" value="${esc(e.subject)}" oninput="updateEmailField('subject', this.value)">
           <textarea id="emailBody" class="email-body" rows="10" style="width:100%;" oninput="updateEmailField('body', this.value)">${esc(e.body)}</textarea>`}
    </div>
    <div class="btn-row">
      <button class="btn btn-sm copy-btn" onclick="copyEmailText()">메일 본문 복사</button>
    </div>
    <div class="human-note"><b>검토 필수:</b> 본 초안은 AI가 생성한 결과이며, 기술 표현 정확성·민감 정보 포함 여부·심각도 최종 판정을 담당 엔지니어가 검토·확정한 후 발송해야 합니다.</div>
  </div>`;

  if (!ro) {
    out += `<div class="panel">
      <label style="display:flex;align-items:flex-start;gap:8px;font-size:11.5px;color:var(--text-secondary);cursor:pointer;">
        <input type="checkbox" id="finalReviewConfirm" style="margin-top:2px;accent-color:var(--amber);width:14px;height:14px;flex-shrink:0;" onchange="onFinalReviewCheckboxChange(this.checked)">
        <span>본 보고서·메일의 <b>기술적 정확성</b>·<b>그림·3-box 근거</b>·<b>민감정보 미포함 여부</b>·<b>심각도 최종 판정</b>을 모두 검토·확정했습니다. <span class="req">*</span></span>
      </label>
    </div>
    <div class="btn-row"><button id="completeBtn" class="btn btn-primary" onclick="completeCase()" ${!state.finalReviewConfirmed ? 'disabled' : ''}>완료 · 신규 케이스 시작</button></div>`;
  } else {
    out += `<div class="btn-row"><button class="btn btn-ghost" onclick="startNewCase()">신규 케이스 시작</button></div>`;
  }

  return out;
}

function renderReportSection(label, id, field, value, readOnly) {
  return `<div class="report-section"><div class="report-section-label">${label}</div>
    ${readOnly ? `<div class="report-section-body">${esc(value)}</div>`
               : `<textarea id="${id}" rows="3" oninput="updateReportField('${field}', this.value)">${esc(value)}</textarea>`}
  </div>`;
}

export function render() {
  renderStepper();
  renderCaseList();

  let html = '';
  if (state.phase === 'loading-anomaly' || state.phase === 'loading-hyp' || state.phase === 'loading-report') {
    html = renderLoading();
  } else if (state.step === 0) {
    html = renderIntake();
  } else if (state.step === 1) {
    html = renderAnomalyView();
  } else if (state.step === 2 || state.step === 3) {
    html = renderHypothesisView();
  } else if (state.step >= 4) {
    html = renderReportView();
  }
  document.getElementById('viewRoot').innerHTML = html;
  paintFigureCanvases(currentFigures());
}
