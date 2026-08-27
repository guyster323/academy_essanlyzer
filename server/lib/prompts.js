export const PERSONA = "당신은 LG에너지솔루션 ESS(Energy Storage System) BMS/EMS 분석 전문 엔지니어입니다. 데이터에 근거해 엄격하고 간결하게 판단하며, 로그에 존재하지 않는 수치나 사실을 추정하여 만들어내지 않습니다. 확인이 필요한 사항은 명확히 '추가 확인 필요'로 표기합니다.";

export function buildDetectIssuesPrompt({ combinedLogText, totalRows, sourceCount }) {
  return `[BMS/EMS 로그 데이터 — 총 ${sourceCount}개 출처 파일, 합계 ${totalRows}행]
${combinedLogText}

작업: 위 로그 데이터를 검토하여 CS(고객지원) 이슈 의뢰로 특정될 만한 사건을 자동으로 탐지하라.
- 알람 코드 발생, 정상범위 이탈, 급격한 변화 패턴을 근거로 판단하라.
- 시간상 근접하고 동일 원인으로 보이는 알람은 하나의 이슈로 묶고, 서로 다른 시점·다른 알람 유형은 별개 이슈로 구분하라.
- 최대 4개까지 식별하라. 로그에 실제 존재하는 값만 인용하고 임의로 만들지 마라.
- 이상 징후가 전혀 없으면 issues를 빈 배열로 반환하라.

각 이슈는 다음을 포함해야 한다:
- title: 이슈를 한 줄로 요약한 제목 (예: "랙 #3 과전압(OV001) 경보")
- occurredAt: 로그에 근거한 발생 일시 (알 수 없으면 "미상")
- sourceFile: 해당 이슈가 발견된 출처 파일명
- description: CS 이슈 의뢰 문서 형식의 2~3문장 서술 (발생 일시·증상·관측 수치·이력 여부를 포함해, 실제 CS 담당자가 작성한 것처럼 서술)
- alarmCodes: 관련 알람 코드 배열
- level: "고"|"중"|"저" (심각도 초벌 판단)`;
}

export function buildDetectAnomalyPrompt({ csText, priorCase, combinedLogText, totalRows, sourceCount }) {
  return `[CS 이슈 의뢰 내용]
${csText}

[참고 유사 케이스]
${priorCase || '없음'}

[BMS/EMS 로그 데이터 — 총 ${sourceCount}개 출처 파일, 합계 ${totalRows}행 (원본 대용량 로그는 스트리밍 방식으로 전체를 스캔한 뒤, 통계와 알람 전후 구간만 발췌한 것임)]
${combinedLogText}

작업:
1) CS 의뢰 텍스트에서 이슈 유형, 설비, 발생 시각, 이력 정보를 구조화하라.
2) 각 출처 파일에서 이상 구간(정상범위 이탈, 알람 코드, 급격한 변화)을 식별하라. 통계는 전체 행을 스트리밍 집계한 값이므로 신뢰할 수 있으나, 개별 수치는 제공된 샘플·알람 컨텍스트에 실제 등장하는 값만 인용하고 임의로 만들지 마라. 여러 출처 파일 간 시간대가 겹치면 상호 연관성도 고려하라. 이상 구간이 없다면 anomalyWindows를 빈 배열로 반환하라.
3) 각 이상 구간 항목에는 반드시 어느 출처 파일(sourceFile)에서 발견되었는지 명시하라.`;
}

export function buildHypothesesPrompt({ issueStructured, anomalyWindows, priorCase, referenceDocsText }) {
  const referenceSection = referenceDocsText && referenceDocsText.trim()
    ? `\n\n[참고 과거 보고서 발췌 — 엔지니어가 첨부한 유사 사례, 각 항목은 출처 파일명이 [참고 파일: ...]로 표시됨]
${referenceDocsText}

주의: 위 참고 보고서는 과거 다른 케이스의 기록이다. 절대로 참고 보고서의 수치·관측 내용을 이번
이상 구간 목록에 실제로 존재하는 것처럼 인용하지 마라 — actualObservation은 반드시 [이상 구간 목록]
에 있는 값만 사용하고, 참고 보고서는 evidence에서 "유사 사례 대비" 식으로만 정성적으로 언급하라.`
    : '';

  return `[이슈 구조화 정보]
${JSON.stringify(issueStructured)}

[이상 구간 목록]
${JSON.stringify(anomalyWindows)}

[참고 유사 케이스]
${priorCase || '없음'}${referenceSection}

작업: 위 이상 구간 패턴을 근거로 원인 가설을 2~3개 생성하라. 각 가설은 아래 요소를 모두 포함해야 한다.
- domain: "Battery/BMS" | "PCS" | "EMS" | "Contactor/CB" | "Cooling/HVAC" | "Communication/Sensor" 중 하나
- expectedSignature: 이 원인이 사실이라면 로그에 나타나야 할 신호
- actualObservation: 실제 로그에서 관측된 내용 (이상구간 목록의 수치를 인용)
- evidence: 이 가설을 지지 또는 반증하는 근거 1~2문장
- confidence: "High" | "Medium" | "Low"
- severityDraft: "상" | "중" | "하"
- severityReason: 심각도 판단 근거 1문장`;
}

export function buildDraftReportPrompt({ issueStructured, anomalyWindows, confirmedHyp, finalSeverity, finalSeverityReason }) {
  return `[이슈 구조화 정보] ${JSON.stringify(issueStructured)}
[이상 구간] ${JSON.stringify(anomalyWindows)}
[엔지니어 확정 원인 가설] ${JSON.stringify(confirmedHyp)}
[엔지니어 최종 심각도] ${finalSeverity} (사유: ${finalSeverityReason})

작업: 위 내용을 종합하여 분석 보고서 초안과 CS 회신 메일 초안을 작성하라.
- headline은 전체 분석을 한 줄로 꿰뚫는 핵심 메시지여야 한다 (추측성 표현 배제).
- 모든 문장은 단정하고 간결한 보고서 문체를 사용한다.
- occurrence(발생 개요), anomalySummary(이상 구간 요약), rootCause(확정 원인 및 근거), actionRecommendation(조치 권고)은 각 2~3문장 이내로 작성한다.
- email.body에는 인사말, 현상, 추정 원인, 심각도, 조치 방향, 맺음말을 포함한 완결된 메일 본문을 작성한다.`;
}
