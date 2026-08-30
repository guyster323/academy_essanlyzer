# 원본 해상도 저항 이벤트 + 공개 결과 대조 — findings (2026-08-30)

짝 문서: `Report/full-resolution-and-comparison-plan.md`.
브랜치 `feat/full-resolution-resistance`. 이 워크트리만 사용.
`C:\Users\windo\ESSanalyzer`와 `main`은 건드리지 않았다.

`npm run test:unit` 136/136, `npm run build` 통과.
라이브 파이프라인: `RUN_CASE_B_FULLRES=1 PW_PORT=5185 npx playwright test tests/e2e/regenerate-case-b.spec.js --project=desktop-chromium --grep "full-resolution"` — **1 passed, 46.0분**.

원본 덤프: `Report/full-resolution-sys6.json`.
T2 대조 JSON: `Report/full-resolution-t2-comparison.json`.
대조 HTML: `Report/case_b_report_compared.html`.
`Report/case_b_report.html`은 **덮어쓰지 않았다** (해시 전후 동일 `6d8cfc6`).

임계값(`MAX_RESISTANCE_EVENTS`, `LFP_DI_THRESHOLD`)과 코드 기본 `CLAUDE_CLI_TIMEOUT_MS`는 바꾸지 않았다.
GP/BattGP는 구현하지 않았다. 논문 수치(1,446 / 1,352 / 500 / 800 / 3년)는 코드에 넣지 않았다.

---

## 결론 — Cell 8 / Cell 5 불일치의 운명

**(c) 양상이 바뀌었다.** 해소되지 않았고, Cell 5가 그대로인 것도 아니다.

- 전압 잔차(Vdev)는 원본 해상도에서도 **Cell 8**이다: 744,400 / 751,683건 (**99.0%**). stride80의 9,271 / 9,366 (99%)와 같은 쪽이다.
- 이벤트 저항(B-F1)은 stride80의 **Cell 5**가 사라지고 **Cell 1**을 지목한다 (`outlierCell=1`, ΔR≈1.546×10⁻⁴).
- 앱의 교차 지목 상태는 여전히 `conflict`다. 배너는 Step 2에서 Cell 8 vs Cell 1을 나란히 보여 주고, 어느 쪽을 채택하지 않는다 (`Report/fullres-step2.png`).
- 따라서 **Cell 5는 1/80 다운샘플의 아티팩트로 보는 것이 맞다.** 연속 행 ΔI 구조가 복원되면 Cell 5 지목은 재현되지 않는다. 그 자리에 Cell 1이 들어온 것이지, Vdev-Cell 8과 합치된 것이 아니다.

어느 쪽이든 정당한 결과라고 계획에 적혀 있었고, 나온 결과는 (c)다.

---

## T1 — 비교표 (실측)

입력: `Log_sample/case_b_field_data.zip` (1,668,409,464 bytes) → 카탈로그된 `field_data/data_sys_6.csv` (uncompressed 2,889,184,963 bytes, format `lfp-cell-array`)에서 「분석 포함 (스트리밍 시작)」. 28개 로그 항목이 카탈로그됐고, **data_sys_6.csv만** 스트리밍했다.

| 항목 | stride80 | 원본 해상도 |
|---|---|---|
| 행 수 | 240,603 | **19,248,213** |
| 파생 이상 | 9,366 | **751,686** |
| B-F1 `outlierCell` | **Cell 5** | **Cell 1** |
| B-F1 ΔR | ≈6.3×10⁻⁵ | **1.546×10⁻⁴** |
| B-F1 `matchedCount` / `eventCount` | 1,330 / 4,000 | **603 / 4,000** |
| `droppedEvents` | 51,677 | **575,026** |
| B-F4 knee 시점 | 2018-11-24 | **unavailable** (`저항 시계열이 짧아 knee를 독립 탐지할 수 없음`) |
| B-F4 이벤트 구간 | (stride80 유지분) | first **2018-04-28T09:46:25Z**, last **2022-01-06T12:32:25Z** |
| Vdev `outlierCell` | Cell 8 (9,271/9,366, 99%) | **Cell 8 (744,400/751,683, 99.0%)** |
| 근거 상충 상태 | `conflict` (Cell 8 vs Cell 5) | **`conflict` (Cell 8 vs Cell 1)** |
| B-F5 / GP-BattGP | unavailable | **unavailable** — `GP/BattGP는 이번 범위에서 미구현 — Unknown으로 남깁니다`. Vdev로 채우지 않음. |
| B-F6 | unavailable (balancing 컬럼 없음) | 동일 |
| 데이터 구간 | 2018-04-28T09:45:05Z ~ 2022-01-10T07:15:00Z | 2018-04-28T09:45:05Z ~ **2022-01-10T08:06:00Z** |
| 알람 근거 구간 | 2018-10-09 ~ 2022-01-10 (커버리지 87.8%) | 2018-04-28T09:48:10Z ~ 2022-01-10T08:06:00Z (**커버리지 ≈100%**) |

Vdev 셀 집계 (원본, `derived.categoryCounts.outlierCell`):

| Cell | 건수 |
|---|---|
| Cell 8 | 744,400 |
| Cell 3 | 3,386 |
| Cell 1 | 3,038 |
| Cell 5 | 456 |
| Cell 7 | 401 |
| Cell 4 | 2 |
| 합 | 751,683 |

Cell 5의 Vdev 건수는 456건(0.06%)이다. stride80에서 저항 쪽으로 지목됐던 그 셀은, 원본 해상도의 전압 잔차에서도 두드러지지 않는다.

스트리밍은 탭 hang/crash 없이 완주했다 (`pageerror` 0건). 벽시계 14.0분 (11:54:47 → 12:08:47 UTC), Rank 4의 14.2분과 같다. 행 수 19,248,213도 Rank 4와 같다.

### 캡이 결론에 영향을 주는가

`MAX_RESISTANCE_EVENTS=4000`은 그대로 두었다. 원본에서 qualifying 이벤트 579,026건 중 4,000건만 남고 **575,026건이 drop**된다. Rank 4 관측(575,026)과 동일. 계획대로 캡을 올려 숫자를 예쁘게 만들지 않았다.

PR #4의 유지 방식(초기 기준선 2000 + 최근 창 2000)은 동작 중이다. 첫 이벤트 2018-04-28, 마지막 2022-01-06 — 후반부가 침묵 삭제되지 않았다.

다만 이 캡은 저항 쪽 결론의 **신뢰 폭**을 제한한다.

- `outlierCellByResistance`는 유지된 이벤트의 앞 1/5 vs 뒤 1/5 중앙값 차이다. 캡이 그 앞·뒤를 보존하도록 설계됐으므로, “최신만 버려서 셀이 뒤집힌다”는 옛 버그는 아니다.
- 그래도 매칭 통과는 **603 / 4,000**이고, qualifying 전체 579,026건의 약 0.1%다. Cell 1 지목은 이 샘플 위에서만 성립한다. 캡을 올리면 셀이 다시 바뀔 여지는 남아 있다 — 측정 없이 올리지 말라는 경계를 지켰으므로, 그 여지는 열린 채로 둔다.
- Vdev-Cell 8(744,400건)은 저항 이벤트 캡과 무관하다. 파생 이상 전량 집계다.
- B-F4 knee 불가는 캡+`binMatch`가 겹친 결과로 보는 것이 맞다. 603건의 daily 시계열이 `detectKnee` 하한에 못 미친다. stride80의 2018-11-24 knee는 원본에서 **재현되지 않았다.** 캡을 올리면 knee가 나올 수는 있다. 이번 런에서는 확인하지 않았다.

**캡이 Vdev 쪽 Cell 8을 만들거나 Cell 5를 지운 것은 아니다.** Cell 5 소멸은 다운샘플(연속 행 ΔI 파괴) 쪽 설명이 더 직접적이다. 캡이 가리는 것은 “원본에서 저항이 가리키는 셀이 Cell 1인지, 더 많은 이벤트를 넣으면 다른지”이다.

---

## T2 — 공개 결과 대조

독립 분석(스트리밍 → detect-anomaly → hypotheses → draft-report)이 **끝난 뒤**에 §13 발췌를 `#publishedExcerpt`에 붙여 `runPublishedComparison()`을 실행했다. 순서를 지켰다.

발췌 원문 (UI에 넣은 그대로):

```
논문이 보고한 값 (독립 분석 후 validation reference로만 사용한다):
Equivalent Full Cycles: 약 1,446.
Max age: 약 1,352 days.
Cell 8 resistance가 다른 cell보다 높음.
약 3년 이후 resistance knee.
Cell 8 fault probability는 약 500일 이후 증가.
약 800일 직전 0.5 초과.
```

`findingsFrozen: true`. `state.report.independentFindings`와 `state.reportEdits.independentFindings`는 대조 전후 바이트 단위로 동일했다. 대조 단계는 독립 findings를 덮어쓰지 않는다. 그 보장이 이번 런에서도 유지됐다.

독립 findings 3건 (동결, 대조 HTML Independent Findings 절과 동일):

1. 휴지(I≈0)에서 Cell 8 Vdev가 −0.031 V(2019-05-21)→−0.038 V(2021-11-28)→−0.050 V(2022-01-10), robust z 3.22→7.60→10.00. 전류 비례 IR로 설명되지 않는 음의 오프셋.
2. 파생 이상 빈도가 2021-03~2021-12에 29,633→295,934건/2개월로 급증 (초기 버킷의 약 30~50배).
3. 2018-10-10 충전 클러스터는 Cell 8+인접 Cell 6·7, 2021년 부하 이벤트는 Cell 8 단독. 국부화가 변한다.

대조표 요약 (`agree` / `rawSufficient`):

| 항목 | agree | RAW |
|---|---|---|
| 이상 셀 (휴지 Vdev vs 논문 저항) | partial | yes |
| 2021년 가속 vs 논문 ~3년 knee 시점 | partial | yes |
| B-F4 knee 독립 탐지 | unknown | no |
| B-F5 GP fault probability (500일/800일) | unknown | no |
| 국부화 (초기 다중 셀 → 후기 Cell 8) | partial | yes |
| B-F1 저항 분리 (Cell 1) vs 논문 Cell 8 저항 | partial | yes |
| B-F3 전압 분산 | partial | yes |
| Equivalent Full Cycles ≈ 1,446 | unknown | yes (미산출, 차용하지 않음) |
| Max age ≈ 1,352 days | **yes** (데이터 1,353일, ±1일) | yes |
| B-F6 balancing/온도 | unknown | no |

수치 일치로 단정할 수 있는 것은 **max age ≈ 1,352일**뿐이다. 논문의 Cell 8 저항·3년 knee·GP 확률은 지표 정의가 다르거나 (B-F4/B-F5) 원본에서 독립 탐지되지 않아 partial/unknown이다.

대조 모델이 B-F1 Cell 1 vs 논문 Cell 8을 “0-기반 vs 1-기반 인덱싱 차이일 수 있다”고 적었다. **그건 대조 모델의 추측이지 검증된 사실이 아니다.** 앱의 Vdev와 이벤트 저항은 둘 다 `Cell ${i+1}` (1-기반)이다. Cell 1과 Cell 8은 같은 셀의 라벨 오류가 아니라 서로 다른 셀이다. 프롬프트가 “다른 셀을 가리키면 오류로 기록하지 말고 지표 정의 차이를 적어라”고 해서, 모델이 그 지시를 저항-셀 불일치에까지 확장한 것이다. 독립 분석 쪽 숫자는 그대로 Cell 1 / Cell 8 `conflict`다.

---

## 권고 — `case_b_report.html` 재발행

원본 해상도 결과는 현재 공개본(`Report/case_b_report.html`, stride80)과 **유의미하게 다르다.**

- 저항 지목 셀: Cell 5 → Cell 1
- B-F4 knee: 2018-11-24 → 탐지 불가
- 파생 이상: 9,366 → 751,686
- 상충 상대: Cell 8 vs Cell 5 → Cell 8 vs Cell 1

사람이 재발행 여부를 판단할 것. 이 세션은 `Report/case_b_report.html`을 덮어쓰지 않았다. 원본 해상도 독립 보고서는 `tmp/fullres/case_b_report_fullres.html` (gitignored)과, 대조표가 붙은 `Report/case_b_report_compared.html`에 있다.

---

## 벽시계 (이 머신, 2026-08-30 UTC)

| 단계 | 시각 | 소요 |
|---|---|---|
| ZIP 업로드·카탈로그 (28 entries) | 11:54:29 → 11:54:47 | 18s |
| data_sys_6.csv 스트리밍 | 11:54:47 → 12:08:47 | **14.0분** |
| detect-anomaly (figures는 클릭 직후 산출) | 12:08:48 → 12:17:29 | 8.7분 |
| generate-hypotheses | 12:17:33 → 12:24:58 | 7.4분 |
| draft-report | 12:25:01 → 12:33:05 | 8.1분 |
| published comparison | 12:33:09 → 12:40:26 | 7.3분 |
| 합 | | **46.0분** (Playwright 측정) |

가설 3개 (모두 Cell 8 경로 후보). 1번을 선택하고 심각도 상. 사유는 실측 상충(Vdev Cell 8 / 저항 Cell 1)을 그대로 적었다.

로컬 `.env`의 `CLAUDE_CLI_TIMEOUT_MS`만 5,400,000으로 올렸다. 코드 기본값 1,800,000은 그대로. `.env`는 gitignored.

429 / spend limit는 이번 런에서 없었다.

---

## 스크린샷

| 파일 | 내용 |
|---|---|
| `Report/fullres-catalog.png` | ZIP 카탈로그, `field_data/data_sys_6.csv` 대기 |
| `Report/fullres-stream-done.png` | 19,248,213행 · 저항 이벤트 575,026건 생략 |
| `Report/fullres-step2.png` | 교차 지목 배너 Cell 8 vs Cell 1, B-F1~B-F6 |
| `Report/fullres-attribution.png` | step2와 동일 (배너가 있는 프레임) |
| `Report/fullres-comparison.png` | 공개 결과 대조표 |

초기 `fullres-attribution.png`는 figures 산출 직후·`render()` 전 로딩 화면을 찍었다. 배너는 detect-anomaly가 끝난 뒤에야 그려지므로 step2 프레임으로 교체했다.

---

## 하지 않은 것 (계획 그대로)

- GP/BattGP 구현, B-F5를 Vdev로 추정·백필
- `MAX_RESISTANCE_EVENTS` / `LFP_DI_THRESHOLD` 조정
- 논문 수치를 threshold·기대값으로 코드에 심기
- 프롬프트 예산 상수 재조정, Web Worker
- `Report/case_b_report.html` 덮어쓰기
- `orca computer` 데스크톱 자동화
- 동시 두 파이프라인 실행

## 못 한 것

없음. T1 비교표와 T2 대조 HTML이 모두 나왔다. 열린 질문은 계획 범위 밖이다: 캡을 올리면 B-F1 셀과 B-F4 knee가 다시 바뀌는지. 그건 측정 과제로 남긴다.
