# Rank 3·4 개선 계획 (2026-08-29)

`Report/next-ranks-2-to-5.md`의 Rank 3(Claude CLI wall-clock)·Rank 4(Case B System 6
전체 파일)에 집중한 실행 계획. 아래 근거는 전부 이 문서를 작성하며 코드를 직접 읽고,
실제로 `claude -p`를 이 머신에서 타이밍 측정해서 확인한 것 — 추측이 아니다.

**작업 브랜치/워크트리**: `feat/rank3-cli-overhead-rank4-sys6`,
`C:\Users\windo\ESSanalyzer-rank34`. **`main`/원본 체크아웃(`C:\Users\windo\ESSanalyzer`)을
직접 건드리지 말 것.** `.env`는 이미 이 워크트리에 복사되어 있고(`AI_PROVIDER=cli`),
`npm install` 완료 상태. 검증에 필요한 로컬 전용(gitignored) 데이터도 이미 복사해둠:
- `Log_sample/extracted/data_sys_6_stride80.csv` (Case B 다운샘플, 240,603행) — Rank 3 검증용
- `Log_sample/case_b_field_data.zip` (1,668,409,464 bytes ≈ 1.59GB, `field_data/data_sys_6.csv`
  포함 추정 — 압축 해제 시 2.89GB) — Rank 4 검증용

---

## Rank 3 — Claude CLI wall-clock

### 실측: 진짜 병목은 프롬프트 크기가 아니라 CLI 프로세스 기동 오버헤드

`server/lib/claude-cli.js`가 실제로 사용하는 플래그와 동일한 조건으로 "OK 한 단어만
답하라"는 사소한 프롬프트를 직접 두 번 호출해 비교했다(둘 다 `--model sonnet
--allowedTools '' --disable-slash-commands`):

| 조건 | wall-clock | `duration_api_ms` | `cache_creation_input_tokens` | `cache_read_input_tokens` |
|---|---|---|---|---|
| 현재 프로덕션 플래그 그대로 | 27.2s | 16,318ms | 36,730 (전량 새로 생성) | 0 |
| `--safe-mode --strict-mcp-config --no-session-persistence` 추가 | 6.4s | 3,003ms | 2,851 | 29,931 |

약 **4.2배** 차이. `--json-schema` + `--system-prompt`를 실제 프로덕션과 동일하게 함께
넘겨도(구조화 출력 스키마 테스트) `--safe-mode` 조합은 `structured_output`을 정상적으로
채워 반환했고 `is_error:false`, `subtype:"success"`를 유지했다 — 즉 기존 파싱 로직
(`envelope.structured_output` 등)을 깨지 않는다.

원인: `claude -p`는 매 호출마다 새 프로세스이고, `cwd: os.tmpdir()`은 *프로젝트*
CLAUDE.md/hooks 발견만 막을 뿐 **사용자 전역 설정(hooks, MCP 서버, 플러그인 동기화,
auto-memory, keychain 조회 등)은 그대로 로드**한다. 이게 매번 수만 토큰짜리 시스템
프롬프트를 캐시 미스 상태로 새로 생성하게 만들어(`cache_creation_input_tokens` 참고)
실제 데이터 처리와 무관한 고정 오버헤드를 매 호출마다 지불한다. 이 오버헤드는 파이프라인
한 케이스당 순차 호출되는 4~5번(detect-issues → detect-anomaly → generate-hypotheses →
draft-report → 선택적 compare) 전부에 곱으로 누적된다.

**`--bare`가 아니라 `--safe-mode`를 쓰는 이유**: `claude --help`에 따르면 `--bare`는
"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper... OAuth and keychain are
never read"라고 명시되어 있다. 이 프로젝트의 핵심 설계(README: "reuses whatever `claude`
auth is already on this machine — Pro/Max/Team subscription login, NOT a pay-per-token API
key")를 그대로 깨버린다. 반면 `--safe-mode`는 "Auth, model selection, built-in tools, and
permissions work normally"라고 명시되어 있고, 실측에서도 정상 인증·정상 모델(`claude-sonnet-5`)
로 응답했다. 그래서 `--safe-mode`(+ 부가로 `--strict-mcp-config`, `--no-session-persistence`)
가 맞는 선택이다.

### "2500 alarm rows" 주장은 stale — 프롬프트 자체는 이미 작다

`next-ranks-2-to-5.md`는 "shrink the detect prompt (... not 2500 alarm rows)"라고
적혀 있지만, 현재 코드를 직접 읽어 확인한 실제 상한은 다음과 같다:

- `src/log-engine.js`: `HEAD_SAMPLE_CAP=15`, `ALARM_SAMPLE_CAP=40` (버킷/그룹당)
- `src/pipeline.js`의 `blocksToPromptText`: `MAX_TOTAL_ALARM_CONTEXTS=60`이 **요청 전체에서
  공유되는 예산**이라 그룹이 몇 개든 알람 컨텍스트 윈도우는 총 60개를 못 넘는다.
  `CONTEXT_WINDOW=5`(윈도우당 최대 5행)이므로 알람 컨텍스트만으로는 최대 300행 정도다.
- Case B(LFP cell-array)는 `entityColumnGuess`가 엔티티 컬럼을 만들지 않는 "파일 하나 =
  시스템 하나" 포맷이라 `renderGroupedBlock`이 아니라 `renderFlatBlock` 하나로 처리된다 —
  즉 여러 그룹에 나눠 곱해지는 구조조차 아니다.
- 파생 통계 텍스트(`formatDerivedDetails`)도 사유/범주 각각 상위 8개로 잘려 있다.

즉 헤드 샘플 15행 + 알람 컨텍스트 최대 300행 + 작게 잘린 통계 텍스트 정도로, "2500행"과는
거리가 멀다. **이 부분은 이미 어딘가의 이전 커밋에서 고쳐진 뒤 백로그 문서만 안 갱신된
것으로 보인다.** 따라서 Rank 3의 실제 작업은 "프롬프트를 더 줄이는 것"이 아니라 위에서
실측한 CLI 기동 오버헤드 제거다.

### 변경 사항

1. **`server/lib/claude-cli.js`** — `callStructuredViaCli`의 `args` 배열에
   `--safe-mode`, `--strict-mcp-config`, `--no-session-persistence` 추가. 왜 넣는지
   (측정된 오버헤드, `--bare`를 쓰지 않는 이유)를 기존 주석 스타일에 맞춰 한두 줄로 남길 것.
2. **`.env.example`** — `CLAUDE_CLI_TIMEOUT_MS`가 전혀 문서화되어 있지 않다(실제 코드
   기본값은 `server/lib/claude-cli.js`의 `600_000`). 기본값을 바꾸지 말고, 주석과 함께
   추가해서 존재를 드러낼 것 (예: 대용량 LFP 소스에서 10분을 넘길 수 있다는 실측 코멘트).
3. **손대지 말 것**: 504 재시도 UX는 이미 구현되어 있다 (`src/render.js`의 `renderError()`
   → "다시 시도" 버튼 → `src/pipeline.js`의 `retryStage()`). 백로그 문서의 "surface 504 as
   a recoverable retry"는 이미 충족된 것으로 보이니 새로 만들지 말 것.
4. **범위 밖**: `MAX_TOTAL_ALARM_CONTEXTS`/`MAX_GROUPS_PER_SOURCE_IN_PROMPT`/
   `MAX_SELECTED_SOURCES`/`CONTEXT_WINDOW` 등 예산 상수는 위에서 확인했듯 이미 합리적으로
   작다 — 근거 없이 건드리지 말 것.

### 검증 기준 (완료 조건)

- `npm run test:unit`, `npm run build` 통과.
- **실제 비교 측정**: 로컬 dev 서버를 띄우고 `Log_sample/extracted/data_sys_6_stride80.csv`
  기반 Case B 흐름으로 `/api/detect-anomaly`(혹은 최소한 동일 조건의 CLI 호출)를 변경 전/후
  로 각각 실행해 wall-clock을 비교하고, 그 실측치를 이 문서 하단이나 findings 문서에 남길
  것. "플래그를 추가했다"가 아니라 "몇 초 → 몇 초로 줄었다"가 완료 기준이다.
- 반환되는 구조화 출력(JSON)이 플래그 추가 전후로 내용상 동일한 스키마/형태를 유지하는지
  확인 (구조가 깨지면 안 됨).

---

## Rank 4 — Case B System 6 전체 파일(다운샘플 없이)을 브라우저에서

### 기존 인프라 재평가 — 새 Worker는 근거 없이 필요하지 않다

`src/` 전체를 `new Worker`/`postMessage`/`onmessage`로 grep했을 때 **일치하는 곳이
전혀 없다** — 이 코드베이스에는 아직 Web Worker 패턴이 없다. 그런데:

- `src/zip-stream.js`는 이미 async generator(`yield`)와 `await part.arrayBuffer()` /
  `await readArchiveRange(...)` 기반이라 4MB 안팎 청크마다 자연스럽게 이벤트 루프에
  제어를 양보한다. README에 따르면 이미 **실제 2.75GB / 19,248,213행짜리 엔티티**로
  종단 검증까지 마쳤다.
- `src/series-engine.js`의 `MAX_SERIES_POINTS=2000` + adaptive min/max/mean rebinning
  (`createSeriesBuffer`/`pairwiseMerge`)이 차트용 시계열을 행 수와 무관하게 항상 2000
  포인트 이하로 유지한다 — 즉 "차트가 수백만 포인트를 메모리에 쌓아서 탭이 죽는다"는
  걱정은 이미 코드로 해소되어 있다.
- 스트리밍 진행률 UI(`src/render.js`의 `.progress-fill`, `pct`)도 이미 있다.

**결론**: sys_6 전체 파일(2.89GB)이 이미 검증된 2.75GB/19M행 케이스와 규모가 비슷한 이상,
"Worker 아키텍처를 새로 도입해야 한다"는 근거가 코드상 없다. 백로그 문서의 "worker/streaming
ZIP"은 이미 존재하는 streaming 경로를 이 특정 파일로 검증하라는 뜻으로 해석해야 한다.
**Web Worker 신규 도입은 이번 범위에서 제외.**

### 진짜 발견한 버그 — `MAX_RESISTANCE_EVENTS` 캡이 최신 이벤트를 조용히 버린다

`src/forensics/lfp.js`의 `considerResistanceEvent`(약 46~73행):

```js
if (Array.isArray(events)) {
  if (events.length < MAX_RESISTANCE_EVENTS) events.push(event);
  else if ((events.length + 1) % 2 === 0) {
    // Uniform-ish keep: overwrite a strided slot rather than silently drop the tail.
    events[events.length - 1] = event;
  }
}
```

`MAX_RESISTANCE_EVENTS = 4000`(`src/series-engine.js:11`). 캡에 도달하면 `events.length`는
정확히 4000에 고정된다 — `push`는 더 이상 안 되고, `else if` 분기가 실행돼도
`events[events.length-1] = event`는 배열 길이를 바꾸지 않는다. 그 결과
`(events.length + 1) % 2` = `(4000 + 1) % 2` = `4001 % 2` = **항상 1** → 이 "균등 샘플
유지" 분기는 **수학적으로 절대 실행되지 않는다.** 실제 동작은 4000번째 이후 이벤트를
전부, 아무 표시 없이 버리는 것이다.

이게 왜 Rank 4에 특히 치명적인가: 이벤트는 도착 순서대로 버려지므로, 잘려나가는 건 항상
**가장 최근(최신 시점)** 이벤트다. B-F4(저항 열화 figure)가 보여주려는 현상 — 장기 열화의
"late-stage knee" — 은 정확히 시계열 뒷부분에서 나타난다. 지금까지 검증된 stride80(1/80
다운샘플, 240,603행)에서는 이벤트 수 자체가 적어 캡에 안 걸렸을 가능성이 높지만, 다운샘플
없는 전체 sys_6(19M행 안팎, 1,352일 전체 구간)를 켜는 순간 정확히 이 캡에 걸릴 가능성이
높고, 그러면 **가장 중요한 최신 구간의 저항 열화 증거가 조용히 사라진 채로 리포트가
만들어진다** — "생략된 부분은 절대 침묵하지 않는다"는 이 프로젝트 자체의 원칙
(`MAX_LOG_TEXT_CHARS` 절단 시 `buildTruncationNote`로 명시하는 것과 동일한 원칙)에 정면으로
위배. **Rank 4를 "전체 파일 지원"으로 내놓기 전에 반드시 고쳐야 하는 선행 버그.**

### 변경 사항

1. **`src/forensics/lfp.js`의 `considerResistanceEvent` 캡 처리 재작성.** 목표: 캡을
   넘어도 최신 이벤트가 체계적으로 사라지지 않게 할 것. 구현 방식은 자유롭게 선택하되
   (예: 앞쪽 절반은 초기 기준선으로 고정 보존 + 뒤쪽 절반은 최신 이벤트로 계속 교체되는
   rolling window로 운용, 또는 실제 reservoir sampling), 반드시:
   - 캡을 넘겨서 최종적으로 버려진 이벤트 개수를 추적하는 카운터를 추가하고,
   - 그 카운터를 이 프로젝트의 기존 절단 고지 패턴과 일관되게(예: `truncation` 계열 필드에
     합류시키거나 최소한 콘솔/상태에 노출) **비은닉** 처리할 것 — 백로그/원칙 문서
     (`docs/verification/gold-case-acceptance.md`)와 상충되지 않게.
   - 기존 유닛 테스트가 이 함수를 어떤 식으로든 커버하는지 확인하고, 캡 초과 시나리오
     (이벤트 4000개 초과 입력)에 대한 유닛 테스트를 새로 추가할 것.
2. **종단 검증**: `Log_sample/case_b_field_data.zip`을 실제 dev 서버 UI로 업로드 →
   카탈로그된 `field_data/data_sys_6.csv` 항목에서 "분석 포함(스트리밍 시작)" 클릭 →
   완주할 때까지 관찰. 확인할 것:
   - 탭이 멈추거나 크래시하지 않고 진행률 바가 갱신되는지.
   - B-F5/GP-BattGP가 여전히 `unavailable`로 표시되는지 (Vdev에서 추정해서 채우는 일이
     없어야 함 — `docs/verification/gold-case-acceptance.md` 기준 위반 금지).
   - 버그 수정 후, 저항 이벤트(B-F4) 표본에 시계열 **뒷부분(최근 시점)** 데이터가 실제로
     포함되는지 (수정 전/후 비교 스크린샷이나 데이터 스냅샷으로 대조).
   - 총 소요 시간을 기록.
3. **범위 밖**: Web Worker/`postMessage` 아키텍처 신규 도입, GP/BattGP 데이터를 어떤
   형태로든 새로 만들어내거나 추정하는 것.

### 검증 기준 (완료 조건)

- `npm run test:unit`(신규 캡-초과 테스트 포함), `npm run build` 통과.
- 위 종단 검증 체크리스트 전부 통과 + 실측 소요 시간 기록.
- 기존 stride80 기반 Case B 결과(이미 발행된 `Report/case_b_report.html` 등)가 이번 변경
  으로 회귀하지 않는지 간단히 재확인 (같은 입력으로 같은 결론이 나오는지).

---

## 진행 방식 (위임받는 쪽이 지킬 것)

- 이 워크트리(`feat/rank3-cli-overhead-rank4-sys6`)에서만 작업. `main`이나 원본 체크아웃
  경로(`C:\Users\windo\ESSanalyzer`)를 건드리지 말 것.
- Rank 3, Rank 4는 서로 독립적인 변경이니 각각 별도 커밋으로 나눌 것 (한 커밋에 몰아넣지
  말 것). 커밋 메시지는 이 저장소의 기존 스타일(`fix:`, `feat:`, `docs:` 접두어)을 따를 것.
- 다 끝나면: 무엇을 바꿨는지, 실측 결과(Rank 3 wall-clock 비교, Rank 4 종단 검증 로그)를
  요약해서 `Report/rank-3-4-findings.md`로 남길 것 (이 계획 문서와 짝을 이루는 결과 문서 —
  `Report/case_b_findings.md`와 같은 위치/역할).
