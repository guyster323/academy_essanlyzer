# Dispatch Target 편차 분석 (P1–P4) findings (2026-08-31)

짝 문서: `Report/dispatch-target-deviation-plan.md`.
브랜치 `feat/dispatch-target-deviation`. 이 워크트리만 사용.
`C:\Users\windo\ESSanalyzer`와 `main`은 건드리지 않았다.

`npm run test:unit` **153 passed / 1 skipped / 0 failed**, `npm run build` 통과.
라이브 AI 단계는 돌리지 않았다. 파생 이상·A-F6·시계열 병합은 클라이언트 계산이라
`_20250820_` CSV를 스트리밍하는 것으로 검증했다.

`Report/case_a_report.html`은 재발행하지 않았다. A-F6가 available로 바뀌는 결과는
유의미하므로 사람이 재발행할 것을 권고한다 (PR #9–#11과 같은 규율).
`Report/case_b_*`는 수정하지 않았다. 프롬프트 예산 상수, Web Worker, GP 관련 코드는
건드리지 않았다. AEMO 수치(−55 MW, 12:15, 19 Aug)를 threshold·기대값·테스트 고정값으로
코드에 넣지 않았다.

원본 덤프: `tmp/p3/` (gitignore). 측정 스크립트:
`scripts/measure-deviation-columns.mjs`, `scripts/verify-deviation-detection.mjs`.

---

## 1. P3 — `MEASURED_MW − SCHEDULED_MW` vs `DEVIATION_MW`

입력: `Log_sample/case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip` → 내부
`PUBLIC_NEXT_DAY_FPPMW_20250820_0000000477089848.zip` →
`PUBLIC_NEXT_DAY_FPPMW_20250820_0000000477089848.CSV` (4,784,400 data rows).
WDBESS1만 필터: **10,800행** (12시간 × 4초). 결측 없음
(`MEASURED_MW` / `SCHEDULED_MW` / `DEVIATION_MW` 모두 10,800/10,800 finite).

시간 범위 (CSV `MEASUREMENT_DATETIME`을 `Date.parse`한 값, 로컬 TZ 의존 —
아래 사건 창 대조는 CSV AEST 벽시계 문자열로 했다):
`2025-08-18T19:00:04Z` .. `2025-08-19T07:00:00Z` (AEST 08-19 05:00–17:00).

### 1.1 항등식

`| (MEASURED_MW − SCHEDULED_MW) − DEVIATION_MW |`:

| 잔차 구간 | 행 수 |
|---|---|
| 정확 0 | 643 |
| (0, 1e-6] | 2,050 |
| (1e-6, 1e-4] | 8,052 |
| (1e-4, 0.1] | 0 |
| > 0.1 MW | **55** |

- 10,745 / 10,800행(99.5%)은 1e-4 MW 이내. 중앙 잔차 **2.5e-6 MW**, p99 **5e-6 MW**.
  `DEVIATION_MW`의 소수점(5자리)과 `MEASURED_MW`(8자리) 반올림으로 설명된다.
- **55행은 잔차 최대 37.90 MW.** 전부 `MW_QUALITY_FLAG = 0` (Bad Quality),
  `DEVIATION_MW = 0`, `MEASURED_MW`가 −37.90으로 고정, `SCHEDULED_MW`만 변함.
  시각: AEST 13:27:20–13:30:56. FPP가 품질 불량 SCADA에서 unit deviation을 0으로
  두는 것으로 관측된다.

**측정 결론**: 품질 정상 행에서 `DEVIATION_MW`는 이미 `MEASURED_MW − SCHEDULED_MW`이다.
별도 계산은 필요 없다. 품질 불량 행은 이 항등식이 성립하지 않으며, 그 행의
`DEVIATION_MW`는 0이다.

### 1.2 `SCHEDULED_MW`는 AEMO Dispatch Target인가

공개 문서로 **같은 객체라고 확정할 수 없다.** 관계는 다음까지다.

- EMMS Data Model v5.4 `FPP_UNIT_MW`:
  - `SCHEDULED_MW` = "reference trajectory value from FPP calculation process"
  - `DEVIATION_MW` = "Unit Deviation (output of the FPP calculation process)"
  - `MEASURED_MW` = 4초 SCADA
- FPP Factor Calculation Guide / Frequency Contribution Factors Procedure:
  스케줄드 유닛의 Reference Trajectory는 **직전·현재 dispatch target 사이의 직선**
  (`Ref_t = DT_{ti-1} + (DT_{ti} − DT_{ti-1}) × t/75`). Deviation은 `Gen_t − Ref_t`.
- SO_OP_3705에서 Dispatch Target은 "dispatch instruction의 인터벌 **끝**에 도달할
  유효전력". MMS `DISPATCHLOAD.TOTALCLEARED` / `DISPATCH_UNIT_CONFORMANCE.TOTALCLEARED`가
  그 이름으로 적혀 있다.

즉 `SCHEDULED_MW`는 dispatch target에서 **파생된 4초 궤적**이지, 인터벌-끝
Dispatch Target 컬럼 자체가 아니다. 코드와 A-F6 문구는 "Dispatch Target"이라고
단정하지 않고 관측된 컬럼명을 쓴다.

### 1.3 사건일 WDBESS1 `DEVIATION_MW` 분포 (임계 설계 근거)

| | `DEVIATION_MW` | `|DEVIATION_MW|` |
|---|---|---|
| min | −124.83147 | 0 |
| max | +124.19962 | 124.83147 |
| median | −0.16 | **3.22** |
| MAD | 3.23 | 2.85 |
| p75 | 3.70 | **11.76** |
| p95 | 37.65 | **50.34** |
| p99 | 82.20 | 86.83 |

`SCHEDULED_MW` median은 0, MAD는 0 (많은 구간이 0 궤적). `|DEVIATION_MW| ≥ 50`인 행은
553건(5.1%). 하루 최댓값은 AEST 13:12:48, `MEASURED_MW=−158.35`,
`SCHEDULED_MW=−33.52`, `DEVIATION_MW=−124.83`.

이 분포로 규칙을 정했다. **−55 MW를 넣지 않았다.**

- 이 신호의 "정상"은 운전점이 아니라 **온타깃(0)**.
- 절대 하한 5 MW: MEASURED_MW 규칙과 같은 물질적 MW 바닥. 이날 `|dev|` 중앙값 3.2 MW보다 위.
- robust z ≥ 3: 롤링 15샘플(약 60초)의 `|DEVIATION_MW|` 중앙값을 전형적인 추종 오차로 사용.
- 기존 MEASURED_MW 통계/램프 규칙은 그대로 두고 **추가**했다.

---

## 2. P1 검증 — 12:15–12:20 AEST에서 −55 MW 규모가 탐지되는가

미리 정해 둔 질문: **2025-08-19 12:15–12:20 AEST 창에서 WDBESS1의 −55 MW 규모
타깃 편차가 탐지되는가?**

**답: 아니오.** 임계를 맞추지 않았다.

실데이터: 추출 CSV 10,800행을 라이브 `AEMO_MMS_FORMAT` 어댑터로 스트리밍
(`scripts/verify-deviation-detection.mjs`).

### 2.1 지정 창의 실제 값

CSV AEST 벽시계 `MEASUREMENT_DATETIME` 12:15:00–12:20:00 (76행, 품질 전부 1).

| | 값 (MW) |
|---|---|
| `DEVIATION_MW` min | **−16.17** |
| `DEVIATION_MW` max | **+4.76** |
| 12:15:00 | MEASURED −15.50, SCHEDULED **0**, DEV −15.50 |
| 12:20:00 | MEASURED −10.00, SCHEDULED −14.76, DEV **+4.76** |

이 창의 `DEVIATION_MW`는 −55 MW가 아니다. 파생 규칙 발화도 **0건**
(편차 규칙 0, MEASURED_MW 규칙 0).

12:15 창이 커버리지 밖이 아니다. 파일은 AEST 05:00–17:00을 담고, 12:15는 그 안이다.
못 잡은 이유는 데이터가 없어서가 아니라 **그 5분에 FPP `DEVIATION_MW`가 −55가 아니기 때문**이다.

### 2.2 인접 시각 — 같은 날, 같은 컬럼의 −55 규모

AEST **12:05–12:09**, `SCHEDULED_MW = 0`:

| 분 | `DEVIATION_MW` min | max |
|---|---|---|
| 12:05 | −56.51 | −51.48 |
| 12:06 | −57.63 | −54.76 |
| 12:07 | −59.89 | −53.07 |
| 12:08 | −58.13 | −52.88 |
| 12:09 | −55.97 | −50.18 |

12:05:00 예: MEASURED −54.83, SCHEDULED 0, DEV −54.83. 규모는 AEMO가 말한 −55 MW와
같다. **시각은 10분 앞**이다. 12:10 이후 `|dev|`는 줄어 12:15에는 −16이다.

이 12:05 고원에서도 편차 규칙은 **한 건도 안 걸렸다.** 롤링 `|dev|` 중앙값이 이미
~50 MW라 robust z가 3에 못 미친다. 지속된 오프셋은 "최근 추종 오차 대비 이상"이 아니다.
AEMO non-conformance는 인터벌 허용대역 대비 `|actual − target|`이지, 최근 잔차 대비
z가 아니다.

같은 12시대에 편차 규칙이 **실제로 걸린** 구간은 잔차가 갑자기 커지는 onset이다.
예: 12:25 (5건), 12:32 (4건), 12:50 (8건). 지속 고원이 아니다.

### 2.3 하루 전체 파생 이상 (규칙이 죽지 않았다는 증거)

| reasonCode | 건 |
|---|---|
| `MEASURED_MW statistical/ramp anomaly` | 445 |
| `MEASURED_MW statistical/ramp anomaly + DEVIATION_MW target deviation` | 70 |
| `DEVIATION_MW target deviation` | 60 |
| 합계 | 575 |

MEASURED_MW 전용 445건이 남아 기존 규칙을 대체·약화하지 않았다.
편차 전용 60건은 출력이 유지되고 스케줄만 벌어진 행이다. reasonCode로 어느 규칙인지
구분된다.

A-F1 `eventDeltaMw` = **−240.9 MW** (기존 MEASURED_MW 급변 앵커, 종전 −241과 동일 규모).

### 2.4 A-F6

WDBESS1 시리즈에 `deviationMw`가 들어가 **A-F6 available**.
빈 기준 최대 |편차| **−121.2 MW** (원본 4초 min −124.83, 2,000빈 다운샘플).
앵커는 12:15가 아니라 하루 최대 |DEVIATION_MW| — 공개 시각을 코드에 넣지 않은 결과다.

### 2.5 W1에 대한 정직한 평가

- **구조적으로 안 읽던 신호는 이제 읽는다.** A-F6 하드코딩 거짓말은 없어졌다.
- **지정 창의 −55 MW FPP 편차는 탐지되지 않았다.** 그 창에 그 값이 없다.
- FPP `DEVIATION_MW`의 −55 규모는 12:05–12:09에 있고, 지속 고원이라 현재 규칙(롤링 z)에도
  안 걸린다. 임계를 그 고원에 맞춰 낮추지 않았다.
- AEMO Market Notice의 12:15–12:20 −55 MW가 FPP `DEVIATION_MW`와 같은 물리량인지는
  **확정하지 못했다.** `DISPATCH_UNIT_CONFORMANCE`(TOTALCLEARED 대비 인터벌 끝
  ACTUALMW)일 수 있고, 시계 표기가 다를 수 있다. 공개 문서만으로는 닫히지 않는다.

---

## 3. P2 — A-F6 문구

| 상태 | 사유 |
|---|---|
| `deviationMw` 신호가 시리즈에 없음 (컬럼 없는 소스) | `이 소스에 DEVIATION_MW 컬럼이 없어 A-F6는 그릴 수 없습니다 — Unknown으로 남깁니다` |
| 컬럼은 있으나 finite 점이 2개 미만 | `DEVIATION_MW 컬럼은 있으나 시계열 값이 부족해 A-F6는 그릴 수 없습니다` |
| 점 ≥ 2 | available, `DEVIATION_MW` / `SCHEDULED_MW` 시계열 |

"Dispatch Target 컬럼이 없어"를 항상 말하지 않는다. 컬럼이 진짜 없는 소스에서는
unavailable이 맞고, 그때만 컬럼 부재를 이유로 쓴다.

`seriesSignalsFor(columns)`가 `SCHEDULED_MW` / `DEVIATION_MW`가 헤더에 있을 때만
시리즈에 넣는다. 다른 AEMO 파일에 컬럼이 없으면 안전하게 빠진다.

---

## 4. P4 — 다중 소스 시계열 병합

**전**: `collectSeriesContext`가 `seriesByEntity[id] = frozen` — 같은 엔티티를
나중 소스가 덮어씀. 3일 스트리밍해도 A-F1은 마지막 파일만 그림.

**후**: `mergeFrozenSeries`가 bins를 시간순으로 이어 붙이고, 같은 시각은 coalescing,
`MAX_SERIES_POINTS`를 넘으면 기존과 같은 pairwise 재빈닝. 빈 구간에 점을 삽입하지 않음.

유닛 테스트:
- 나중에 넣은 소스가 더 이른 시각이어도 결과는 시간순
- 갭 (t=1000과 t=1e6 사이)에 점이 생기지 않음
- 2 × 2000 포인트를 합쳐도 길이 ≤ 2000, 스파이크 max 보존
- `collectSeriesContext`가 두 블록을 시간순으로 합침

3일 중첩 ZIP을 다시 스트리밍하지는 않았다 (일당 ~522 MB, 라이브 AI 없음).
그림 축이 여러 날을 덮는지는 보고서 재발행 때 확인하면 된다.

---

## 5. 검증 명령

```
npm run test:unit    # 153 passed, 1 skipped
npm run build        # vite production, 41 modules
node scripts/measure-deviation-columns.mjs
node scripts/verify-deviation-detection.mjs
```

P1 창 대조는 CSV AEST 문자열로 했다. `parseTimestampMs` → `Date.parse`는 타임존
없는 AEMO 시각을 **로컬 TZ**로 읽는다. 이 이슈는 이번 범위에서 고치지 않았다
(기존 동작, 프롬프트/GP와 무관하지만 시계 해석에는 영향을 준다).

---

## 6. 못 한 것 / 권고

- **`Report/case_a_report.html` 재발행.** A-F6가 이제 available이고, 파생 사유에
  `DEVIATION_MW target deviation`이 생긴다. 사람이 3일 중첩 ZIP 파이프라인을
  다시 돌릴 것. 이번 작업은 스트리밍만으로 클라이언트 계산을 확인했다.
- AEMO 12:15–12:20 −55 MW를 `DISPATCH_UNIT_CONFORMANCE` / `DISPATCHLOAD.TOTALCLEARED`와
  같은 테이블에서 대조하지 않았다. 이 아카이브에 그 테이블이 없다.
- 지속 오프셋(12:05의 −55 고원)을 잡도록 임계를 바꾸지 않았다. 바꾸면 지정 창/공개
  수치에 맞추는 튜닝이 된다.
- `parseTimestampMs`의 naive `Date.parse`는 그대로다.

---

## 7. 한 줄 요약

`DEVIATION_MW`는 품질 정상 행에서 `MEASURED_MW − SCHEDULED_MW`이고 FPP reference
trajectory 잔차이지 Dispatch Target 그 자체가 아니다. 신호를 읽고 A-F6에 그리게 됐지만,
AEMO가 적은 12:15–12:20 −55 MW는 그 창의 `DEVIATION_MW`에 없고 (−16 ~ +5 MW),
10분 앞 12:05 고원(−55 규모)도 롤링 z 규칙에는 걸리지 않는다. 음수 결과는 측정된 것이다.
