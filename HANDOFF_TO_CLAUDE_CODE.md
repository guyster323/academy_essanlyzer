# ESS BMS 이슈 분석 워크스테이션 — Claude Code 이관 가이드

> 이 문서는 Claude.ai 아티팩트 환경에서 만든 `ess_bms_analysis_workstation.html` 프로토타입을
> Claude Code로 이어서 개발하기 위한 컨텍스트 문서입니다. `ess_bms_analysis_workstation.html`과
> 이 문서를 같은 폴더에 두고 Claude Code 세션을 시작하면, 지금까지의 설계 배경을 다시 설명할
> 필요 없이 바로 이어서 작업할 수 있습니다.

---

## 1. 프로젝트 개요

**목적**: LG에너지솔루션 ESS 분석파트의 CS 의뢰 기반 BMS/EMS 이슈 분석 업무(주 2~3건, 건당 5~6시간)를
반자동 워크플로우로 단축. "사람이 핵심 판단(가설 방향·심각도 확정)을 하고, AI가 초안을 생성"하는
구조가 원칙.

**현재 산출물**: 단일 HTML 파일(`ess_bms_analysis_workstation.html`)로 동작하는 프런트엔드 프로토타입.
백엔드 없이 Claude.ai 아티팩트 샌드박스 안에서만 완결적으로 동작함(2번 항목 참고).

**핵심 워크플로우** (Step 1~5):
1. BMS/EMS 로그 업로드 (CSV/TXT/LOG 파일 또는 ZIP 아카이브, 폴더 구조 무관)
2. 로그 자동 스캔 → 이슈 후보 자동 감지 (복수 이슈 시 카드로 선택) → CS 의뢰 텍스트 자동 채움
3. AI가 이상 구간 탐지 (타임스탬프·파라미터·편차·알람코드)
4. AI가 원인 가설 2~3개 생성 (FTA 스타일: expectedSignature / actualObservation / evidence)
5. **사람 검토 체크포인트**: 가설 선택 + 심각도(상/중/하) 최종 확정 — 여기만 사람이 반드시 개입
6. AI가 분석 보고서 초안 + CS 회신 메일 초안 동시 생성

---

## 2. 현재 아키텍처와 반드시 알아야 할 제약

### 2-1. AI 호출 방식 (가장 중요)
현재 파일은 다음과 같이 API 키 없이 직접 Anthropic API를 호출합니다.

```javascript
async function callClaude(prompt){
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{role: "user", content: prompt}]
    })
  });
  ...
}
```

이 방식은 **Claude.ai 아티팩트 샌드박스에서만 유효한 특수 브리지**입니다. 로컬에서 파일을 열거나
Claude Code로 개발 서버를 띄우는 순간 CORS/인증 오류로 동작하지 않습니다.

**→ Claude Code에서 가장 먼저 할 작업**: `ANTHROPIC_API_KEY`를 보관하는 백엔드(Node/Express 등)를
만들고, 프런트엔드는 자체 엔드포인트(`/api/detect-issues`, `/api/detect-anomaly`,
`/api/generate-hypotheses`, `/api/draft-report`)만 호출하도록 `callClaude()`를 리팩터링해야 합니다.
과거 검토했던 WDBESS1 데모 앱의 `server.ts` 구조(Express + `GoogleGenAI`/`Anthropic` SDK 호출,
`.env`로 키 관리)를 참고 패턴으로 삼을 수 있습니다.

### 2-2. 로그 처리 아키텍처 (500MB+ 대응)
- 파일을 문자열로 통째로 읽지 않고, 4MB 청크 단위로 스트리밍 처리 (`fileByteChunks`, `zipEntryByteChunks`)
- ZIP은 `JSZip.loadAsync(file)`로 Blob을 직접 전달, 항목별로 `entry.internalStream()`을 통해 청크 단위 압축 해제
- 파일당 컬럼 통계(min/max/avg)는 running 방식으로 누적, 원본 행은 보관하지 않음
- 알람/이상코드 발생 시점은 최근 5행 슬라이딩 윈도우를 스냅샷해 최대 40건까지만 보관
- **결과적으로 AI 프롬프트에 들어가는 데이터양은 원본 파일 크기와 무관하게 항상 일정** — 이 설계는
  그대로 유지하는 것을 권장합니다. 백엔드로 옮기더라도 이 스트리밍 로직 자체는 프런트엔드(또는
  백엔드 업로드 처리)에 그대로 재사용 가능합니다.
- 인코딩은 UTF-8 시험 디코딩 실패 시 EUC-KR로 자동 폴백, 파일별 수동 전환 드롭다운 제공

현재 어댑터는 세 종류다.

- AEMO MMS는 `FPP_UNITID`를 `PARTICIPANTID`보다 우선해 물리 설비별로 묶는다. `MW_QUALITY_FLAG`는
  품질 보조 신호이고, `MEASURED_MW`의 짧은 rolling mean/std·MAD robust z-score·ramp를 별도
  파생 이상으로 계산한다. 알려진 사건 시각을 탐지 시작점으로 사용하지 않는다.
- LFP cell-array는 `Timestamp + U_Battery + U_Cell_1..8` 헤더로 인식한다. entity 컬럼을 만들지
  않고 파일 하나를 system 하나로 취급하며, 각 행의 leave-one-out peer median 기반 Vdev, robust
  z-score, 가능한 voltage closure error를 계산한다. outlier Cell은 데이터에서 결정한다.
- 파생 훅은 `computeDerivedAlarm(rowObj, acc, bucket)` 형태로 포맷에 붙고, bucket에는 작은 rolling
  state와 capped alarm context/metric summary만 남는다. 정적 alarm/fault 컬럼이 없어도 분석을
  진행하지만, 파생 결과는 `Derived` 근거로만 다룬다.

JSZip 압축 해제 중 `uncompressed data size mismatch`가 발생하면 entry 단위로 오류를 정규화해 해당
항목만 오류 상태/오류 수준 제외 메모로 남긴다. sibling entry 순회는 계속되며, 이 fallback은 파일
형식 지원을 막는 조건이 아니다.

### 2-3. 상태 관리
- 별도 프레임워크 없이 순수 vanilla JS + 전역 `state` 객체 + `render()` 전체 재렌더 방식
- `state.logSources[]`: 업로드된 각 로그 파일의 처리 상태/통계/샘플을 담는 배열
- `caseHistory[]`: 세션 내 완료된 케이스 기록 (새로고침 시 소실 — 영구 저장 아님)
- 브라우저 스토리지(localStorage 등) 미사용 — Claude.ai 아티팩트 정책상 사용 불가했던 제약이었으나,
  일반 웹앱으로 옮기면 IndexedDB나 실제 DB 연동을 고려할 수 있음

### 2-4. 사람 검토 체크포인트 설계 원칙
가설 선택과 심각도 확정 단계는 AI가 자동으로 넘어가지 않도록 UI에서 명시적으로 막아뒀습니다
(`selectedHypId`, `finalSeverity`가 확정되어야 다음 단계 버튼 활성화). 이 원칙은 청사진 단계부터
합의된 "AI가 판정하지 않고 초안만 만든다"는 안전장치이므로, 기능을 추가하더라도 이 구조는
유지해야 합니다.

### 2-5. 포맷 인식형 가설 생성과 증거 계층

이상 구간은 `Observed`(원문에 직접 존재) 또는 `Derived`(스트리밍 계산)로 표시하고, 원인 가설은
`Inferred`로 표시합니다. 가설 응답에는 `disconfirmingEvidence`, `missingSignals`, `claimLimit`이
필수입니다. AEMO 계통 telemetry에서는 Battery/BMS·PCS·PPC·EMS·Telemetry/SCADA·Dispatch·Forecast·
Grid·Normal Response domain을 사용하고, LFP cell-array에서는 Cell/Pack·Electrical Path·운영조건·
balancing·thermal domain을 사용합니다.

이상구간·보고서는 클라이언트 캔버스 Figure(A-F1~F5, B-F1~F4·F6)와 Evidence ledger를 포함합니다.
시계열은 브라우저에만 남고 프롬프트에는 Figure 카탈로그(ID·claim·요약 통계)만 전달합니다.
공개 결과 대조(`/api/compare-published`)는 독립 findings를 동결한 뒤 마지막에만 실행합니다.

LFP 로그의 resistance/voltage pattern만으로 전기화학적 열화, 커넥터 저항, 부식, 실제 반품 사유를
확정할 수 없습니다. 서버 검증은 cell-array 응답이 `Cell N 경로의 유효 직렬저항 증가` 수준의
주장 한계와 물리 원인 미확정을 명시하도록 요구합니다. 이 제한은 `selectedHypId`와
`finalSeverity`를 사람이 확정해야 하는 기존 게이트와 별개로 유지됩니다.

---

## 3. 지금까지의 개선 이력 (요약)

| 순서 | 요청 내용 | 반영 결과 |
|---|---|---|
| 1 | PoC 청사진과 초기 Build 앱(WDBESS1 데모) 분석 및 Gap 진단 | 입력 레이어·AI 처리 체인·CS 메일 모듈이 전무했음을 확인 |
| 2 | Phase 1~3 개선 기획 → HTML 아티팩트로 구현 | 입력 폼 + 5단계 AI 체인 + 사람 검토 체크포인트 + CS 메일 초안 |
| 3 | CS 의뢰 입력을 편하게 — 빠른 입력 템플릿 | 9종 진단 유형별 템플릿 칩 (클릭 → 플레이스홀더 자동 선택) |
| 4 | ZIP 업로드 및 다양한 폴더/파일 구조 대응 | JSZip 연동, 재귀 스캔, 후보 파일 점수화·다중 선택 |
| 5 | 인코딩 문제 개선 + 500MB급 로그 대응 | UTF-8/EUC-KR 자동감지, 청크 스트리밍 파서로 전면 재설계 |
| 6 | Step 1(CS 의뢰 입력) 자동화 | 업로드 완료 시 로그 자동 분석 → 이슈 후보 카드 → 클릭으로 CS 의뢰란 자동 채움 |

---

## 4. Claude Code 이관 절차

| 단계 | 작업 |
|---|---|
| ① 파일 확보 | `ess_bms_analysis_workstation.html`과 이 문서를 같은 로컬 폴더에 저장 |
| ② Claude Code 설치 | 네이티브 설치(권장, Node.js 불필요): `curl -fsSL https://claude.ai/install.sh \| bash` (macOS/Linux/WSL) 또는 Windows PowerShell: `irm https://claude.ai/install.ps1 \| iex`. Claude Pro/Max/Team/Enterprise 또는 Console 계정 필요 |
| ③ 프로젝트 폴더 구성 | 이 폴더에서 `claude` 명령으로 세션 시작 |
| ④ 컨텍스트 전달 | 아래 5번의 시작 프롬프트를 그대로 입력 |
| ⑤ 백엔드 프록시 구현 | ANTHROPIC_API_KEY를 서버에 두고, 프런트엔드는 자체 API만 호출하도록 리팩터링 |

---

## 5. Claude Code 시작 프롬프트 (그대로 붙여넣기 권장)

```
이 폴더의 ess_bms_analysis_workstation.html과 HANDOFF_TO_CLAUDE_CODE.md를 읽고 시작해줘.

이 HTML은 Claude.ai 아티팩트 환경에서 만든 ESS BMS 이슈 분석 워크스테이션 프로토타입이야.
현재는 브라우저에서 https://api.anthropic.com/v1/messages 를 API 키 없이 직접 호출하는데,
이건 아티팩트 샌드박스 전용 기능이라 로컬/배포 환경에서는 동작하지 않아.

다음을 해줘:
1. Node.js/Express 백엔드를 새로 만들어서 ANTHROPIC_API_KEY를 .env로 관리하고,
   프런트엔드가 이 백엔드의 /api/detect-issues, /api/detect-anomaly,
   /api/generate-hypotheses, /api/draft-report 엔드포인트를 호출하도록 리팩터링해줘.
2. 프런트엔드 로직(스트리밍 로그 파서, ZIP 처리, 상태 관리, 사람 검토 체크포인트)은
   그대로 유지하고, callClaude() 함수만 백엔드 엔드포인트를 호출하도록 바꿔줘.
3. 파일 구조를 src/, server/ 로 분리하고 package.json, .gitignore(.env 포함), README를 추가해줘.
4. JSZip은 CDN 대신 npm install jszip으로 번들링해줘.
5. 작업 전에 변경 계획을 먼저 요약해서 보여주고, 내 확인 후 진행해줘.
```

---

## 6. 이관 후에도 유지해야 할 원칙 (Claude Code에도 상기시킬 것)

- **사람 검토 체크포인트는 절대 생략하지 말 것** — 가설 확정·심각도 판정은 AI가 자동 결정하지 않음
- **프롬프트에는 원본 로그 전체가 아니라 스트리밍 집계 결과(통계/헤드샘플/알람 컨텍스트)만 전달** — 파일 크기가 커져도 프롬프트 크기는 고정
- **파생지표도 bounded summary로만 전달** — AEMO MW 통계와 LFP cross-cell Vdev/closure를 포함하되 전체 행/전체 파일을 버퍼링하지 않음
- **근거 계층과 물리적 한계 유지** — Observed/Derived/Inferred를 분리하고 cell-array 저항 패턴을 특정 물리 원인으로 확정하지 않음
- **실 고객 데이터·실 설비명은 절대 커밋하지 말 것** — 샘플/가상 데이터로만 개발 및 테스트 (사내 보안 절차 대상)
- **보고서 톤앤매너**: Headline 한 줄 → 관측 사실 → 기술적 의미 → 판단 순서 유지 (기존 프롬프트에 이미 반영됨)
