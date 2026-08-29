# Case B E2E — Findings (2026-08-29)

## 저항 이벤트 캡 버그 수정 후 재발행 (2026-08-30)

PR #4(`feat/rank3-cli-overhead-rank4-sys6`, 상세는 `Report/rank-3-4-plan.md`/`Report/rank-3-4-findings.md`)가 `main`에 merge된 뒤, `src/forensics/lfp.js`의 저항 이벤트 캡(`MAX_RESISTANCE_EVENTS=4000`) 처리 버그 — 캡 초과 시 최신 이벤트가 조용히 버려지던 문제 — 가 고쳐졌다. 이 버그는 **아래에서 발행됐다고 적힌 기존 `case_b_report.html`에도 이미 걸려 있었다**(같은 `data_sys_6_stride80.csv` 입력에서 저항 이벤트 51,677건이 조용히 drop됨, 옛 동작대로면 마지막 생존 이벤트는 대략 2018-05경이었을 것). 그래서 같은 stride80 입력으로 `main`(수정 반영 후)에서 Step 1~5를 처음부터 다시 실행해 보고서를 재발행했다.

**진행 방식**: 이번엔 Grok 위임이 아니라 Claude Code가 `orca computer`로 실제 Chrome을 직접 조작해 처음부터 끝까지 수행(업로드 → 스트리밍 → 이슈 자동 감지 → 이상 구간 탐지 → 가설 생성 → 사람 검토(가설·심각도 확정) → 보고서 생성 → HTML로 저장 → 파일 교체).

**소요 시간(참고용, 변동 큼)**: 이슈 자동 감지 약 5.5분, 이상 구간 탐지 약 2.5분(이전 세션에서 같은 프롬프트로 측정한 700.9초/11.7분보다 훨씬 짧게 끝남 — 캐시 히트 등으로 변동 폭이 크다는 뜻이지 새로운 상한이라는 뜻은 아님), 가설 생성 약 13분, 보고서 생성 약 10분. 총 30분 이상 — "느리다"는 기존 결론(위 1번 항목)은 여전히 유효하다.

**결론(헤드라인/심각도)은 실질적으로 동일하다**: 여전히 "Cell 8 경로의 유효 직렬저항 증가 후보"이고 엔지니어 심각도도 "상"으로 확정됨. 억지로 결론을 바꾸지 않았다 — AI가 이번에 실제로 생성한 내용을 그대로 채택한 결과가 이전과 같았을 뿐이다.

**다만 정직하게 새로 드러난 것이 하나 있다.** 저항 이벤트 데이터(B-F1/B-F4, 이번에 drop count가 51,677건으로 처음 정직하게 노출됨)가 이제 실제로 매칭 계산에 쓰이면서, 전압 잔차 지표(B-F3)는 **Cell 8**을 지목하는데 이벤트 저항 지표(B-F1/B-F4)는 **Cell 5**와 2018-11-24 부근의 resistance knee를 지목하는 **셀 지목 불일치**가 새로 드러났다(B-F1 matched 1,330/4,000). 이건 버그 때문에 만들어진 아티팩트가 아니라 — 버그 수정 전에는 이벤트 저항 데이터 자체가 사실상 안 보이던 상태라 이 불일치를 애초에 확인할 방법이 없었던 것이다. 새 보고서는 이 불일치를 헤드라인·INDEPENDENT FINDINGS·MANAGEMENT 권고 전부에 명시하고("이벤트 저항 복원 전까지 근본원인 셀 확정을 보류한다"), FTA의 "Event-resistance 분석 기반 Cell 8 저항 분리 확인" 항목을 `Unobservable`로 정직하게 낮췄다. 즉 버그 수정이 단순히 "숫자를 하나 더 보여주는" 수준을 넘어, 이전 보고서가 원천적으로 확인할 수 없었던 방법론 간 상충을 실제로 드러냈다.

B-F5/GP-BattGP는 이번에도 그대로 `unavailable`(Vdev로 추정하지 않음).

**교체된 파일**: `Report/case_b_report.html` (기존 260,519 bytes → 163,925 bytes; 근거 그래프 4개 인라인 PNG는 동일하게 포함). 기존 파일은 git 이력에 남아 있으니 필요하면 이전 버전과 diff 가능.

**자동화 관련 추가 팁**: 이번엔 같은 브라우저 세션에 사용자의 다른 탭이 여러 개 열려 있는 상태에서 작업했는데, `list-windows --app chrome`이 시점에 따라 다른 최상위 창(작은 팝업, 메인 창 등)을 반환하거나 window-id가 몇 초 만에 stale해지는 일이 반복됐다. 매 액션 직전에 반드시 `get-app-state`로 새 element index를 다시 읽고, 클릭 직후 실패하면 곧바로 `list-windows`로 현재 유효한 window-id를 재확인하는 방식으로 우회했다 — 이전 시도 대비 원인이 다르긴 하지만(원인: 같은 프로세스에 여러 최상위 창/탭이 떠 있을 때의 열거 불안정), "창/엘리먼트 참조는 몇 초 이상 신뢰하지 말 것"이라는 교훈은 위 섹션의 `<select>` 팁과 일관된다.

---

## 최종 결과 (업데이트: 같은 날 두 번째 시도)

**`Report/case_b_report.html`이 발행됐다.** 아래 "요약"~"3번" 항목은 Orca 오케스트레이션 + Grok 워커로 진행한 **첫 번째 시도**의 기록이며, 그 시도는 Step 2(이상 구간 탐지)에서 두 번 연속 `Claude CLI 응답 시간 초과(600초)`로 실패했다. 원인을 진단한 뒤(아래 1번), `server/lib/claude-cli.js`의 `CLI_TIMEOUT_MS`를 `.env`의 `CLAUDE_CLI_TIMEOUT_MS=1200000`(20분)으로 올려 서버를 재기동하고, Claude Code가 직접 브라우저를 조작해 **같은 파일로 동일 절차를 처음부터 재실행**했다.

- Step 2(이상 구간 탐지): 이번엔 성공 (실제 소요 약 12~14분 — 이전 두 번의 실패가 각각 600초 근처였던 것과 일관됨. 즉 코드 결함이 아니라 순수하게 시간이 더 필요했던 것으로 확인됨)
- Step 3(가설 생성, 지난 2026-08-27 gold run이 세션 한도로 막혔던 바로 그 단계): 성공, 약 5분 소요, 3개 가설 생성(Electrical Path/Medium, Balancing-BMS/Low, Operating Condition/Low)
- Step 4(사람 검토): 1번 가설("Cell 8 경로 유효 직렬저항 증가 후보(전류방향 연동 전압편차)") 선택, 심각도 "상"으로 확정(판정 근거 기재)
- Step 5(보고서·메일 생성): 성공, 약 9분 소요
- "HTML로 저장" → `Report/case_b_report.html`로 저장 완료 (약 254KB, 근거 그래프 4개 인라인 PNG 포함, headline/발생개요/이상구간요약/확정원인/조치권고 전부 Observed·Derived·Inferred 근거 계층 구분과 함께 서술됨)

**결론**: Step 2/3/5의 실제 실패 원인은 "코드 버그"가 아니라 "이 브랜치의 데이터 조합(대용량 LFP cell-array + 신규 evidence/figures 계산)에서 Claude 응답이 기존 600초 상한을 실제로 초과한다"는 것이었다. 아래 1번 항목의 "회귀 의심" 진단은 정확했고, 처방(타임아웃 상향)이 그대로 통했다. 다만 20분까지 걸릴 수 있다는 점은 UX상 여전히 개선 여지가 있다(사용자가 12~14분을 그냥 기다려야 함).

---

## 1차 시도 기록 (Orca + Grok 워커, 이하 원문 유지)

### 요약

Orca 오케스트레이션(`orca orchestration`)으로 Grok 4.6(xhigh, 이 환경 기본값) 워커를 붙여, 브라우저 자동화(`orca computer`)로 Case B(TU Darmstadt/MIT LFP System 6, `Log_sample/extracted/data_sys_6_stride80.csv`, 240,603행)를 Step 1부터 끝까지 진행해 `Report/case_b_report.html`을 발행하는 것이 목표였다.

**결과(1차 시도): 보고서는 발행되지 않았다.** Step 1(로그 업로드 → CS 의뢰 자동 구성)은 정상 완료됐지만, Step 2(이상 구간 탐지, `/api/detect-anomaly`)가 두 번 연속 정확히 같은 오류로 실패해 이후 단계(가설 생성·사람 검토·보고서)에 도달하지 못했다. 총 소요 시간 약 43분.

이 문서는 "발행된 보고서의 품질"이 아니라 "왜 이번엔 끝까지 못 갔는가"를 다룬다. 아래 3번 항목이 실질적 개선점이다.

## 무엇이 됐고 무엇이 안 됐는가

| 단계 | 결과 |
|---|---|
| Step 1 · 로그 업로드 | ✅ CSV 240,603행 스트리밍 완료, 포맷 자동 인식 |
| Step 1 · 이슈 자동 감지 | ✅ 후보 감지, 최상위 후보("Cell 8 Cross-cell 전압편차") 자동 선택 |
| Step 1 · 민감정보 확인 · 제출 | ✅ |
| Step 2 · 이상 구간 탐지 | ❌ 2회 연속 `Claude CLI 응답 시간 초과(600초)` — 첫 시도·재시도 모두 정확히 600초 근처에서 실패 |
| Step 3 · 가설 생성 | 도달 못함 (anomalyWindows가 0건이라 버튼 비활성) |
| Step 4 · 사람 검토(가설·심각도 확정) | 도달 못함 |
| Step 5 · 보고서·메일 발행 | 도달 못함, `Report/case_b_report.html` 생성 안 됨 |

증거: `Log_sample/extracted/data_sys_6_stride80.csv` 업로드 후 Step 2 화면 스크린샷에 `Claude CLI 응답 시간 초과(600초)` 오류 박스와 "다시 시도" 버튼이 그대로 남아 있음(2026-08-29 실시간 확인).

## 1. 회귀(regression) 가능성 — 같은 파일이 이전엔 성공했다

`Report/case_b_pipeline.json`(2026-08-27 gold run 기록)을 보면 **정확히 같은 파일**(`data_sys_6_stride80.csv`, 240,603행)로 이상 탐지가 성공해서 B-F1~B-F4 근거(Cell 8 outlier, 9,366건 파생 alarm)까지 만들어냈다. 그날은 그 다음 단계(가설 생성)에서 Claude CLI *세션 한도*로 막혔을 뿐, 이상 탐지 자체는 문제없었다.

오늘은 같은 파일의 같은 첫 단계(이상 탐지)가 이미 600초(`server/lib/claude-cli.js`의 `CLI_TIMEOUT_MS`, 이미 넉넉하게 설정된 값)를 넘겨 실패했다. 같은 입력, 같은 단계가 이틀 전엔 되고 오늘은 두 번 다 10분을 넘겨 실패했다는 것은 단순 우연보다 **회귀**일 가능성을 봐야 한다.

**의심되는 원인**: 이 브랜치(`feat/evidence-figures-executive-report`, 커밋 `c06da60`)에서 스트리밍 파이프라인에 셀별 시계열 버퍼링(`series-engine.js`, 행마다 `pushSample`)과 forensics 수집(`fmt.collectForensics`, 행마다 호출)이 새로 추가됐고, 제출 시점에 `buildFigures()`/`buildEvidenceLedger()`가 동기 실행된다. 240K행짜리 LFP cell-array에서는 이 추가 연산이 실제 Claude 응답 대기와는 별개로 클라이언트 측 처리 시간·페이로드 구성 시간을 늘렸을 수 있다. Claude CLI 자체가 그날따라 느렸을 가능성도 배제할 수 없지만, 두 번 다 재현된 점(우연이라기엔 일관됨)은 데이터/코드 쪽 원인에 더 무게를 둔다.

**권장 조치**: `buildFigures`/`buildEvidenceLedger`와 `detect-anomaly` 요청 사이의 실제 소요 시간을 대용량 LFP 파일 기준으로 프로파일링하고, 필요하면 (a) 이 연산을 백그라운드/지연 실행으로 옮기거나 (b) 대용량 cell-array 입력에 한해 타임아웃을 더 늘리는 임시 조치를 검토.

**후속 확인(같은 날 2차 시도)**: `CLAUDE_CLI_TIMEOUT_MS=1200000`(20분)으로 올려 재실행한 결과 Step 2/3/5가 각각 약 12~14분/5분/9분 만에 정상 완료됐다. 즉 (b) 타임아웃 상향만으로 충분했고, 클라이언트 연산 자체가 응답을 막을 정도로 느리진 않았던 것으로 보인다(다만 정확히 어느 쪽이 병목인지 프로파일링한 것은 아니므로, 대용량 파일에서 반복적으로 10분 이상 걸리는 것 자체는 여전히 UX 개선 대상이다).

## 2. Orca 오케스트레이션 — worker_done 추적이 끊기는 버그성 동작

`worker-start --agent grok`로 워커를 붙인 직후, Orca의 준비상태(readiness) 판정이 실제 에이전트가 첫 도구 호출(파일 읽기 등)을 하는 도중에 타임아웃되어 `dispatch_input`/`agent_readiness` 단계에서 "failed"로 기록됐다. 실제 Grok 프로세스는 살아서 정확히 작업을 수행 중이었는데도, 이 Dispatch의 `capability`가 즉시 회수(`capability_revoked_at`)돼 이후 워커가 보낸 heartbeat·worker_done·escalation이 전부 "Orca rejected: capability is revoked"로 거부됐다.

다행히 거부된 메시지의 본문 자체는 Run 사서함에 그대로 남아 읽을 수 있었고(`orca orchestration check`), `orca orchestration worker-read --dispatch <id>`로 실제 트랜스크립트도 끝까지 추적할 수 있어 작업 자체는 놓치지 않았다. 하지만 이는 원래 의도된 흐름(coordinator가 `check --wait`로 깔끔하게 `worker_done`을 수신)이 아니라 우회였다.

**재현 조건(추정)**: `worker-start`가 새로 만든 터미널의 "에이전트 준비 완료" 판정을 붙잡아둔 채, 실제 에이전트가 즉시 도구 호출(파일 읽기 등)로 넘어가는 경우 레이스 컨디션이 발생하는 것으로 보인다. `--retry-of` + `--terminal <handle>`로 같은 터미널에 재부착을 시도했지만 이번엔 "agent_readiness timeout"으로 재실패했다(에이전트가 이미 바쁜 상태라 유휴 판정 자체가 안 됨).

**권장 조치**: Orca 쪽에 이 readiness-race를 버그로 보고할 가치가 있다. 실무 우회책으로는, `worker-start` 직후 곧바로 `worker-show`로 dispatch 상태를 한 번 더 확인해서 "failed"면 재시도 대신 `orca terminal read`/`worker-read`로 직접 감독하는 편이 안전하다(이번에 실제로 그렇게 처리함).

## 3. 브랜치/워크트리 주의사항

리포지토리의 기본 체크아웃 브랜치가 `main`이 아니라 `feat/evidence-figures-executive-report`였고(이 브랜치에만 `report-export.js`/`figures.js`/`evidence-ledger.js`가 존재), 정작 이번 작업 직전엔 다른 무관한 브랜치(`feat/design-mockups`)에 있었다. Report 폴더(`Report/README.md`)를 먼저 확인하지 않았다면 리포트 발행 기능 자체가 없는 브랜치에서 헛작업할 뻔했다. Case A/B 골드런 산출물이 전부 이 미병합 브랜치(PR #2)에만 있다는 점은 — 이 기능이 아직 `main`에 없다는 뜻이므로 — 별도로 병합 계획을 세워야 할 부분이다.

## 다음에 그대로 재시도할 때 참고할 것 (2차 시도로 검증 완료)

- 파일: `Log_sample/extracted/data_sys_6_stride80.csv` (압축 해제 완료 상태, 재사용 가능)
- 브랜치: `feat/evidence-figures-executive-report` (report-export 기능이 있는 유일한 브랜치)
- `.env`에 `CLAUDE_CLI_TIMEOUT_MS=1200000`이 있어야 함 (서버 재기동 필요 — `node --watch`는 `.env` 변경을 자동 반영하지 않음)
- 결과물: `Report/case_b_report.html` 발행 완료. `Report/README.md`에도 등록함.
- 남은 개선 과제는 "실패"가 아니라 "느림"이다 — 이번엔 됐지만 12~14분은 여전히 길다. 위 1번 항목의 프로파일링(무엇이 실제 병목인지)은 여전히 유효한 후속 작업이다.

## 자동화 관련 팁 (browser-use 재현 시)

- 네이티브 `<select>`(예: 심각도 드롭다운)는 클릭으로 열면 팝업이 매번 새 임시 창 ID를 받아 `windowNotFound`가 반복 발생했다. **클릭으로 열지 말고**, 인접 필드를 클릭한 뒤 `Shift+Tab`(또는 `Tab`)으로 포커스만 이동시켜 팝업을 띄우지 않은 상태에서 `Down`/`Up` 화살표로 값을 바꾸는 방식이 안정적으로 동작했다.
- 대용량(30MB+) CSV는 네이티브 파일 열기 대화상자에서 파일명을 직접 타이핑하는 것보다, 대화상자가 이미 해당 폴더에 열려 있다면 목록 항목을 클릭 선택 후 Enter가 더 안정적이었다.
