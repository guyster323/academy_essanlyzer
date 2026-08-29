# Rank 3·4 findings (2026-08-29)

짝 문서: `Report/rank-3-4-plan.md`. 작업 브랜치 `feat/rank3-cli-overhead-rank4-sys6`.
커밋: `3b8e1e8` (Rank 3), `906228f` (Rank 4). `npm run test:unit` 100/100, `npm run build` 통과.

---

## Rank 3 — Claude CLI wall-clock

`server/lib/claude-cli.js` `callStructuredViaCli` args에
`--safe-mode --strict-mcp-config --no-session-persistence`를 추가했다.
`--bare`는 쓰지 않았다 (OAuth/구독 로그인을 깨므로). 504 재시도 UI와
프롬프트 예산 상수(`MAX_TOTAL_ALARM_CONTEXTS` 등)는 건드리지 않았다.
`.env.example`에 `CLAUDE_CLI_TIMEOUT_MS`를 주석으로만 문서화했다. 코드 기본값
`600000`은 그대로다.

### 실측 (이 머신, 2026-08-29)

프로덕션과 동일한 `claude -p --output-format json --json-schema --system-prompt
--model sonnet --allowedTools '' --disable-slash-commands` 호출. Case B 소스
`Log_sample/extracted/data_sys_6_stride80.csv`를 프롬프트에 명시한 구조화
출력. `cwd`는 `os.tmpdir()`. 스키마/형태는 전후 모두
`is_error:false`, `subtype:"success"`, `structured_output` 존재.

| 조건 | wall-clock | `duration_api_ms` | `cache_creation_input_tokens` | `cache_read_input_tokens` |
|---|---|---|---|---|
| 변경 전 (플래그 없음) | **12.9s** | 2,401 | 28,256 (전량 신규) | 0 |
| 변경 후 (`--safe-mode --strict-mcp-config --no-session-persistence`) | **5.5s** | 3,586 | 1,156 | 26,877 |

약 **2.3배**. 계획 문서의 27.2s→6.4s와 같은 방향이고, 캐시 미스→캐시 히트
패턴이 동일하다. 이번 before가 계획 문서보다 짧은 것은 CLI 바이너리가 이미
떠 있던 워밍 차이로 보이며, 오버헤드의 정체(매 호출마다 사용자 전역
hooks/MCP/플러그인 시스템 프롬프트를 캐시 미스 상태로 재생성)는 토큰 숫자로
재확인됐다.

`structured_output` 키는 전후 모두 `{ ok, source }` (trivial 스키마). 파싱
경로(`envelope.structured_output`)는 깨지지 않았다.

### detect-anomaly (stride80 실 프롬프트)

같은 스크립트로 `blocksToPromptText` + `buildDetectAnomalyPrompt`를 stride80
전체 스트림에서 만든 뒤 `/api/detect-anomaly`와 동일한 스키마로 CLI를 돌렸다.
프롬프트 54,780자, 240,603행, 빌드 8.8s.

- **플래그 없음 (이번 세션)**: 20분 타임아웃. System 6 2.89GB UI 스트림과
  CPU를 나눠 써서 오염된 측정이라 12.9s→5.5s 대비로 쓰지 않는다.
  이전 gold run(같은 파일, 플래그 없음, 경합 없음)은 Step 2가 12–14분이었다
  (`Report/case_b_findings.md`).
- **플래그 있음**: **700.9s (11.7분)**, `is_error:false`, `subtype:"success"`,
  `structured_output` 키 `{ issueStructured, anomalyWindows }` — 기존 파싱
  스키마 유지. `duration_api_ms` 699,381 ≈ wall-clock 전부. 모델 think-time이
  지배적이라 Rank 3 플래그가 12분을 5분으로 만들지는 않는다. 줄이는 것은
  호출마다 붙던 **고정 기동 오버헤드**(12.9s→5.5s, 파이프라인 4–5회 호출에 곱).

즉 Rank 3의 완료 기준("몇 초 → 몇 초")은 위의 12.9s → 5.5s다.

---

## Rank 4 — System 6 전체 파일 + 저항 이벤트 캡

### 버그 수정

`considerResistanceEvent`의 `(events.length + 1) % 2 === 0` 분기는
`MAX_RESISTANCE_EVENTS=4000`에서 길이 고정 후 **수학적으로 도달 불가**
(`4001 % 2 === 1`). 4000번째 이후 이벤트는 도착 순서대로, 표시 없이 버려졌다.

수정: 앞쪽 2000은 초기 기준선으로 고정, 뒤쪽 2000은 최근 이벤트 circular
buffer. `events.droppedCount`를 세고 `src.droppedResistanceEvents` /
`truncation.droppedResistanceEvents` / 소스 목록 앰버 문구로 노출
(`buildTruncationNote`와 같은 비은닉 패턴). Web Worker는 도입하지 않았다.

유닛 테스트: 4250개 qualifying 이벤트를 넣고 최근 timestamp가 남는지,
droppedCount=250인지, 초기 기준선이 남는지 검증. log-engine 스트림 테스트와
prompt-budget truncation 테스트도 추가.

### 종단 검증 (실제 UI)

`npm run dev` (Vite :5174) + Playwright가 `Log_sample/case_b_field_data.zip`
(1,668,409,464 bytes)을 `#zipFileInput`에 넣고, 카탈로그된
`field_data/data_sys_6.csv`(uncompressed 2,889,184,963 bytes,
format `lfp-cell-array`)에서 **「분석 포함 (스트리밍 시작)」** 클릭.

| 항목 | 결과 |
|---|---|
| 탭 hang/crash | 없음 (`pageerror` 0건) |
| 진행률 바 | 1%→100% 약 10초 간격으로 단조 증가 (스크린샷 `Report/rank4-sys6-progress.png`, 99%) |
| 스트리밍 벽시계 | **850s ≈ 14.2분** (클릭 12:13:55 → ready 12:28:02 UTC) |
| 행 수 | **19,248,213** (README의 2.75GB/19,248,213행 검증 케이스와 동일 규모) |
| 알람 / 파생 이상 | 751,686 / 9,366 |
| 저항 이벤트 캡 | 4,000 유지, **575,026건 생략** — UI에 `저항 이벤트 575,026건 생략(초기 기준선+최근 창 유지)`로 표시 (`Report/rank4-sys6-stream-done.png`) |
| 이벤트 시각 | first **2018-04-28T09:46:25Z** (파일 시작과 같음), last **2022-01-06T12:32:25Z** |
| 파일 마지막 행 (stride80 꼬리) | 2022-01-10 16:15:00 — 최신 이벤트가 EOF 4일 전까지 살아 있음 |
| B-F5 / GP-BattGP | `available: false`, 사유 그대로 `GP/BattGP는 이번 범위에서 미구현 — Unknown으로 남깁니다`. Vdev로 채우지 않음. |
| B-F6 | balancing current 컬럼 없음 → unavailable (기존과 동일) |

수정 전 동작으로 환산하면, 총 qualifying 이벤트 579,026건 중 앞 4,000개만
남으므로 마지막 유지 시점은 대략 타임라인의 0.7%(약 2018-05 초)가 된다.
B-F4가 보여야 할 late-stage knee 구간(2021–2022)은 전부 침묵 삭제됐을
것이다. 수정 후 last event는 2022-01-06이다.

B-F4 knee 자체는 이번 전체 파일 런에서 `available: false`
(사유: `저항 시계열이 짧아 knee를 독립 탐지할 수 없음`). binMatch 통과분이
603건이라 daily 시계열이 `detectKnee`의 24일 하한에 못 미친 것으로 보인다.
캡 수정과 별개인 기존 매칭/탐지 한계이며, GP/BattGP를 만들어 메우지 않았다.

### stride80 회귀

같은 입력 `data_sys_6_stride80.csv`를 노드에서 재스트림:

| | 이번 측정 | 기존 gold (`Report/case_b_findings.md`) |
|---|---|---|
| 행 | 240,603 | 240,603 |
| 파생 이상 | 9,366 | 9,366 |

stride80도 캡에 걸린다(이벤트 4,000 + drop 51,677, last 2022-01-06).
계획 문서의 "stride80은 캡에 안 걸렸을 가능성"은 빗나갔다 — 이미 걸린 상태로
`case_b_report.html`이 발행된 것이다. 이번 수정은 stride80에서도 최근
이벤트를 살리므로, 프롬프트 통계(행/알람)는 같고 저항 증거만 더 정직해진다.

---

## 범위 밖 (계획대로 손대지 않음)

- `--bare`
- `MAX_TOTAL_ALARM_CONTEXTS` / `MAX_GROUPS_PER_SOURCE_IN_PROMPT` /
  `MAX_SELECTED_SOURCES` / `CONTEXT_WINDOW`
- 504 재시도 UI (`renderError` → `retryStage`)
- Web Worker / `postMessage`
- B-F5/GP-BattGP 추정·백필
