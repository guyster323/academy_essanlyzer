<p align="center">
  <strong>🇰🇷 한국어</strong> · <a href="README.en.md">🇺🇸 English</a>
</p>

<p align="center">
  <a href="docs/GETTING_STARTED.md"><strong>🔰 처음이신가요? 초보자 가이드 먼저 보기 →</strong></a>
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%5E20.19%20%7C%20%3E%3D22.12-339933?logo=node.js&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white">
  <img alt="Claude" src="https://img.shields.io/badge/AI-Claude-D97757?logo=anthropic&logoColor=white">
  <img alt="Status" src="https://img.shields.io/badge/status-internal%20PoC-yellow">
</p>

<p align="center">
  <img src="docs/assets/demo-case-b-hero.gif" alt="Case B(Darmstadt LFP) 분석 데모" width="720">
</p>

<p align="center">
  ▶️ <a href="docs/assets/demo-case-b.mp4">전체 데모 영상 보기 (MP4, 38초 편집본)</a> —
  업로드→이상탐지→가설→사람 검토→보고서. 실제 소요는 내장 샘플 약 15분, 골드 Case B 약 29–36분이며
  이 클립은 대기 구간을 잘라 낸 것입니다.
</p>

---

# ESS BMS 이슈 분석 워크스테이션

LG에너지솔루션 ESS 분석파트의 CS 의뢰 기반 BMS/EMS 이슈 분석 업무를 반자동화하는 워크스테이션.
사람이 핵심 판단(가설 선택·심각도 확정)을 하고, AI는 초안(이상 구간 탐지 → 원인 가설 → 보고서/메일)만
생성합니다 — 이 체크포인트는 어떤 기능을 추가하더라도 절대 생략하지 않습니다. 근거가 서로 어긋나면
(예: 전압 잔차가 Cell 8을, 이벤트 저항이 Cell 5를 가리킬 때) 앱이 한쪽을 채택하지 않습니다. 판단은
엔지니어의 몫이고, 이 도구의 역할은 판단할 근거를 빠짐없이 보여주는 것입니다.

> 이 문서는 이미 프로젝트 구조에 익숙한 개발자를 위한 기술 문서입니다. 처음 사용해보신다면
> [초보자 가이드](docs/GETTING_STARTED.md)를 먼저 읽으시길 권장합니다.

## 아키텍처

```
브라우저(src/)                         백엔드(server/)
├─ ZIP/중첩ZIP 카탈로그 + 스트리밍 파싱   ├─ /api/detect-issues
│  (파일은 로컬에서만 처리 — 업로드 없음)  ├─ /api/detect-anomaly
├─ 로그 포맷 자동 감지                    ├─ /api/generate-hypotheses
│  (일반 CSV / AEMO MMS / LFP cell-array)  └─ /api/draft-report
├─ 엔티티(BESS 등) 필터 + 그룹 집계          → AI_PROVIDER=cli(기본, 데모용) | api(운영용)
└─ 통계/샘플/알람 컨텍스트만 백엔드 전송
```

- **원본 로그 파일은 브라우저를 벗어나지 않습니다.** 4MB 청크로 스트리밍 파싱하며, 파일 크기가
  얼마든(500MB+, 심지어 zip 안에 zip이 들어있는 3GB+ 아카이브도) AI에게 보내는 프롬프트 크기는
  통계·헤드 샘플·알람 전후 컨텍스트로 고정됩니다.
- 백엔드는 프런트엔드가 보낸 집계 데이터로 프롬프트를 조립해 AI를 호출할 뿐, 원본 로그를 받지 않습니다.

### AI 호출 방식 (데모 vs 운영)

`.env`의 `AI_PROVIDER`로 전환합니다.

| 값 | 동작 | 필요한 것 | 구현 |
|---|---|---|---|
| `cli`(기본) | 로컬에 설치된 **Claude Code CLI**(`claude -p`)를 서브프로세스로 호출 | 이 머신에 `claude` 설치·로그인(구독 인증 재사용, 별도 API 키/과금 불필요) | `server/lib/claude-cli.js` |
| `api` | Anthropic Messages API를 SDK로 직접 호출(토큰 종량 과금) | `.env`의 `ANTHROPIC_API_KEY` | `server/lib/anthropic.js` |

두 경로 모두 동일한 `server/lib/schemas.js`의 JSON Schema를 구조화 출력 강제에 사용합니다
(`api`는 tool-use `strict:true`, `cli`는 `--json-schema` 플래그). 라우트(`server/lib/ai-provider.js`)는
`AI_PROVIDER` 값만 보고 두 구현 중 하나로 분기하므로 나머지 코드는 provider를 모릅니다.

`cli` 모드는 Claude Code 하네스를 매 호출마다 새로 띄우는 구조라 API 직접 호출보다 느립니다. 새 포맷
인식 프롬프트(파생 통계 교차 참조·근거 계층 구분·반증 요구)는 원래보다 더 엄격한 추론을 요구합니다.
실측(2026-08-30, `AI_PROVIDER=cli`): 초보자 가이드 내장 샘플(10행 generic CSV)은 호출당 214.3초 /
318.6초 / 340.7초(이상탐지·가설·보고서, 합계 873.6초 ≈ 14.6분). 골드 Case B
(`Log_sample/extracted/data_sys_6_stride80.csv`, 240,603행)는 이상탐지 707.8–1,139.8초(이전 실측,
이번에 재측정하지 않음 — `Report/latency-effort-real-outputs/COMPARISON.md`), 가설 557.4초·보고서
485.6초(오늘 실측) — 전 과정 약 29–36분. 샘플만 인용하면 대용량 경로를 숨기게 되므로 둘 다 적습니다.
느린 이유: 유효 런에서 출력 토큰의 87–94%가 extended thinking입니다(`Report/latency-findings.md`).
경과 시간이 올라가는 한 멈춘 것이 아닙니다. 타임아웃 기본값은 30분입니다
(`server/lib/claude-cli.js` `CLI_TIMEOUT_MS` = `1_800_000`).
로딩 화면에는 실시간 경과 시간과 단계별 안내가 표시됩니다. 드물게 모델이 스키마 형태만 맞춘 부실한
응답을 반환하는 경우가 있어 `server/lib/validation.js`가 플레이스홀더성 응답(예: 모든 필드가 `"test"`)을
거부하고, `server/routes/analysis.js`가 그런 502 실패에 한해 자동으로 1회 재시도합니다.

## 로그 포맷 지원

| 포맷 | 인식 방법 | 비고 |
|---|---|---|
| 일반 CSV/TSV | 첫 줄이 헤더, 이후 데이터 행 | 전형적인 BMS/EMS export |
| AEMO MMS 리포트 | `C,`(주석)/`I,`(헤더)/`D,`(데이터) 레코드 타입 | 실제 컬럼은 4번째 필드부터 시작 |
| LFP cell-array 필드 CSV | `Timestamp` + `U_Battery` + `U_Cell_1..8` 헤더 | 파일 1개를 system 1개로 보고 cross-cell 파생지표 + 이벤트 저항 계산 |

스트리밍 중 고정 크기 다운샘플 시계열을 브라우저에만 남기고, 이상구간·보고서 화면에 Figure를 그립니다
(A-F1~F5, B-F1~F4·F6). 포인트 배열은 Claude로 보내지 않습니다. GP/BattGP(B-F5)와 Dispatch Target(A-F6)은
데이터가 없으면 unavailable로 명시합니다. 공개 AEMO/논문 대조는 보고서 생성 이후 선택 단계입니다.
골든 케이스 체크리스트: `docs/verification/gold-case-acceptance.md`.

AEMO 포맷은 물리 설비 식별자인 `FPP_UNITID`를 시장 참여자 회사 코드인 `PARTICIPANTID`보다
우선하여 엔티티별로 그룹 집계합니다. `MW_QUALITY_FLAG != 1`은 품질 보조 신호로 남기되,
`MEASURED_MW` 전체 구간의 rolling mean/std·MAD robust z-score·ramp를 별도로 계산해 품질 플래그가
정상이어도 출력 이벤트를 탐지합니다. 값에 `BESS`가 포함된 엔티티가 감지되면 필터 입력칸에
자동으로 `BESS`를 채워 넣습니다(수정 가능). 실제 WDBESS1 공개 데이터(2025-08-19, 497MB)로
검증했을 때 `MW_QUALITY_FLAG`나 공개된 사건 시각에 전혀 의존하지 않고 534건의 독립 이상탐지를
관측했습니다.

LFP cell-array는 정적 alarm 컬럼이 없는 것을 정상으로 취급하지 않고, 각 행에서 각 Cell의
`Vdev_i = U_Cell_i - robust_center(다른 7개 Cell)`, robust z-score, `U_Battery - Σ(U_Cell_i)`를
계산합니다. 가장 벗어난 Cell은 데이터에서 선택하며 Cell 8을 사전 지정하지 않습니다. 모든 파생
통계와 알람 컨텍스트는 고정 크기 rolling/bounded 구조로만 보관됩니다. 실제 TU Darmstadt/MIT 공개
LFP field dataset으로 검증했을 때도 논문의 Cell 8 가정과 무관하게 데이터 기반으로 다른 Cell을
정확히 지목했습니다.

AI 단계에는 감지된 포맷 프로파일과 파생 요약이 함께 전달됩니다. 계통급 telemetry는 Battery/BMS,
PCS, PPC, EMS, Telemetry/SCADA, Dispatch, Forecast, Grid, 정상반응 domain을 사용하고, cell-array는
Cell/Pack·Electrical Path·Operating Condition·Balancing/BMS·Thermal/Sensor domain을 사용합니다.
모든 anomaly/hypothesis는 `Observed`·`Derived`·`Inferred` 근거 계층을 구분하며, 반증 가능 증거와
현재 로그에 없는 검증 신호를 명시합니다. cell-array의 저항/전압 패턴만으로 전기화학적 열화,
커넥터, 부식 또는 정확한 반품 원인을 확정하지 않고 최대 `Cell N 경로의 유효 직렬저항 증가`
수준으로 제한합니다.

## 실행 보고서(Executive Report) 구조

Step 5에서 생성되는 보고서는 단순 요약이 아니라, 과대 주장을 구조적으로 막도록 설계된 고정 스키마를
따릅니다(`server/lib/prompts.js`의 `buildDraftReportPrompt`, `server/lib/schemas.js`).

- **헤드라인**: 제목이 아니라 결론형 한 문장. "분석 결과" 같은 라벨성 문구는 거부됩니다.
- **발생 개요 / 이상 구간 요약 / 확정 원인 / 조치 권고**: 각 2~3문장 이내로, 문장 단위로
  `Observed`(원문 관측)·`Derived`(파생 계산)·`Inferred`(가설)를 구분해 서술합니다.
- **근거 그래프 인용**: `available: true`인 Figure가 하나라도 있으면 헤드라인 또는 확정 원인에
  최소 1개의 figure id를 인용하도록 강제됩니다(`server/lib/validation.js`) — 그림 없는 주장을
  막기 위함입니다. 인용은 카탈로그 id만 가능하며, 원문 시계열 포인트는 프롬프트에 실리지 않습니다.
- **FTA(Fault Tree Analysis)**: 관련 domain별 branch마다 `Confirmed`/`Probable`/`Possible`/
  `Unlikely`/`Rejected`/`Unobservable` 중 하나로 판정합니다.
- **3-box**: *데이터가 입증하는 것*(Observed만) · *데이터가 시사하는 것*(복수 근거의 inference) ·
  *데이터가 판단할 수 없는 것* 세 칸을 분리해, "시사하는 것"이 "입증하는 것"으로 슬쩍 넘어가지
  못하게 합니다.
- **Independent findings**: RAW 로그에서 직접 도출한 1~3개 finding만 허용되며, 공개 보고서·논문의
  결론을 그대로 베끼는 것은 금지됩니다.
- **HTML로 저장**: 차트를 클라이언트에서 PNG로 구워 넣어 완전히 자체완결된 단일 HTML 파일로
  다운로드합니다(`src/report-export.js`) — 서버·네트워크 없이도 그대로 열람·공유할 수 있습니다.
- **공개 결과와 대조(선택)**: 보고서 생성 이후에만 활성화되는 마지막 단계로, AEMO 공식 발표나
  논문 발췌를 붙여넣으면 독립 분석과 항목별로 대조한 표(일치 여부·RAW 충분 여부·비고)를
  추가로 만듭니다. 이 단계는 이미 확정된 independent findings를 절대 덮어쓰지 않습니다
  (`server/lib/prompts.js`의 `buildPublishedComparisonPrompt`).

실제 산출물 예시는 `Report/` 폴더에서 확인할 수 있습니다 — 공개 WDBESS1/AEMO 데이터로 만든
`case_a_report.html`(+ 공개 결과 대조본), TU Darmstadt/MIT LFP 공개 데이터로 만든
`case_b_report.html`, 그리고 진행 중 겪은 이슈와 해결 과정을 정리한 `case_b_findings.md`.

## 대용량 ZIP(중첩 zip 포함) 처리

7일치 × 500MB급 CSV가 zip 안에 또 zip으로 들어있는 것과 같은 대형 아카이브를 열면:
1. 먼저 목록만 카탈로그합니다(파일명·크기·포맷만 확인, 압축 해제는 안 함).
2. 20MB 이하 항목은 바로 스트리밍 집계됩니다(소규모 zip 편의성 유지).
3. 그보다 큰 항목은 "카탈로그됨" 상태로 남고, "분석 포함(스트리밍 시작)" 버튼을 눌러야 실제로
   스트리밍 파싱이 시작됩니다 — 원치 않는 대량 CPU/시간 소모를 방지합니다.

JSZip은 압축 해제 크기 필드를 32비트 부호 있는 정수로 읽어, 실제 크기가 2GB(2³¹바이트)를 넘는
항목에서 크기가 음수로 뒤집히고 내부 검증에서 `uncompressed data size mismatch`를 던지는 알려진
결함이 있습니다. 이 프로젝트는 그런 항목을 감지하면 ZIP local file header를 직접 파싱해 압축
데이터만 `File.slice()`로 읽고 별도의 스트리밍 inflate로 처리하는 대체 경로로 자동 전환해
2GB 이상 단일 항목도 끝까지 스트리밍합니다(`src/zip-stream.js`, `src/zip.js`에서 호출). 실제
공개 LFP field dataset의 2.75GB(19,248,213행) 항목으로 종단간 검증했습니다. 암호화·멀티디스크·
지원하지 않는 압축 방식이나 진짜 손상된 항목은 해당 로그만 `읽기 실패` 상태로 격리하고, 다른
ZIP 항목은 계속 카탈로그/스트리밍합니다.

## 시작하기

요구 사항: Node.js `^20.19.0` 또는 `>=22.12.0` (Vite 8 요구 버전).

```bash
npm install
cp .env.example .env   # 기본값 AI_PROVIDER=cli — claude CLI가 이미 로그인돼 있으면 바로 동작
npm run dev            # Vite dev server(5173) + Express API(3001, /api 프록시)
```

프로덕션 빌드:

```bash
npm run build
npm start               # NODE_ENV=production node server/index.js — 단일 포트로 API+정적 파일 서빙
```

## 지켜야 할 원칙

- **사람 검토 체크포인트 유지**: 가설 선택·심각도 확정 없이는 보고서 생성 버튼이 활성화되지 않습니다.
- **파생 신호와 한계 명시**: 정적 flag가 없는 데이터도 파생 이상을 계산하되, 파생 관측을 물리적
  root cause 확정으로 승격하지 않습니다.
- **프롬프트 예산 동기화**: 프런트 `src/log-engine.js`와 백엔드 `server/lib/validation.js`의
  `MAX_LOG_TEXT_CHARS=300000`을 함께 유지하며, 생략이 발생하면 프롬프트와 UI에 명시합니다.
- **실 고객 데이터 커밋 금지**: `.gitignore`가 `*.zip`/`*.csv`/`*.tsv`/`.env`를 제외합니다. 개발·테스트는
  샘플/가상 데이터 또는 공개 데이터만 사용하세요.
- **localStorage 미사용**: 케이스 히스토리는 세션 메모리에만 유지되며 새로고침 시 초기화됩니다.

## 더 읽기

- [초보자 가이드 (docs/GETTING_STARTED.md)](docs/GETTING_STARTED.md) — 설치부터 첫 분석까지, 전문
  지식 없이 따라 할 수 있는 단계별 안내
- [DONE.md](DONE.md) — 구현/검증 이력
- [Report/](Report/) — Case A/B 실제 실행 보고서·근거 데이터 예시
- [design-mockups/](design-mockups/) — UI 개선 방향을 검토하기 위한 정적 목업(`index.html`에서 시작).
  앱 코드와는 연결되어 있지 않습니다.
