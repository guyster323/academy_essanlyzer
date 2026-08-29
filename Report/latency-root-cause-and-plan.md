# 700초 지연 — 원인 분석과 개선 계획 (2026-08-30)

`Report/pipeline-latency-plan.md`의 후속이자 **부분 정정**. 그 문서는 코드 읽기만으로
가설을 세웠는데, 이번엔 실제로 `claude -p`를 5가지 설정으로 측정해서 가설 중 일부가
틀렸음을 확인했다. 아래 숫자는 전부 이 머신에서 직접 측정한 것이다.

---

## 1. 핵심 발견 — 700초는 ZIP/로그 크기와 아무 상관이 없다

**약 200자짜리 프롬프트 하나로 220~367초가 걸린다.** ZIP도, 2.89GB 로그도, 24만 행도
없이, 순수하게 짧은 텍스트 한 덩어리만 보냈을 때의 수치다.

측정 조건: 프로덕션(`server/lib/claude-cli.js`)과 **동일한 플래그**
(`-p --output-format json --json-schema ... --model sonnet --allowedTools ''
--disable-slash-commands --safe-mode --strict-mcp-config --no-session-persistence`),
`detect-anomaly` 스키마와 같은 모양(상한 없는 `anomalyWindows` 배열)의 JSON 스키마,
입력은 아래 한 문단뿐:

> 아래는 LFP 셀 어레이 로그의 파생 통계 요약이다. 2018-10-10부터 2018-11-28까지 Cell 8의
> 전압편차가 반복적으로 관측되었고, 파생 이상 행이 9,366건이다. 이상 구간을 가능한 한
> 빠짐없이, 발견되는 대로 모두 나열하라.

| # | 설정 | wall-clock | output 토큰 | **thinking 토큰** | 구조화 출력 |
|---|---|---|---|---|---|
| A | 현재 프로덕션 그대로 | **367s** | 30,207 | **19,725 (65%)** | 정상 (16건) |
| B | `--effort medium` 추가 | **220s** | 19,150 | 10,654 (56%) | 정상 (16건) |
| C | `--effort low` 추가 | **303s** | 28,667 | 19,488 (68%) | 정상 (16건) |
| D | `CLAUDE_CODE_MAX_OUTPUT_TOKENS=4000` | 323s | 26,957 | 21,663 (80%) | **실패 — `is_error:true`, `stop_reason:stop_sequence`, `structured_output` 없음** |
| E | `MAX_THINKING_TOKENS=2000` | 320s | 23,834 | 18,084 (76%) | 정상 (12건) — **thinking 제한이 전혀 안 걸림** |

여기서 바로 따라 나오는 결론들:

1. **입력 크기는 병목이 아니다.** Rank 3에서 "프롬프트는 이미 작다"고 결론냈던 게 맞았고,
   이번엔 그 반대 방향으로도 증명됐다 — 입력을 사실상 0으로 줄여도 여전히 5~6분이 걸린다.
   **따라서 ZIP 크기·행 수·`MAX_TOTAL_ALARM_CONTEXTS` 같은 입력 쪽 최적화로는 700초를
   줄일 수 없다.**
2. **비용의 정체는 extended thinking이다.** 모든 실행에서 출력 토큰의 **56~80%가 thinking
   토큰**이다. 실제 답변(anomalyWindows 16건)은 전체의 일부에 불과하다.
3. `pipeline-latency-plan.md`의 1순위 제안이었던 **`anomalyWindows`의 `maxItems` 누락은
   주범이 아니다.** 5번 실행 모두 12~16건만 생성했다 — 상한이 없어서 40건씩 쏟아낸 게
   아니었다. (일관성 차원에서 상한을 두는 건 여전히 맞지만, 지연시간 해결책은 아니다.)

## 2. 실제 코드 버그 — `maxTokens`가 cli 경로에서 조용히 버려진다

`server/routes/analysis.js`는 단계마다 출력 상한을 넘긴다:

```js
router.post('/detect-anomaly', wrap('detect-anomaly', async (body) => {
  return callStructured({ system: PERSONA, prompt, tool: detectAnomalyTool, maxTokens: 2000 });
}));
```

그런데 `server/lib/ai-provider.js:19`:

```js
return callStructuredViaCli({ system, prompt, tool });   // ← maxTokens가 없다
```

`server/lib/anthropic.js:41`은 `max_tokens: maxTokens`로 제대로 쓰는데, **기본 provider인
`cli`에서만 이 값이 소리 없이 사라진다.** 실측된 output 토큰 30,207은 의도된 상한 2,000의
**15배**다. 즉 코드가 "2000 토큰으로 제한했다"고 믿는 것과 실제 동작이 다르다.

**단, 이걸 순진하게 고치면 오히려 망가진다** — 위 표의 D행이 그 증거다.
`CLAUDE_CODE_MAX_OUTPUT_TOKENS=4000`을 걸었더니 thinking이 21,663 토큰을 먼저 소진해서
구조화 출력이 나오기도 전에 잘렸고, `is_error:true`에 `structured_output`이 아예 없었다.
**thinking 토큰이 같은 예산을 먹기 때문에**, 상한은 반드시 thinking 실사용량보다 넉넉히
위여야 한다. 이건 "상한을 전달한다"로 끝나는 작업이 아니라 "전달하되 깨지지 않는 값을
실측으로 정한다"가 되어야 한다.

## 3. 쓸 수 있는 레버 / 없는 레버

- **`--effort`**: 방향이 일관되지 않다. medium(220s)이 low(303s)보다 **빨랐다**. n=1
  측정이라 실행 간 편차가 효과보다 크다는 뜻이다. **채택 전 반드시 각 수준당 3회 이상
  측정**해야 하고, 속도가 실제로 줄더라도 `disconfirmingEvidence`/`missingSignals`/
  `claimLimit` 같은 근거 엄밀성 필드의 품질을 사람이 나란히 비교해야 한다.
- **`MAX_THINKING_TOKENS`**: 이 CLI 버전에서 **효과 없음**(E행, thinking 18,084 그대로).
  레버가 아니다.
- **`CLAUDE_CODE_MAX_OUTPUT_TOKENS`**: 위험. 값을 잘못 잡으면 파이프라인이 조용히 깨진다.

**정직한 결론: 현재 `cli` 경로에는 thinking 시간을 안전하게 줄일 확실한 레버가 없다.**
개선 여지가 있다면 `--effort` 뿐인데 그건 아직 증명되지 않았다.

---

## 4. 그래서 타임아웃을 먼저 고쳐야 한다 (사용자 지시 반영)

`server/lib/claude-cli.js:30`의 코드 기본값은 **600,000ms(10분)** 이다. 그런데
`Report/rank-3-4-findings.md`에 기록된 실측은 **700.9초** — **기본값으로 새로 클론한
사람은 Case B 골드런에서 반드시 504로 실패한다.** 지금 이 저장소가 안 터지는 유일한
이유는 로컬 `.env`에 `CLAUDE_CLI_TIMEOUT_MS=1200000`이 있기 때문인데, 그건
git에 올라가지 않는 파일이라 다른 사람에게는 존재하지 않는다.

**조치**: 코드 기본값을 `1_200_000`(20분)으로 올린다. 위 3절대로 thinking 시간을 줄일
확실한 방법이 없는 이상, 관측된 700초+에 여유를 둔 값이 정직한 기본값이다. 주석에
"측정 근거(700.9초 실측)"와 "이건 성능 목표가 아니라 안전 한계"임을 남긴다.
`.env.example`의 주석도 새 기본값에 맞춰 갱신한다.

---

## 5. ZIP 경로는 별개 문제 — 850초, 그리고 실제로 찾은 비효율

위 700초는 AI 호출이고, ZIP 스트리밍은 **완전히 다른 구간**이다. 헷갈리면 안 된다.

Rank 4 실측(`Report/rank-3-4-findings.md`): System 6 `field_data/data_sys_6.csv`
2.89GB / 19,248,213행 스트리밍에 **850초(14.2분)**. 처리율로 환산하면 약 **3.4 MB/s**로,
inflate 단독 처리량(수십 MB/s급)에 한참 못 미친다 — 압축 해제가 아니라 **행 파싱 루프**가
지배적이라는 뜻이다.

`src/log-engine.js`의 `streamIntoSource`에서 구체적인 비효율을 하나 찾았다:

```js
const LINES_PER_YIELD = 2000;                       // 19행
...
await new Promise(resolve => setTimeout(resolve, 0)); // 332행 — yieldToUi()
...
if (++sinceYield >= LINES_PER_YIELD) await yieldToUi();  // 344행
await yieldToUi();                                       // 346행 — 청크마다 무조건 한 번 더
```

브라우저의 `setTimeout(..., 0)`은 중첩 호출 5회 이후 **최소 4ms로 클램프**된다(HTML 명세).
System 6 기준 19,248,213 ÷ 2,000 = **9,624회**의 yield가 발생하고, 여기에 청크마다
무조건 한 번씩 더(2.89GB ÷ 4MB ≈ 722회) 붙는다. 대략 (9,624 + 722) × 4ms ≈ **41초**가
순수하게 타이머 클램프 대기다 — 850초의 약 5%. 지배적이진 않지만 **공짜로 회수 가능한
실제 낭비**이고, 나머지 95%가 어디서 쓰이는지는 아직 아무도 측정하지 않았다.

**이 절의 작업은 "고쳐라"가 아니라 "먼저 측정하라"다.** 근거 없이 최적화하지 말 것.

---

## 6. 실행 계획

### 6-1. 타임아웃 기본값 상향 (확실 · 즉시)

- `server/lib/claude-cli.js`의 `CLI_TIMEOUT_MS` 기본값 `600_000` → `1_200_000`.
- 주석에 근거(700.9초 실측, `Report/rank-3-4-findings.md`)와 "성능 목표가 아닌 안전 한계"
  임을 명시.
- `.env.example`의 `CLAUDE_CLI_TIMEOUT_MS` 주석을 새 기본값 기준으로 갱신.
- 이건 **개선이 아니라 현실 반영**이다. 3절에서 확인했듯 지금은 줄일 확실한 방법이 없다.

### 6-2. `maxTokens` 누락 수정 — 단, 깨지지 않는 값으로 (신중)

- `ai-provider.js`가 `maxTokens`를 `callStructuredViaCli`에 전달하도록 고친다.
- **그냥 전달하면 안 된다.** 위 D행처럼 구조화 출력이 통째로 사라진다. 반드시:
  1. 각 단계(detect-anomaly / generate-hypotheses / draft-report)의 **실제 thinking +
     answer 토큰 사용량을 먼저 측정**하고,
  2. 그 최댓값에 충분한 여유를 둔 값을 상한으로 잡고,
  3. 상한 적용 후 **모든 단계에서 `structured_output`이 정상적으로 나오는지** 실제
     파이프라인으로 확인한다.
- 여유값을 정할 근거가 안 나오면 **적용하지 말고**, 대신 "cli 경로는 maxTokens를 무시한다"는
  사실을 코드 주석과 문서에 명시해서 **최소한 침묵하지는 않게** 한다. 이 프로젝트의
  기존 원칙(생략된 것은 절대 침묵하지 않는다)과 같은 태도다.

### 6-3. `--effort` 제대로 측정 (증명되면 채택, 아니면 폐기)

- `low / medium / high(기본)` 각각 **최소 3회** 반복 측정, 같은 프롬프트로.
- 평균뿐 아니라 **편차**도 기록 — 위 B/C행이 뒤집힌 이유가 편차일 가능성이 크다.
- 시간이 유의미하게 줄어드는 수준이 있으면, **같은 입력에 대한 출력을 나란히 놓고
  근거 엄밀성 필드(`evidenceTier`, `disconfirmingEvidence`, `missingSignals`,
  `claimLimit`)의 품질을 사람이 비교**할 수 있도록 결과물을 파일로 남긴다.
- **속도만 보고 채택하지 말 것.** 품질 판단은 사람 몫으로 남기고, 워커는 판단하지 말고
  비교 자료만 만든다.

### 6-4. ZIP 스트리밍 — 측정 먼저, 그 다음 수정

- `streamIntoSource`에 구간별 계측을 넣어 850초가 어디로 가는지 나눈다:
  inflate / `TextDecoder` / `split` / `feedLine` / yield 대기.
- 그 결과를 근거로만 수정한다. yield 비용(추정 약 41초)이 실제로 유의미하면
  `setTimeout(0)`을 `MessageChannel`/`queueMicrotask` 기반 yield로 바꾸거나
  `LINES_PER_YIELD`를 올린다 — **단 UI 응답성(진행률 바 갱신)이 유지되는지 반드시 확인.**
  Rank 4에서 검증한 "탭이 멈추지 않는다"는 성질을 깨면 안 된다.
- 측정 결과 yield가 무시할 수준이면 **손대지 말고 그 사실을 기록**한다.

### 6-5. 명시적으로 하지 않는 것

- 가설 개수(3), FTA 항목, 이메일 본문 등 **출력 요구사항 축소** — 속도는 빨라지지만 이
  프로젝트가 의도적으로 요구하는 근거 엄밀성을 깎는 일이라 사용자 판단 없이 진행 금지.
- 사람 검토 체크포인트 생략/자동화.
- `AI_PROVIDER=api` 전환 (과금 발생 — 비즈니스 결정).
- `MAX_TOTAL_ALARM_CONTEXTS` 등 입력 예산 조정 — 1절에서 입력이 병목이 아님이 증명됐다.
- Web Worker 도입 — Rank 4에서 필요 없다고 결론냈고, 6-4의 측정 결과가 그걸 뒤집기
  전에는 근거가 없다.

---

## 7. 검증 기준 (완료 조건)

- `npm run test:unit`, `npm run build` 통과.
- 6-1은 코드/문서 반영 확인.
- 6-2는 "적용했다" 또는 "적용하지 않기로 했다 + 그 이유와 측정치"가 문서에 남을 것.
  둘 다 정당한 결과다.
- 6-3은 `low/medium/high × 3회` 원시 측정치 표와 품질 비교용 출력 파일.
- 6-4는 구간별 계측 수치. 수정했다면 수정 전/후 비교, 안 했다면 안 한 이유.
- 결과는 `Report/latency-findings.md`로 남긴다 (이 문서와 짝).
