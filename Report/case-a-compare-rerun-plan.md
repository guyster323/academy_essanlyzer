# Case A 공개 대조본 재실행 — 계획 (2026-09-03)

PR #14가 남긴 갭 하나만 닫는다. 코드 변경은 예정에 없다.

---

## 왜

PR #14의 라이브 런은 독립 보고서 저장까지 성공한 뒤 공개 대조 단계에서
`You've hit your session limit · resets 2:20am (Asia/Seoul)`(`2026-08-31T14:52:14Z`)로 끊겼다.
`Report/case_a_pipeline.json`에 `publishedComparison: { attempted: true, ok: false }`로 기록되어 있다.

결과적으로 `Report/case_a_report_compared.html`은 **PR #13 런의 산출물**이 그대로 남아 있다.
PR #14가 타임스탬프 해석을 고쳐 모든 시각이 1시간 이동했으므로, 지금 저장소에는
**서로 1시간 어긋난 독립본과 대조본**이 나란히 있다. 대조표를 읽는 사람이 독립본과
같은 런이라고 오해할 수 있다.

## 왜 전체 재실행인가 (부분 실행 경로를 먼저 확인했다)

대조는 보고서를 들고 있는 앱 세션 안에서만 돈다(`tests/e2e/regenerate-case-a.spec.js`의
`runPublishedComparison` → `state.publishedComparison` → `buildReportHtml`). 저장된 런의
상태를 되살리는 경로는 없다:

- `tmp/case-a-regen/partial.json`에는 `figures`(카탈로그 수준)·`sourceProfiles`·`hypotheses`만 있고
  **`report` 본문이 없다.**
- figure PNG는 `chartToPng(fig)`가 시리즈 데이터로 다시 그린다. 카탈로그만으로는 못 그린다.
- 저장된 HTML에서 보고서 필드를 역파싱해 상태를 주입하는 방법은 가능하지만, 산출물의
  출처가 "앱이 내보낸 것"이 아니게 된다. 이 저장소의 기준에 맞지 않는다.

그래서 **정식 스펙을 처음부터 한 번 더 돈다.** 독립본과 대조본이 **같은 세션**에서 나온다.

## 무엇을 할 것인가

- 입력은 PR #11/#13/#14와 동일: 발행일 `20250818,20250819,20250820`(거래일 17/18/19),
  엔티티 필터 BESS, 중첩 zip 실경로.
- `RUN_CASE_A=1 PW_PORT=5186`, API 서버 `:3001`. `CASE_A_SKIP_COMPARE`는 설정하지 않는다.
- 대조 발췌는 스펙에 이미 있는 것을 쓴다(제목·Market Notice 한 줄). **독립 HTML 저장 이후에만**
  입력된다 — 스펙이 그 순서를 강제한다.
- 산출물 3개를 이 런 것으로 교체: `case_a_report.html`, `case_a_report_compared.html`,
  `case_a_pipeline.json`.

## 사람 검토 (Step 4)

**이전 결론에 맞추지 말 것.** PR #14는 H2(PPC/EMS 급전 추종편차)를 채택했고 PR #13은
FCAS/AGC·재디스패치였다 — 두 번 다른 결론이 나왔다는 사실 자체가, 이번 런의 가설 목록을
**새로 읽고** 근거로 판단해야 한다는 뜻이다. `tmp/case-a-regen/hypotheses.json`을 읽고
채택 근거를 findings에 적는다. 채택이 또 바뀌면 바뀐 대로 기록한다.

## 검증

- 스펙이 이미 거는 것: `findingsFrozen`(대조가 독립 findings를 덮어쓰지 않음),
  대조본에 `공개 결과 대조`·`Independent Findings` 존재, `pageerrors` 없음.
- 추가로 기록할 것: 이번 런의 파생 이상 수·figure 가용성·A-F1 앵커가 PR #14 값과
  같은지 다른지. **같기를 기대하되 단정하지 않는다** — AI 단계는 비결정적이고,
  스트리밍·figure 단계는 결정적이어야 한다. 어긋나면 그 사실이 발견이다.
- `npm run test:unit`, `npm run build` 재확인.

## 하지 말 것

- 코드 동작 변경. 이번 증분은 산출물 교체다. 런 중 버그가 드러나면 findings에 적고
  고칠지는 따로 판단한다.
- `Report/case_b_*` 수정. Case B 재발행은 여전히 사람 판단 대기 항목이다.
- AEMO 수치·날짜·시각(−55 MW, 12:15, 12:05, 19 Aug)을 코드·임계·픽스처에 넣기.
- 동시에 두 파이프라인 실행. `AI_PROVIDER=cli`는 로컬 `claude` 로그인을 그대로 쓰므로
  같은 계정 쿼터를 소모한다.
- 세션 한도에 또 걸리면 시각을 기록하고 부분 결과를 유지한다. 갭은 갭으로 남긴다.

## 산출물

- 재발행된 `Report/case_a_report.html` · `case_a_report_compared.html` · `case_a_pipeline.json`
- `Report/case-a-compare-rerun-findings.md` — 채택 가설과 근거, PR #14 값과의 대조,
  벽시계, 못 한 것과 이유
