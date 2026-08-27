export const STEPS = ['의뢰 입력', '이상구간 탐지', '가설 생성', '사람 검토', '보고서·메일 초안', '완료'];
export const HYPOTHESIS_DOMAINS = [
  'Battery/BMS', 'PCS', 'PPC', 'EMS', 'Telemetry/SCADA', 'Dispatch', 'Forecast', 'Grid',
  'Normal Response', 'Contactor/CB', 'Cooling/HVAC', 'Communication/Sensor',
  'Cell/Pack', 'Electrical Path', 'Operating Condition', 'Balancing/BMS', 'Thermal/Sensor'
];

export function freshState() {
  return {
    id: 'CASE-' + Date.now().toString(36).toUpperCase(),
    createdAt: new Date().toLocaleString('ko-KR'),
    step: 0,
    csText: '',
    csvText: '',
    priorCase: '',
    logSources: [],
    figureSpecs: [],
    evidenceLedger: [],
    publishedComparison: null,
    zipScanning: false,
    zipSkipped: [],
    referenceDocs: [], // {id, name, text, truncated, charCount} — extracted locally from HTML/PPTX
    sensitiveDataConfirmed: false,
    sensitiveHits: [], // set by submitIntake()'s pattern scan; non-empty blocks submission
    detectedIssues: [],
    issueDetectionStatus: 'idle', /* idle | loading | done | error */
    selectedIssueId: null,
    issueStructured: null,
    anomalyWindows: [],
    // Set from blocksToPromptText()'s truncation report after the last AI
    // call that built a prompt from logs — surfaced in the UI so budget
    // limits (source/group/alarm-context caps, char cap) are never silent.
    lastTruncation: null,
    // Format metadata captured alongside the bounded prompt block. Used by
    // later domain-aware hypothesis/report prompts; it contains no raw rows.
    sourceProfiles: [],
    hypotheses: [],
    selectedHypId: null,
    // Human-editable working copy of the hypothesis the engineer confirms —
    // never auto-filled; only populated by an explicit selectHypothesis()/
    // startCustomHypothesis() action. This, not the raw AI draft, is what
    // gets sent to /api/draft-report.
    confirmedHypothesis: null,
    finalSeverity: null,
    finalSeverityReason: '',
    report: null,   // original AI draft — kept for reference, never shown as the editable copy
    email: null,    // original AI draft
    reportEdits: null, // {headline, occurrence, anomalySummary, rootCause, actionRecommendation} — what the engineer edits
    emailEdits: null,  // {to, subject, body}
    finalReviewConfirmed: false,
    error: null,
    loadingLabel: '',
    // Wall-clock start of the current loading-* phase (epoch ms) — drives the
    // live elapsed-time readout in render.js so a slow CLI call (real calls
    // against a large source have been observed to take 100-240s) reads as
    // "still working" rather than a frozen UI. Cleared on every transition
    // out of a loading phase (see pipeline.js's endLoadingTick()).
    loadingStartedAt: null,
    phase: 'idle', /* idle | loading-anomaly | loading-hyp | loading-report */
    readOnly: false
  };
}

/* Mutable containers — modules import these bindings once and mutate
   properties in place (never reassign) so every import stays in sync. */
export const state = {};
export const session = { caseHistory: [], activeCaseId: null };

export function resetState() {
  Object.assign(state, freshState());
  session.activeCaseId = state.id;
}

/** Gate for the "확정 → 보고서 생성" button — the human must have picked or
 *  written a hypothesis (with a non-empty name) AND set a severity + reason.
 *  Nothing here is ever true from AI output alone (see pipeline.js
 *  selectHypothesis()/startCustomHypothesis(), the only writers of
 *  confirmedHypothesis). Lives here (not pipeline.js) so both pipeline.js
 *  and render.js can import it without an import cycle. */
/** Live progress label for a loading-* phase, keyed off elapsed seconds
 *  since beginLoadingTick() (pipeline.js) started the phase. Real CLI calls
 *  against a real large source have been observed to take 100-240s — this
 *  exists so a slow-but-healthy call reads as "still working", never a
 *  frozen UI, without claiming granular server-side progress we don't
 *  actually have (the CLI call returns once, atomically). Pure/DOM-free so
 *  both pipeline.js (timer) and render.js (display) can use it without a
 *  circular import between them. */
export function describeLoadingProgress(elapsedSec) {
  if (elapsedSec < 15) return null; // too soon to say anything beyond the base label
  if (elapsedSec < 60) return 'Claude CLI 응답 대기 중';
  if (elapsedSec < 150) return '데이터 규모·가설 개수에 따라 보통 1~3분 정도 걸립니다';
  return '다소 지연되고 있습니다 — 자동 타임아웃 전까지 계속 기다려 주세요';
}

export function isHumanReviewComplete() {
  return Boolean(
    state.confirmedHypothesis &&
    state.confirmedHypothesis.name &&
    state.confirmedHypothesis.name.trim() &&
    state.finalSeverity &&
    state.finalSeverityReason &&
    state.finalSeverityReason.trim()
  );
}

export const SAMPLE_CS = "2024년 6월 3일 현장 ESS 랙 #3에서 과전압 경보 발생. 운영자 보고에 따르면 오전 10시 32분경 BMS 알람 후 자동 차단됨. 해당 랙 최근 3개월간 동일 증상 2회 이력 있음.";
export const SAMPLE_CSV = `timestamp,voltage_V,current_A,temp_C,soc_pct,alarm_code
2024-06-03 10:29:10,3.58,11.9,27.8,79,0
2024-06-03 10:30:01,3.61,12.3,28.1,81,0
2024-06-03 10:30:40,3.66,12.9,28.6,82,0
2024-06-03 10:31:45,3.74,13.8,29.4,83,0
2024-06-03 10:32:05,3.85,14.6,30.9,86,0
2024-06-03 10:32:11,3.91,15.2,31.7,87,OV001
2024-06-03 10:32:13,3.95,15.6,32.1,88,OV001
2024-06-03 10:32:15,0.02,0.0,32.0,88,OV001
2024-06-03 10:35:00,3.70,0.0,30.5,88,0
2024-06-03 10:40:00,3.68,0.0,29.2,88,0`;
export const SAMPLE_PRIOR = "유사 케이스: 2024년 3월 동일 모델 랙 #1 과전압, 원인은 BMS 셀 밸런싱 로직 오작동으로 판정. 심각도 '중' 처리.";

/* Quick-start CS-request phrase templates — click to prefill, then edit */
export const CS_TEMPLATES = [
  { label:'과전압 경보', text:'전력망 ESS 사이트 A동 랙 #{랙번호}에서 과전압(OV) 경보 발생. {날짜} {시각}경 BMS 알람 후 자동 차단됨. 해당 랙 최근 {기간} 내 동일 증상 {횟수}회 이력 있음.' },
  { label:'과전류/방전 이상', text:'{날짜} {시각}경 ESS 랙 #{랙번호} 방전 중 과전류(OC) 보호 동작. 부하 급증 구간에서 전류값이 정격 대비 급상승 후 시스템 정지. 재기동 후 현재 정상 동작 중.' },
  { label:'셀 온도 편차/과열', text:'주택용 ESS 옥외 설치형 뱅크에서 셀 온도 편차 경고 발생. {날짜} 이후 특정 모듈의 최고/최저 셀 온도 편차가 지속적으로 확대되는 추세이며, 공조 정상 가동 중임에도 편차가 좁혀지지 않음.' },
  { label:'SOC 급락/추정오차', text:'{날짜} {시각}경 ESS 랙 #{랙번호}에서 SOC가 단시간 내 비정상적으로 급락. 실제 방전 이력 대비 SOC 추정치 하락폭이 커 BMS SOC 캘리브레이션 오차 가능성 의심됨.' },
  { label:'SOH 저하 경향', text:'ESS 랙 #{랙번호}의 SOH가 최근 {기간}간 완만하지 않고 계단식으로 저하되는 패턴 관측됨. 특정 이벤트(급속충전/고온 노출 등) 이후 저하 기울기가 변화했는지 확인 필요.' },
  { label:'컨택터/CB 트립', text:'{날짜} {시각}경 ESS 랙 #{랙번호} 메인 컨택터(또는 차단기) 트립 발생. 트립 직전 전압/전류 급변 여부와 보호 시퀀스 정상 동작 여부 확인 요청. 수동 리셋 후 재투입 {가능/불가}.' },
  { label:'공조(HVAC) 이상', text:'ESS 컨테이너 내 공조(HVAC) 이상으로 실내 온도가 설정 상한을 초과하여 상승 중. {날짜}부터 냉방 사이클이 정상적으로 종료되지 않는 패턴 관측됨. 배터리 온도 영향 여부 확인 필요.' },
  { label:'통신 두절/PCS Fault', text:'{날짜} {시각}경 EMS-BMS 간 통신(CAN/Modbus) 순간 두절 발생, 동시에 PCS(인버터)에서 Fault 코드 발생. 통신 복구 후 정상 운전 재개되었으나 원인 재발 방지 대책 필요.' },
  { label:'UPS 백업시간 단축', text:'UPS 제품군 배터리 팩에서 정전 시 백업 유지시간이 스펙 대비 단축되는 현상 반복 보고. {날짜} 정전 테스트 시 예상 대비 {단축시간} 조기 방전 종료됨. SOH 저하 또는 셀 불균형 여부 확인 요청.' }
];
