# ESSAnlyzer 로그 파이프라인 일반화 작업 완료

`tmp/CODEX_TASK.md`와 전략 문서의 범위에 맞춰 기존 5단계 UI를 유지하면서 AEMO telemetry(Case A)와 LFP cell-array 필드 CSV(Case B)를 포맷 인식형 스트리밍 분석으로 확장했다. `Log_sample/`의 대용량 로그 파일은 이 워크트리에 추가하거나 커밋하지 않았다.

## 파일별 변경 사항

- `src/formats.js`: AEMO의 `FPP_UNITID` 우선 entity 선택을 적용하고, `MEASURED_MW` rolling mean/std·MAD robust z-score·ramp 기반 독립 파생 알람 훅을 추가했다. `Timestamp + U_Battery + U_Cell_1..8`를 인식하는 `lfp-cell-array` 어댑터를 추가해 파일 하나를 하나의 system으로 처리하고, leave-one-out cross-cell `Vdev`, robust z-score, 선택적 voltage closure, 데이터 기반 outlier Cell을 계산한다.
- `src/log-engine.js`: 포맷별 `computeDerivedAlarm` 훅을 호출하고, rolling state·파생 metric/reason/category 요약·알람 annotation을 bounded 구조로 보관한다. 그룹별 state를 분리해 entity 간 baseline 오염을 막고, JSZip async iterator의 조기 종료 cleanup을 보강했다.
- `src/pipeline.js`: 파생 요약/annotation과 `sourceProfiles`를 프롬프트에 전달하고 anomaly·hypothesis·report 전 단계 API payload에 유지한다. omission notice가 포함된 최종 `combinedLogText`도 `MAX_LOG_TEXT_CHARS=300000` 이내가 되도록 예산을 예약한다. `selectedHypId`·`finalSeverity` 기반 사람 검토 게이팅은 유지했다.
- `src/state.js`: 전략 문서의 계통/셀 분석 domain 목록과 단계 간 `sourceProfiles` 상태를 추가했다.
- `src/render.js`: 포맷/파생 알람 수, anomaly evidence tier, hypothesis의 반증 증거·누락 신호·주장 한계를 표시한다. ZIP 항목 오류를 일반 제외 파일과 구분해 표시하고 기존 사람 검토 체크포인트를 유지했다.
- `src/zip.js`: probe/stream 오류를 개별 source의 `error` 상태로 남기고, nested ZIP 및 entry별 오류를 형제 항목을 계속 처리할 수 있는 오류 수준 skip note로 표준화했다. JSZip의 `uncompressed data size mismatch`를 특별히 설명하는 helper를 추가했다.
- `server/lib/prompts.js`: AEMO의 독립 `MEASURED_MW` 탐지와 `MW_QUALITY_FLAG`/알려진 시각 비의존 규칙, LFP cross-cell 규칙, 포맷별 domain, `Observed/Derived/Inferred`, 반증·누락 신호·주장 한계를 프롬프트에 명시했다.
- `server/lib/schemas.js`: evidence tier 및 확장 domain enum을 추가하고 anomaly/hypothesis 출력과 strict tool schema에 필수 반증·누락 신호·claim-limit 필드를 추가했다.
- `server/lib/validation.js`: source profile 스키마와 300,000자 입력 상한을 추가하고, cell-array 응답이 전기화학적 열화·커넥터·부식을 확정하지 못하도록 문맥 검증을 추가했다. 원인 가설의 evidence tier는 `Inferred`로 제한했다.
- `server/routes/analysis.js`: 모델 응답 검증 시 요청의 source profile 문맥을 함께 전달한다.
- `tests/unit/formats.test.js`: LFP header 감지 및 AEMO `FPP_UNITID` 우선순위를 고정했다.
- `tests/unit/log-engine.test.js`: AEMO 품질 플래그가 정상이어도 `MEASURED_MW` 급변을 탐지하는지, LFP outlier Cell이 데이터에 따라 선택되는지, 정상 peer row가 오탐되지 않는지를 검증했다.
- `tests/unit/prompt-budget.test.js`: 파생 요약/source profile 전달과 프롬프트 상한을 검증했다.
- `tests/unit/zip.test.js`: JSZip mismatch 메시지와 source error 표시 helper를 검증했다.
- `tests/server/prompts.test.js`: AEMO/LFP 포맷별 prompt 지침과 Cell 8 사전 가정 금지·물리 원인 한계를 검증했다.
- `tests/server/validation.test.js`: 새 evidence 필드의 필수성, cell-array 물리 원인 주장 거부, bounded effective-series-resistance 주장 허용을 검증했다.
- `README.md`: 포맷 어댑터, 독립 파생 탐지, bounded prompt, evidence tier, LFP 주장 한계, JSZip 항목별 오류 처리를 문서화했다.
- `HANDOFF_TO_CLAUDE_CODE.md`: 후속 작업자가 사용할 AEMO/LFP 분석·prompt·ZIP 처리 계약과 한계를 갱신했다.
- `docs/superpowers/plans/2026-08-27-log-analysis-generalization.md`: 구현·검증 계획과 단계별 계약을 기록했다.
- `package-lock.json`: 작업 시작 전에 존재하던 Node `engines` 메타데이터 변경을 보존했다.
- `DONE.md`: 본 파일에 변경 사항, 한계, 검증 결과를 기록했다.

## 알려진 한계 및 후속 과제

- 전략 문서의 40단계 수동 포렌식 보고서 전체는 의도적으로 구현하지 않았다. 이번 범위는 기존 5단계 UI에서 두 케이스의 스트리밍 신호를 얻는 일반화이며, SOC/T/I 정합성, 저항·knee/GP/BattGP 분석, FTA 및 phase별 정식 보고서 산출은 별도 후속 과제다.
- AEMO 파생 탐지는 고정 rolling window와 휴리스틱 임계값을 사용한다. 이는 독립적인 이상 후보를 만드는 장치이지 사고 원인·정상/비정상 운전의 최종 판정이 아니며, 실제 운영 데이터로 임계값 보정이 필요하다.
- LFP 구현은 현재 8-cell 배열과 유한한 `U_Battery`가 있는 행을 대상으로 한다. closure는 pack 값이 있을 때만 계산하며, 전기화학적 저항을 직접 추정하지 않는다. voltage/resistance pattern이 지지하는 결론은 최대 “Cell N 경로의 유효 직렬저항 증가” 후보까지이고, 전기화학적 열화·커넥터·부식·정확한 root cause는 확정하지 않는다.
- 파생 state·요약·context는 고정 크기로 제한된다. 파일 전체 행, 전체 cell history, 전체 ZIP 내용을 AI로 보내지 않으며 생략이 생기면 prompt와 UI에 명시한다. 프런트와 백엔드의 `MAX_LOG_TEXT_CHARS`는 모두 `300000`이다.
- JSZip 오류 처리는 손상된 압축 데이터를 복구하는 방식이 아니다. entry를 오류 상태로 격리하고 형제 entry를 계속 처리하며, 손상된 nested ZIP은 오류 skip note로 남긴다. ZIP central directory/load 자체가 실패하거나 entry가 실제로 손상된 경우 해당 내용을 되살릴 수 없고, live archive fixture 검증은 샘플 파일이 이 워크트리에 없어 수행하지 않았다.
- AI provider 연결부는 변경하지 않았다. 실제 Claude/Anthropic 호출과 실제 공개 archive의 end-to-end 분석은 별도 환경 검증이 필요하다.

## 검증 결과 (Codex 워커 산출물, 아래 "라이브 검증" 이전 상태)

- `npm run test:unit` — 56 passed, 0 failed
- `npm run test:e2e` — 24 passed, 4 skipped
- `npm run build` — passed
- `git diff --check` — passed
- `Log_sample/*.zip` — `.gitignore`의 `*.zip` 규칙으로 ignore 확인; 샘플 데이터는 추가/커밋하지 않음

---

## 라이브 검증 및 후속 수정 (Claude Code, 실제 공개 데이터로 브라우저 구동)

위 구현을 실제 `npm run dev` + 실제 Darmstadt/WDBESS1 아카이브로 처음부터 끝까지 구동해 검증했다.
포맷 감지·파생 이상탐지 로직 자체는 실데이터에서 정확히 동작했으나(Case B: LFP 266,067행 스트리밍,
alarm 89건, cross-cell Vdev로 Cell 5/Cell 7을 데이터 기반으로 정확히 지목 — Cell 8 사전 가정 없음),
실전 규모 데이터로만 드러나는 결함 4건을 추가로 발견·수정했다.

### 추가 수정 파일

- `src/zip.js`: `normalizeZipSize()` 추가 — JSZip이 32비트 부호 있는 산술로 크기 필드를 읽어
  실제 크기가 2^31바이트(~2GB) 이상인 항목의 크기가 음수로 표시되는 버그를 재현·수정
  (실제 2.75GB 항목에서 재현). `isMacosArtifactPath()` 추가 — macOS로 압축한 zip의
  `__MACOSX/._*` AppleDouble 부속 파일이 원본과 같은 `.csv` 확장자를 가져 정상 로그처럼
  큐에 들어가지만 스트리밍이 0%에서 무한 대기해 `submitIntake()`의 "스캔 진행 중" 가드를
  영구적으로 막아버리는 것을 재현·수정(이름 기반으로 완전히 건너뜀).
- `server/lib/claude-cli.js`: `CLI_TIMEOUT_MS`를 120초 → 240초로 상향. 새 포맷 인식 프롬프트는
  파생 통계 교차 참조·근거 계층 구분·반증/누락신호/claim-limit 등 더 엄격한 추론을 요구해,
  실제 LFP 데이터 대상 detect-anomaly 호출이 ~102초, generate-hypotheses 호출이 180초를
  초과하는 것을 직접 측정으로 확인했다(기존 120초 상한은 여유가 거의 없었음).
- `server/lib/validation.js`: `anomalyWindowSchema.observedValue`/`deviation`을 200자 → 800자로,
  `issueStructuredSchema.occurredAt`을 200자 → 500자로 상향. 파생탐지 기반 이상구간은 여러
  알람 인스턴스의 개별 수치를 근거로 인용하도록 프롬프트가 유도하므로, 기존(단일 관측값 가정)
  상한을 실제 응답이 초과하는 것을 확인했다.
- `src/state.js`, `src/pipeline.js`, `src/render.js`: 로딩 중 진행 상태 표시 추가
  (`state.loadingStartedAt`, `describeLoadingProgress()`, `beginLoadingTick()`/`endLoadingTick()`).
  실제 호출이 100~240초 걸리는 것을 확인한 뒤, 정적 라벨 하나만 보여주던 로딩 화면에 실시간
  경과 초와 단계별 안내 문구(15초/60초/150초 임계값)를 추가해 "멈춘 것처럼 보이는" 문제를 해소.
  서버 쪽 진짜 진행률은 없음(`claude -p`가 원자적으로 한 번에 응답)을 명시하고 과장하지 않았다.
- `tests/unit/zip.test.js`, `tests/server/validation.test.js`, `tests/unit/state.test.js`: 위 수정
  전부에 대한 회귀 테스트 추가.

### 라이브 검증에서 확인한 것

- Case B(LFP, `field_data/data_sys_28.csv`, 37.97MB, 266,067행)를 실제 브라우저(orca 자동화)로
  업로드 → 스트리밍 → 이상구간 탐지 → 가설 생성까지 전 구간 실제 Claude CLI 응답으로 완주.
  outlierCell은 Cell 5/Cell 7로 데이터 기반 판정(논문의 Cell 8 가정과 무관), evidenceTier
  Observed/Derived 구분 정확, 타임스탬프 중복 같은 실제 데이터 품질 이슈도 별도 관측 사실로 포착.
- Case B(`field_data/data_sys_6.csv`, System 6 — 전략 문서의 1차 Target)는 실제 우회 불가능한
  JSZip 라이브러리 결함으로 인해 스트리밍이 끝까지 완료되지 않음(2.75GB 항목, "Bug: uncompressed
  data size mismatch"). 앱은 이를 해당 source만 오류 상태로 격리하고 다른 항목은 계속 처리하는
  방식으로 정상 대응함을 확인했다 — 이는 완화이지 근본 수정이 아니다. **후속 과제**: 이 항목만
  다른 압축 해제 경로(예: pako 직접 스트리밍 또는 서버사이드 사전 추출)로 우회하지 않는 한
  System 6 자체는 이 브라우저 파이프라인만으로 분석할 수 없다.
- Case A(WDBESS1 AEMO, 실제 사건일 2025-08-19 CSV, 497.86MB)도 실제 브라우저로 업로드→스트리밍까지
  검증했다. 엔티티가 `FPP_UNITID`(WDBESS1)로 정확히 그룹되고 `PARTICIPANTID`(WDOWBESS)와 분리됨을
  확인했다(우선순위 수정이 실데이터에서 실제로 적용됨). WDBESS1 그룹 10,800행 중 534행이 순수
  `MEASURED_MW` 독립 통계 이상탐지로 플래그됨(robustZ 최대 25.92) — `MW_QUALITY_FLAG`나 공개된
  12:15–12:20 사건 시각에 전혀 의존하지 않고 탐지된 것으로, 전략 문서 Phase A2 요건과 일치한다.
  단, 이 단계에서는 AI 호출(가설 생성 등)까지는 재실행하지 않았다 — 해당 백엔드 경로는 Case B에서
  이미 동일 코드로 종단간 검증됐다.

## 2026-08-27 대용량 ZIP 엔트리 스트리밍 우회 수정

### 원인과 수정

- JSZip이 `field_data/data_sys_6.csv`의 32비트 unsigned 압축 해제 크기 `2,889,184,963`을 signed 값
  `-1,405,782,333`으로 보유하고, `internalStream()`의 최종 크기 검사에서 `Bug : uncompressed data size mismatch`를
  발생시켰다.
- `src/zip-stream.js`에 원본 `File`/`Blob`의 `slice()`만 사용하는 클라이언트 fallback을 추가했다. EOCD/ZIP64 중앙
  디렉터리와 local header를 범위 읽기로 해석하고, 저장(method 0) 엔트리는 직접 스트리밍하며 deflate(method 8)는
  명시적 pako 의존성으로 64KiB 범위 읽기와 8KiB push subchunk를 사용해 inflate한다. 중앙·로컬 파일명/플래그/압축 크기 결속, ZIP64 및 앞부분이
  붙은 archive의 기준 오프셋, data descriptor, ZIP comment 속 가짜 EOCD를 검증한다.
- `src/zip.js`는 top-level 원본 File을 entry reference에 보존하고, signed-size 엔트리는 처음부터 fallback을 사용하며,
  양수 크기 엔트리가 JSZip mismatch를 내면 byte zero에서 한 번만 재시도한다. `probeSource()`도 같은 경로를 사용하고,
  source별 오류 격리와 `streamIntoSource()` 계약은 유지했다.

### 로컬 실제 데이터 검증

- 네트워크 다운로드 없이 `C:\dev\ESSAnlyzer\Log_sample\Darmstadt_field_data.zip`을
  `Log_sample/Darmstadt_field_data.zip`으로 `Copy-Item`했다. 양쪽 파일 크기는 `1,668,409,464`바이트이며
  SHA-256은 `20966D5DB076A578832EF7B4850371E37B2940DDDF5CBBCDADC7DB20F0B57DD5`로 일치한다.
- 실행 명령: `node tmp/verify-large-zip-entry.mjs`
- `field_data/data_sys_6.csv`: compressed `274,874,973`, header/consumed bytes `2,889,184,963`,
  row count `19,248,213`, static alarms `751,686`, derived alarms `751,686`, elapsed `407.66s`.

### 회귀 검증과 제한

- `npm run test:unit`: 76 passed, 0 failed.
- `npm run build`: passed.
- `npm run test:e2e`: 24 passed, 4 skipped.
- fallback은 저장/deflate 엔트리만 지원하며 암호화·multi-disk·지원하지 않는 압축 방식·실제 손상은 해당 source
  오류로 격리한다. 중앙 디렉터리와 ZIP64 record에는 각각 64MiB 상한이 있고, CRC를 별도로 검증하지 않는다.
- 실제 ZIP과 원시 로그는 커밋하지 않았으며, 대용량 ZIP은 로컬 작업트리에서만 사용했다.

## 2026-08-27 근거 그래프 · 임원 보고서 · 공개결과 대조

청사진 5단계 워크플로우는 유지한 채, 스트리밍 중 고정 크기 시계열을 브라우저에만 남기고 Figure를 그린다.

- `src/series-engine.js`, `src/charts.js`, `src/figures.js`, `src/forensics/aemo.js`, `src/forensics/lfp.js`
- A-F1~F5, B-F1~F4·F6. B-F5(GP)와 A-F6(Dispatch Target)는 데이터/범위 없으면 unavailable.
- 보고서 스키마에 3-box, FTA, independent findings, figure citation. `/api/compare-published`는 findings를 덮어쓰지 않음.
- HTML 내보내기(`src/report-export.js`). 히스토리 스냅샷에서 series/Figure는 제외.
- 골든 케이스 수용 기준: `docs/verification/gold-case-acceptance.md`
- 의도적 한계: GP/BattGP 미구현, A-F6는 Target 컬럼이 있을 때만, 원본 ZIP은 커밋하지 않음.
