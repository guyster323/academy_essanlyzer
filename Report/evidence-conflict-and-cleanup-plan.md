# 근거 상충 UI + 후속 정리 계획 (2026-08-30)

이번 세션에서 Case B 리포트를 재발행하면서 드러난 **Cell 8 vs Cell 5 지목 불일치**를
"이번에 우연히 모델이 알아챈 것"에서 **"구조적으로 반드시 사람에게 보이는 것"** 으로
바꾸는 것이 1번 항목이고, 나머지는 이번 세션이 남긴 후속 정리다.

아래 코드 위치·수치는 전부 직접 확인한 것이다.

---

## 1. 근거 상충을 엔지니어가 판단할 수 있게 하는 UI (최우선)

### 무슨 일이 있었나

재발행된 `Report/case_b_report.html`에서 같은 데이터에 대해 두 근거가 **다른 셀**을
지목했다:

- **전압 잔차(voltage residual)** → **Cell 8**
- **이벤트 저항(event resistance)** → **Cell 5** (+ 2018-11-24 부근 knee)

이건 버그가 아니라 **방법론이 다르면 다른 답이 나올 수 있다**는 실제 현상이다. 문제는
지금 앱이 이 상충을 **어디에서도 구조적으로 드러내지 않는다**는 것이다. 이번엔 모델이
스스로 알아채서 리포트에 적었지만, 다음번에도 그러리라는 보장이 없다. 이 프로젝트의
핵심 원칙("사람이 모든 중요한 판단을 한다", "생략·불확실은 절대 침묵하지 않는다")에
비추면 **이건 반드시 UI가 떠먹여줘야 하는 정보**다.

### 두 지목이 실제로 어디서 나오는가 (확인 완료)

| 근거 | 계산 위치 | 형태 |
|---|---|---|
| 전압 잔차 지목 | `src/formats.js:331-361` — 행마다 `absVdev`가 최대인 셀을 골라 `categories.outlierCell`로 기록 → `src/log-engine.js:201-206`에서 `derived.categoryCounts.outlierCell`에 누적 | `{"Cell 8": 9271, "Cell 3": 50, ...}` 카운트 맵 |
| 이벤트 저항 지목 | `src/figures.js:178` — `outlierCellByResistance(matched.length ? matched : events)` | `B-F1.summaryStats.outlierCell` (숫자 1개) + `deltaR` 점수 |

즉 **두 값이 이미 런타임에 다 존재한다.** 새로 계산할 게 없고, 비교해서 보여주기만
하면 된다.

### 만들 것

**(a) 상충 감지 로직** — 새 모듈(예: `src/attribution-conflict.js`)로 분리할 것.
`src/figures.js`나 `render.js`에 인라인으로 박지 말 것 (테스트 가능해야 한다).

- 입력: `blocks`(또는 `derived.categoryCounts`)와 `figures`
- 전압 잔차 쪽 1순위 셀 + 그 비중(예: 9,271/9,366 = 99%)을 뽑고,
- `B-F1.summaryStats.outlierCell`과 비교
- 두 값이 **모두 존재하고 서로 다를 때만** 상충으로 판정
- 한쪽이 없으면 상충이 아니라 **"교차검증 불가"** 로 구분할 것 (이 둘을 같은 것으로
  취급하지 말 것 — 없는 것과 어긋나는 것은 다르다)
- 반환값에 판정 근거가 되는 실제 수치를 포함할 것 (카운트, 비중, `deltaR`,
  `matchedCount`, `droppedEvents`) — 사람이 판단하려면 숫자가 필요하다

**(b) UI 표시** — 두 곳:

1. **Step 2 (`renderAnomalyView`, `src/render.js:351`)** — 근거 그래프가 처음 나오는 곳.
   상충이 있으면 눈에 띄게 표시.
2. **Step 4 (`renderHypothesisView`, `src/render.js:419`)** — **여기가 진짜 결정 지점.**
   기존 `checkpoint-banner`(432-435행) 바로 근처에, 가설 선택 라디오 위에 배치할 것.
   엔지니어가 가설을 고르기 **전에** 봐야 하는 정보다.

표시 내용(양쪽을 나란히, 어느 쪽도 편들지 말 것):

- 각 방법이 지목한 셀과 그 근거 수치
- **각 방법이 무엇을 증명할 수 있고 없는지** — 전압 잔차는 저항이 아니다(`B-F3`의
  `summaryStats.note`에 이미 `'전압 잔차 (저항 아님)'`이라고 적혀 있다), 이벤트 저항은
  전류 전이 이벤트가 있어야만 계산된다(매칭 통과 건수·drop 건수가 신뢰도에 직결)
- "어느 쪽이 맞다"는 **앱이 판정하지 말 것.** 자동 선택·자동 정렬·기본 선택 전부 금지.

**(c) 하지 말 것**

- 상충을 자동으로 "해결"하거나 한쪽을 기본값으로 고르는 것
- 사람 검토 체크포인트를 우회·자동완성하는 것
- 상충이 있다고 해서 가설 선택 자체를 막는 것 (경고는 하되 **차단하지 말 것** —
  엔지니어가 근거를 알고 진행하는 것도 정당한 판단이다)

**(d) 리포트까지 전달 (선택이지만 권장)**

`server/lib/prompts.js`의 `buildDraftReportPrompt`는 이미 `figureCatalog`와
`evidenceLedger`를 받는다. 상충 정보를 함께 넘겨 리포트가 이번처럼 매번 이 불일치를
명시하도록 만들면, "모델이 알아채면 적고 아니면 마는" 상태를 벗어난다. 넘기더라도
**결론을 지시하지 말 것** — 상충 사실만 전달하고 판정은 여전히 사람/모델의 근거 기반
서술에 맡길 것.

### 검증 기준

- 상충 감지 유닛 테스트: 상충 있음 / 한쪽 없음(교차검증 불가) / 일치함 3가지 케이스
- `Log_sample/extracted/data_sys_6_stride80.csv`로 실제 앱을 돌려 **Cell 8 vs Cell 5
  상충이 Step 2·Step 4에 실제로 표시되는지** 스크린샷으로 확인
  (이 파일은 이 워크트리에 이미 있다)
- 상충이 없는 데이터에서는 이 UI가 **나타나지 않는지**도 확인 (거짓 양성 금지)

---

## 2. `feedLine`이 ZIP 스트리밍의 90% — 측정 먼저

PR #5로 yield 비용을 걷어낸 뒤, System 6 809초 중 **727초(89.9%)가 `feedLine`**이다
(`Report/latency-findings.md`). 이제 여기가 유일하게 남은 큰 덩어리다.

**측정부터 할 것.** `feedLine` 안에서 무엇이 비싼지 아직 아무도 모른다. 후보:
CSV 셀 분리, `computeDerivedAlarm`(LFP Vdev/robust-z/voltage-closure), 시리즈 버퍼
`pushSample`, `collectForensics`/`considerResistanceEvent`. `scripts/profile-stream.mjs`가
이미 있으니 그 안에서 더 잘게 쪼개는 방식이 자연스럽다.

측정 결과가 나온 뒤에만 최적화할 것. **근거 없이 미리 최적화하지 말 것.** 그리고 어떤
최적화든 **파생 지표 값이 바뀌면 안 된다** — 같은 입력에 같은 행 수·같은 파생 이상
건수가 나오는지 반드시 대조할 것(stride80: 240,603행 / 파생 이상 9,366건).

Web Worker는 여전히 범위 밖 — 측정이 그걸 정당화하기 전에는 도입 금지.

## 3. `--effort` 재측정 (이전 측정은 무효였다)

`Report/latency-findings.md`의 `--effort` 측정은 **믿을 수 없다.** 9회 중 7회가 빈
`anomalyWindows`를 반환하며 "원본 로그가 첨부되지 않았다"고 답했고, 16건을 낸 2회는
이전 세션 데이터를 기억해낸 정황이 있다. 즉 "일을 안 한 실행"과 "일을 한 실행"의
시간을 비교한 셈이다.

**제대로 하려면**: 짧은 요약문이 아니라 **실제 `blocksToPromptText` + `buildDetectAnomalyPrompt`
출력**(stride80 기준 약 54,780자, `Report/rank-3-4-findings.md` 참고)을 프롬프트로 써야
한다. 그래야 모델이 실제로 일을 한다.

- `low / medium / high` 각 3회 이상, 인터리브
- **매 실행이 실제로 유효한 결과를 냈는지 먼저 확인**하고(빈 결과는 측정에서 제외하되
  제외했다는 사실과 횟수를 기록), 그 다음에 시간을 비교할 것
- 가능하면 `generate-hypotheses`도 (이전엔 429로 못 쟀다). 429가 또 나면 **그 사실을
  기록하고 넘어갈 것** — 무리해서 우회하지 말 것
- **품질 판단은 하지 말 것.** 비교 자료만 파일로 남기고 채택 여부는 사람에게 맡길 것
  (이전 워커가 이 부분을 올바르게 처리했다 — 같은 태도 유지)

## 4. 문서 정합성

- `Report/next-ranks-2-to-5.md`: Rank 2·3·4가 완료됐는데 여전히 미완으로 적혀 있고,
  Rank 3 설명("shrink the detect prompt — not 2500 alarm rows")은 이번에 **틀렸다고
  증명됐다**(입력이 아니라 thinking이 병목). 완료 표시 + 틀린 진단을 정정하되,
  **원래 뭐라고 적혀 있었는지와 왜 틀렸는지는 지우지 말고 남길 것** (이 저장소는
  실패·오판 기록을 보존하는 방식으로 문서를 써 왔다).
- `Report/pipeline-latency-plan.md`: `latency-root-cause-and-plan.md`가 이 문서의 1순위
  가설(`maxItems` 누락이 지연 원인)을 실측으로 뒤집었다. 상단에 "이후 정정됨" 포인터를
  달아 다음 사람이 이 문서만 읽고 잘못된 결론을 가져가지 않게 할 것.
- `Report/README.md` 표에 이번에 추가되는 문서 행 추가.

## 5. 자잘한 코드 정리 (가치 대비 저비용)

- **`server/lib/schemas.js`의 `anomalyWindows`에 `maxItems` 없음** — 이 파일에서 유일하게
  상한이 없는 배열이다(다른 것들은 4/3/12/20/5/16). 지연시간 원인은 아니라고 판명됐지만
  일관성 문제로는 여전히 유효하다. 상한을 둘 경우 **잘린 사실이 침묵되면 안 된다** —
  `buildTruncationNote` 패턴대로 명시할 것. 상한값은 실제 골드런에서 나온 건수
  (Case B 16건 등)를 근거로 정할 것.
- **`src/figures.js`의 `unavailableReason` 삼항 중복 12회** — 같은
  `available ? null : reason` 패턴이 반복된다. 헬퍼로 묶되, PR #2 리뷰에서 실제 버그
  2건(A-F4/B-F3의 available/unavailableReason 모순)이 나왔던 자리이므로 **리팩터링으로
  동작이 바뀌지 않는지 유닛 테스트로 고정**한 뒤에 손댈 것.
- **`src/pipeline.js:459`/`471`의 두 제외 목록** — `stripBucketHeavy`의 제외 필드와
  `logSources.map` 구조분해의 제외 필드가 서로 다른 곳에 흩어져 있어, 새 무거운 필드가
  생겼을 때 한쪽만 갱신되면 조용히 새 나간다. 한 곳에서 관리되도록 정리할 것.

---

## 우선순위

1번이 압도적으로 중요하다 — 나머지는 성능·정리인데 1번은 **분석 결론의 정확성**에
직결된다. 1번을 먼저 끝내고 커밋한 뒤 2~5로 갈 것. 시간이 부족하면 **1번과 4번(문서)을
확실히 끝내고 나머지는 남기는 편**이 낫다 — 절반만 된 성능 작업보다 낫다.

## 작업 규칙

- 이 워크트리(`C:\Users\windo\ESSanalyzer-conflict`,
  브랜치 `feat/evidence-conflict-ui-and-cleanup`)에서만 작업.
  `C:\Users\windo\ESSanalyzer`(메인 체크아웃)와 `main` 브랜치는 절대 건드리지 말 것.
- 항목별로 커밋을 나눌 것 (한 커밋에 몰아넣지 말 것). 커밋 스타일은 기존대로
  (`fix:`/`feat:`/`docs:`).
- `npm run test:unit`, `npm run build` 통과 필수.
- 결과는 `Report/evidence-conflict-and-cleanup-findings.md`로 남길 것 — **무엇을 했는지뿐
  아니라 무엇을 안 했는지와 그 이유도** 쓸 것. 측정해서 "효과 없었다"가 나오면 그대로
  쓸 것. 이 저장소에서는 잘 측정된 음성 결과도 성공이다.
