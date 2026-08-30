export const PERSONA = "당신은 LG에너지솔루션 ESS(Energy Storage System) BMS/EMS 분석 전문 엔지니어입니다. 데이터에 근거해 엄격하고 간결하게 판단하며, 로그에 존재하지 않는 수치나 사실을 추정하여 만들어내지 않습니다. 확인이 필요한 사항은 명확히 '추가 확인 필요'로 표기합니다. 모든 사실·파생지표·인과 추론을 Observed/Derived/Inferred로 구분합니다.";

function normalizeProfiles(sourceProfiles, sourceFormats) {
  if (Array.isArray(sourceProfiles) && sourceProfiles.length) return sourceProfiles;
  if (!Array.isArray(sourceFormats)) return [];
  return sourceFormats.map(format => typeof format === 'string' ? { formatId: format } : format).filter(Boolean);
}

function formatProfileTimeRange(range) {
  if (!range || !range.min || !range.max) return '미상';
  const a = String(range.min).slice(0, 10);
  const b = String(range.max).slice(0, 10);
  return a === b ? a : `${a} ~ ${b}`;
}

function sourceProfileText(sourceProfiles, sourceFormats) {
  const profiles = normalizeProfiles(sourceProfiles, sourceFormats);
  if (!profiles.length) return '- 감지된 포맷 메타데이터 없음(로그 블록의 포맷/파생 탐지 설명을 우선 확인)';
  return profiles.map(profile => {
    const name = profile.sourceFile || '출처 파일 미상';
    const id = profile.formatId || 'generic';
    const label = profile.formatLabel ? ` (${profile.formatLabel})` : '';
    const entity = profile.entityColumn ? `, entity=${profile.entityColumn}` : ', 파일 1개=단일 시스템/엔티티';
    const derived = Number.isFinite(profile.derivedAlarmCount) ? `, 파생 이상 ${profile.derivedAlarmCount}건` : '';
    let time = '';
    if (profile.dataTimeRange || profile.evidenceTimeRange) {
      const pct = Number.isFinite(profile.timeCoverageRatio)
        ? `, 커버리지 ${Math.round(profile.timeCoverageRatio * 1000) / 10}%`
        : '';
      time = `, 데이터 ${formatProfileTimeRange(profile.dataTimeRange)} / 알람 근거 ${formatProfileTimeRange(profile.evidenceTimeRange)}${pct}`;
    }
    const yearCounts = profile.resistanceEventYearCounts || {};
    const years = Object.keys(yearCounts).sort();
    const resistance = years.length
      ? `, 저항 유지 ${years.map(y => `${y}:${yearCounts[y]}`).join(' ')}`
      : '';
    return `- ${name}: ${id}${label}${entity}${derived}${time}${resistance}`;
  }).join('\n');
}

function formatGuidance(sourceProfiles, sourceFormats) {
  const profiles = normalizeProfiles(sourceProfiles, sourceFormats);
  const ids = new Set(profiles.map(profile => profile.formatId));
  const sections = [];

  if (ids.has('aemo-mms')) {
    sections.push(`[계통급 AEMO MMS telemetry 규칙]
- Case A는 하루 전체 MEASURED_MW의 독립적인 rolling mean/std·MAD robust z-score·ramp 결과를 우선 신호로 사용하라.
- MW_QUALITY_FLAG는 telemetry 품질/보조 신호일 뿐이며, 그 값이나 알려진 12:15–12:20 시각을 이상 탐지의 시작점·근거로 삼지 마라.
- 가능한 가설 domain은 Battery/BMS, PCS, PPC, EMS, Telemetry/SCADA, Dispatch, Forecast, Grid, Normal Response다.
- 타 설비 동시성·명령/응답 불일치가 관측되지 않으면 Local/공통 원인을 확정하지 말고 필요한 누락 신호를 적어라.
- A-F4가 다수 설비 동조를 보이면 Battery/BMS·PCS 가설의 disconfirmingEvidence에 그 동조를 인용하라. 교차설비가 생략됐으면 missingSignals에 적어라.`);
  }

  if (ids.has('lfp-cell-array')) {
    sections.push(`[LFP cell-array 필드 데이터 규칙]
- 파일 하나를 하나의 system으로 취급하고, 각 행의 Cell별 Vdev_i = U_Cell_i − robust_center(다른 7개 Cell), robust z-score, voltage closure error를 우선 사용하라.
- outlier Cell 번호는 데이터에서 계산된 결과만 사용하고 Cell 8을 사전 가정하거나 하드코딩하지 마라.
- resistance/voltage pattern만으로 전기화학적 열화, 커넥터 저항, 부식, 정확한 반품 원인을 확정하지 마라.
- 허용되는 최대 결론은 “Cell N 경로의 유효 직렬저항 증가” 후보이며, 그보다 구체적인 물리 원인은 Inferred 후보·반증·추가 검사 필요로 남겨라.
- 관련 가설 domain은 Cell/Pack, Electrical Path, Operating Condition, Balancing/BMS, Thermal/Sensor, Battery/BMS다.
- Vdev(전압 잔차, B-F3)와 이벤트 저항(B-F1)이 다른 Cell을 가리키면 둘 다 사실로 적고 하나로 합치지 마라.`);
  }

  if (!sections.length) {
    sections.push(`[일반 BMS/EMS 로그 규칙]
- 명시적 alarm/fault 값과 수치 파생 이상을 분리하고, 로그에 없는 정상범위·원인을 만들지 마라.
- 장비 domain을 데이터의 컬럼과 시간 패턴으로 선택하며 불확실하면 Communication/Sensor 또는 추가 확인 필요로 남겨라.`);
  }
  return sections.join('\n\n');
}

export function buildDetectIssuesPrompt({ combinedLogText, totalRows, sourceCount, sourceProfiles, sourceFormats }) {
  return `[BMS/EMS 로그 데이터 — 총 ${sourceCount}개 출처 파일, 합계 ${totalRows}행]
[감지된 출처 포맷]
${sourceProfileText(sourceProfiles, sourceFormats)}

${combinedLogText}

작업: 위 로그 데이터를 검토하여 CS(고객지원) 이슈 의뢰로 특정될 만한 사건을 자동으로 탐지하라.
- 알람 코드 발생, 포맷별 파생지표(예: MEASURED_MW robust z/ramp, cross-cell Vdev/closure), 정상범위 이탈, 급격한 변화 패턴을 근거로 판단하라.
- 시간상 근접하고 동일 원인으로 보이는 알람은 하나의 이슈로 묶고, 서로 다른 시점·다른 알람 유형은 별개 이슈로 구분하라.
- 최대 4개까지 식별하라. 로그에 실제 존재하는 값만 인용하고 임의로 만들지 마라.
- 이상 징후가 전혀 없으면 issues를 빈 배열로 반환하라.

각 이슈는 다음을 포함해야 한다:
- title: 이슈를 한 줄로 요약한 제목 (예: "랙 #3 과전압(OV001) 경보")
- occurredAt: 로그에 근거한 발생 일시 (알 수 없으면 "미상")
- sourceFile: 해당 이슈가 발견된 출처 파일명
- description: CS 이슈 의뢰 문서 형식의 2~3문장 서술 (발생 일시·증상·관측 수치·이력 여부를 포함해, 실제 CS 담당자가 작성한 것처럼 서술)
- alarmCodes: 관련 알람 코드 배열. 파생 이상만 있는 경우 빈 배열로 둔다.
- level: "고"|"중"|"저" (심각도 초벌 판단)`;
}

export function buildDetectAnomalyPrompt({ csText, priorCase, combinedLogText, totalRows, sourceCount, sourceProfiles, sourceFormats }) {
  return `[CS 이슈 의뢰 내용]
${csText}

[참고 유사 케이스]
${priorCase || '없음'}

[감지된 출처 포맷]
${sourceProfileText(sourceProfiles, sourceFormats)}

[포맷별 분석 규칙]
${formatGuidance(sourceProfiles, sourceFormats)}

[BMS/EMS 로그 데이터 — 총 ${sourceCount}개 출처 파일, 합계 ${totalRows}행 (원본 대용량 로그는 스트리밍 방식으로 전체를 스캔한 뒤, 통계·파생 요약과 알람 전후 구간만 발췌한 것임)]
${combinedLogText}

작업:
1) CS 의뢰 텍스트에서 이슈 유형, 설비, 발생 시각, 이력 정보를 구조화하라.
2) 각 출처 파일에서 이상 구간(명시적 alarm/fault, 포맷별 파생지표, 정상범위 이탈, 급격한 변화)을 식별하라. 통계는 전체 행을 스트리밍 집계한 값이며, 개별 수치는 제공된 샘플·알람 컨텍스트·파생 요약에 실제 등장하는 값만 인용하고 임의로 만들지 마라. 여러 출처 파일 간 시간대가 겹치면 상호 연관성도 고려하라. 이상 구간이 없다면 anomalyWindows를 빈 배열로 반환하라.
3) 각 이상 구간 항목에는 반드시 어느 출처 파일(sourceFile)에서 발견되었는지 명시하라.
4) evidenceTier는 원문에서 직접 보인 값이면 Observed, 스트리밍 계산값이면 Derived로 표시하라. 인과적 해석을 anomalyWindows의 관측값처럼 쓰지 마라.`;
}

export function buildHypothesesPrompt({ issueStructured, anomalyWindows, priorCase, referenceDocsText, sourceProfiles, sourceFormats }) {
  const referenceSection = referenceDocsText && referenceDocsText.trim()
    ? `\n\n[참고 과거 보고서 발췌 — 엔지니어가 첨부한 유사 사례, 각 항목은 출처 파일명이 [참고 파일: ...]로 표시됨]
${referenceDocsText}

주의: 위 참고 보고서는 과거 다른 케이스의 기록이다. 절대로 참고 보고서의 수치·관측 내용을 이번
이상 구간 목록에 실제로 존재하는 것처럼 인용하지 마라 — actualObservation은 반드시 [이상 구간 목록]
에 있는 값만 사용하고, 참고 보고서는 evidence에서 "유사 사례 대비" 식으로만 정성적으로 언급하라.`
    : '';

  return `[감지된 출처 포맷]
${sourceProfileText(sourceProfiles, sourceFormats)}

[포맷별 분석 규칙]
${formatGuidance(sourceProfiles, sourceFormats)}

[이슈 구조화 정보]
${JSON.stringify(issueStructured)}

[이상 구간 목록]
${JSON.stringify(anomalyWindows)}

[참고 유사 케이스]
${priorCase || '없음'}${referenceSection}

작업: 위 이상 구간 패턴을 근거로 관련 domain에서 원인 가설을 2~3개 생성하라. 서로 다른 가설은 expected signature와 반증 조건이 달라야 한다. 각 가설은 아래 요소를 모두 포함해야 한다.
- domain: 포맷 규칙에 맞는 domain 하나
- expectedSignature: 이 원인이 사실이라면 로그에 나타나야 할 신호
- actualObservation: 실제 로그에서 관측된 내용 (이상구간 목록의 수치만 인용)
- evidence: 이 가설을 지지 또는 반증하는 근거 1~2문장
- evidenceTier: 원인 가설은 반드시 Inferred. Observed/Derived 신호를 Inferred 결론과 섞지 마라.
- disconfirmingEvidence: 이 가설이 틀렸다고 판단할 수 있는 구체적 증거
- missingSignals: 확인에 필요하지만 현재 공개 로그에 없는 신호
- claimLimit: 현재 데이터가 입증할 수 있는 범위와 입증할 수 없는 범위
- confidence: "High" | "Medium" | "Low"
- severityDraft: "상" | "중" | "하"
- severityReason: 심각도 판단 근거 1문장

cell-array 포맷이면 claimLimit에 반드시 “Cell N 경로의 유효 직렬저항 증가” 수준까지만 입증 가능하고 전기화학적 열화·커넥터·부식·정확한 반품 원인은 확정할 수 없다는 제한을 명시하라. 그 물리 원인을 확정하는 문장을 name/actualObservation/evidence에 쓰지 마라. 반증·누락 신호를 생략하지 마라.`;
}

function timeHorizonPromptBlock(sourceProfiles) {
  const profiles = Array.isArray(sourceProfiles) ? sourceProfiles : [];
  const withTime = profiles.filter(p => p.dataTimeRange || p.evidenceTimeRange);
  if (!withTime.length) return '';
  const lines = withTime.map(p => {
    const pct = Number.isFinite(p.timeCoverageRatio)
      ? `${Math.round(p.timeCoverageRatio * 1000) / 10}%`
      : '미상';
    return `- ${p.sourceFile || '출처'}: 데이터 ${formatProfileTimeRange(p.dataTimeRange)}, 알람 근거 ${formatProfileTimeRange(p.evidenceTimeRange)}, 커버리지 ${pct}`;
  });
  return `
[시간 커버리지 — 사실 기록. 결론을 지시하지 않는다]
${lines.join('\n')}
- 근거 시간 범위가 데이터 전체의 일부에 몰려 있으면 headline과 rootCause에 그 근거 구간을 명시하고, 전체 구간 특성으로 단정하지 마라.
- 데이터가 수개월~수년에 걸쳐 있는데 근거가 그보다 짧은 창만 덮으면, unknownBox에 장기 거동이 이 근거로는 미확인임을 적어라. 근거 없는 장기 결론을 만들지 마라.
- Figure 카탈로그의 timeRange는 각 그림이 덮는 구간이며 알람 근거 구간과 다를 수 있다. 둘을 같은 구간인 것처럼 쓰지 마라.
`;
}

function attributionConflictPromptBlock(conflict) {
  if (!conflict || conflict.status !== 'conflict') return '';
  const v = conflict.voltageResidual || {};
  const r = conflict.eventResistance || {};
  const share = Number.isFinite(v.share) ? `${(Math.round(v.share * 1000) / 10).toFixed(1).replace(/\.0$/, '')}%` : '—';
  const count = Number.isFinite(v.count) ? v.count : '—';
  const total = Number.isFinite(v.total) ? v.total : '—';
  return `
[교차 지목 사실 — 전압 잔차 vs 이벤트 저항]
- 전압 잔차(Vdev, 파생 이상 행 outlierCell 집계): ${v.cell || '—'}, ${count}/${total}건 (${share})
- 이벤트 저항(B-F1): ${r.cell || '—'}, deltaR=${r.deltaR ?? '—'}, matchedCount=${r.matchedCount ?? '—'}, droppedEvents=${r.droppedEvents ?? '—'}, eventCount=${r.eventCount ?? '—'}
- 전압 잔차는 저항이 아니다. 이벤트 저항은 전류 전이 이벤트가 포착된 구간에만 존재한다.
- 이 블록은 사실 기록이다. 어느 셀을 채택하라는 결론을 지시하지 않는다.
`;
}

export function buildDraftReportPrompt({
  issueStructured, anomalyWindows, confirmedHyp, finalSeverity, finalSeverityReason,
  sourceProfiles, sourceFormats, figureCatalog, evidenceLedger, attributionConflict
}) {
  const profiles = normalizeProfiles(sourceProfiles, sourceFormats);
  const cellArray = profiles.some(profile => profile.formatId === 'lfp-cell-array');
  const aemo = profiles.some(profile => profile.formatId === 'aemo-mms');
  const limitation = cellArray
    ? '\n- cell-array 출처에서는 최종 원인을 “Cell N 경로의 유효 직렬저항 증가” 수준으로만 표현하고, 전기화학적 열화·커넥터·부식 등은 확정 원인이 아닌 미확인 대안으로 유지하라. unknownBox에 그 한계를 적어라. Vdev(전압 잔차)와 이벤트 저항을 같은 원인으로 합치지 마라.'
    : '';
  const aemoLimit = aemo
    ? '\n- aemo-mms에서 A-F4가 common-mode이면 Local PCS/BMS를 확정하지 마라. provider 소프트웨어·내부 dispatch는 unknownBox. A-F6가 unavailable이면 Actual vs Target 선후는 판단 불가로 남겨라.'
    : '';
  return `[감지된 출처 포맷]
${sourceProfileText(sourceProfiles, sourceFormats)}
${timeHorizonPromptBlock(profiles)}
[이슈 구조화 정보] ${JSON.stringify(issueStructured)}
[이상 구간] ${JSON.stringify(anomalyWindows)}
[엔지니어 확정 원인 가설] ${JSON.stringify(confirmedHyp)}
[엔지니어 최종 심각도] ${finalSeverity} (사유: ${finalSeverityReason})
[Figure 카탈로그 — 시계열 포인트는 없음. available=true인 id만 인용 가능]
${JSON.stringify(figureCatalog || [])}
[Evidence ledger 요약]
${JSON.stringify(evidenceLedger || [])}
${attributionConflictPromptBlock(attributionConflict)}
작업: 위 내용을 종합하여 분석 보고서 초안과 CS 회신 메일 초안을 작성하라.
- headline은 제목이 아니라 결론형 한 문장이다. "분석 결과" 같은 제목 금지.
- Observed 사실, Derived 파생지표, Inferred 가설을 문장 수준에서 구분하고, evidence가 부족하면 “추가 확인 필요”로 표기하라.
- available Figure가 하나라도 있으면 evidenceCitations에 headline 또는 rootCause 항목으로 그 figureIds를 최소 1개 포함하라. 포인트를 만들어내지 말고 카탈로그 id만 인용하라.
- provenBox: Observed만. suggestedBox: 복수 근거 inference. unknownBox: 이 데이터로 판단 불가.
- independentFindings: RAW에서 도출한 독립 finding 1~3개. 공개 보고서/논문 결론을 베끼지 마라.
- ftaLeaves: 관련 domain branch와 Confirmed/Probable/Possible/Unlikely/Rejected/Unobservable.
- occurrence, anomalySummary, rootCause, actionRecommendation은 각 2~3문장 이내.${limitation}${aemoLimit}
- email.body에는 인사말, 현상, 추정 원인, 심각도, 조치 방향, 맺음말을 포함한 완결된 메일 본문을 작성한다.`;
}

export function buildPublishedComparisonPrompt({ independentFindings, figureCatalog, publishedExcerpt, sourceProfiles, sourceFormats }) {
  return `[독립 분석 findings — 이 배열을 수정·재작성·삭제하지 말고 표의 independentFinding 열에 그대로 반영하라]
${JSON.stringify(independentFindings)}

[독립 분석 Figure 카탈로그]
${JSON.stringify(figureCatalog || [])}

[공개 보고서 또는 논문 발췌 — 마지막 교차검증 자료일 뿐, Observed 사실이 아님]
${publishedExcerpt}

[출처 포맷]
${sourceProfileText(sourceProfiles, sourceFormats)}

작업: 독립 분석 vs 공개 결과를 행 단위로 대조하라.
- independentFinding 열은 위 findings를 보존한다. 공개 수치를 독립 관측인 척 쓰지 마라.
- AEMO self-forecast 내부 로직, 논문 GP fault probability(미구현)는 rawSufficient=false.
- 전압 잔차(Vdev)와 논문의 시간의존 저항이 다른 셀을 가리키면 오류로 기록하지 말고 notes에 지표 정의 차이를 적어라.
- agree는 yes|no|partial|unknown.`;
}
