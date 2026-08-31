# 지속 타깃 편차 탐지 + Case A 재발행 findings (2026-08-31)

짝 문서: `Report/sustained-deviation-plan.md`.
브랜치 `feat/sustained-deviation`. 이 워크트리만 사용.
`C:\Users\windo\ESSanalyzer`와 `main`은 건드리지 않았다.

`npm run test:unit` **157 passed / 1 skipped / 0 failed**, `npm run build` 통과.
라이브 파이프라인: `RUN_CASE_A=1 PW_PORT=5186 npx playwright test tests/e2e/regenerate-case-a.spec.js --project=desktop-chromium` — **1 passed, 38.3분**.
하니스: `tests/e2e/regenerate-case-a.spec.js`. 실데이터 검증: `scripts/verify-sustained-deviation.mjs` (`tmp/p3/sustained-verification.json`).

독립 보고서: `Report/case_a_report.html` (616,809 bytes).
대조 HTML: `Report/case_a_report_compared.html` (627,682 bytes).
파이프라인 스냅샷: `Report/case_a_pipeline.json`.
원본 덤프: `tmp/case-a-regen/`, `tmp/p3/` (gitignore).

프롬프트 예산 상수, Web Worker, GP 관련 코드는 건드리지 않았다.
`parseTimestampMs`의 naive `Date.parse`는 그대로다.
`Report/case_b_*`는 수정하지 않았다.
코드·테스트 픽스처에 −55 MW, 12:15, 12:05를 넣지 않았다.

---

## 1. 임계 근거 — 분포에서, 공개 사건이 아니라

설계 원리: **타깃에서 일정 크기 이상 벗어난 상태가 일정 시간 이상 지속되면 그 자체로 보고 가치가 있다.**
기존 DEVIATION_MW 규칙은 롤링 ~60초 `|dev|` 중앙값 대비 robust z라서, 지속 고원은 자기 베이스라인을 올려 z가 3에 못 미친다. 세 번째 규칙을 **추가**했고 기존 두 규칙은 바꾸지 않았다.

근거 분포는 PR #12 `Report/dispatch-target-deviation-findings.md` 1.3절, 사건일 WDBESS1 `|DEVIATION_MW|`:

| | `|DEVIATION_MW|` |
|---|---|
| median | 3.22 MW |
| p75 | **11.76 MW** |
| p95 | 50.34 MW |
| p99 | 86.83 MW |

고른 값:

| 파라미터 | 값 | 이유 |
|---|---|---|
| 크기 | **12 MW** | 측정된 p75 11.76 MW를 반올림. 중앙값 3.22 MW(전형적 추종 오차)보다 위이고, 상위 사분위가 연속으로 유지되면 "정상 추종"이 아니다. p95(50 MW)는 극단만 남기므로 쓰지 않았다. |
| 지속 | **75샘플 = 5분** | 데이터는 4초 간격. AEMO 디스패치 인터벌이 5분이라는 **일반적 사실** — 한 지령 주기 안에 스스로 돌아오는 잔차는 지속이 아니고, 한 인터벌을 채우면 지속이다. |

코드 상수: `AEMO_SUSTAINED_DEV_ABS_MW = 12`, `AEMO_SUSTAINED_DEV_SAMPLES = 75`.
공개 사건의 MW·시각에 맞추어 역산하지 않았다.

고정 크기 상태: 버킷당 `runCount` 하나 (`getDerivedState(..., 'aemoSustainedDeviation')`). 행을 쌓지 않는다.

`reasonCode`:
- `MEASURED_MW statistical/ramp anomaly`
- `DEVIATION_MW target deviation` (onset, 기존)
- `DEVIATION_MW sustained deviation` (신규)
- 겹치면 ` + `로 이음 (PR #12와 동일)

---

## 2. 품질 플래그

PR #12: `MW_QUALITY_FLAG = 0`인 55행은 `DEVIATION_MW`가 강제로 0이다. `|dev|=0`으로 보면 지속 런이 리셋된다.

처리: **flag=0 행은 런을 멈추되 리셋하지 않는다.** 카운터를 늘리지도 않는다 (불량 잔차로 지속 시간을 채우지 않음). 그 행에서는 지속 규칙을 발화하지 않는다 (잔차가 실측이 아님). flag=2(대체/추정치)는 잔차를 그대로 쓴다.

실데이터: 55행 전부가 어떤 런이 진행 중일 때 들어왔다 (`quality0DuringRun=55`). 13:15–13:25 발화 창과 13:48 창 **사이**라서 발화 창을 쪼개지는 않았다. 강제 0으로 런을 끊지 않았다.

---

## 3. 유닛 테스트

`tests/unit/formats.test.js`:

- 20샘플 스파이크(20 MW)는 안 걸림. 80샘플 고원은 75번째에 걸림.
- 40 정상 + 10개 flag=0 강제 0 + 40 정상: 런이 이어져 75에 발화. 불량 행 자체는 발화하지 않고 `runCount`는 40으로 유지.
- 40 + 진짜 on-target(quality=1, `|dev|=0`) + 40: 리셋, 발화 없음.
- 기존 onset / MEASURED_MW 회귀 테스트 유지. 짧은 잔차는 여전히 `DEVIATION_MW target deviation`만.

픽스처 MW는 20·30. 공개 사건 수치·시각 없음.

---

## 4. 실데이터 — 지속 규칙이 걸린 구간 전부

입력: `_20250820_` NEXT_DAY CSV (거래일 2025-08-19), WDBESS1 10,800행.
라이브 `AEMO_MMS_FORMAT.computeDerivedAlarm`. 시각은 CSV `MEASUREMENT_DATETIME` 벽시계 문자열.

**9개 창, 행 발화 1,256건.**

| # | 시작 | 끝 | 행 | min DEVIATION_MW | max | max \|dev\| | max runCount |
|---|---|---|---|---|---|---|---|
| 1 | 2025/08/19 06:05:44 | 2025/08/19 06:35:36 | 449 | 15.15 | 124.20 | 124.20 | 523 |
| 2 | 2025/08/19 06:45:16 | 2025/08/19 06:45:36 | 6 | −12.47 | 20.71 | 20.71 | 80 |
| 3 | 2025/08/19 07:05:48 | 2025/08/19 07:20:32 | 222 | 15.01 | 84.45 | 84.45 | 296 |
| 4 | 2025/08/19 11:53:40 | 2025/08/19 12:15:16 | 325 | −59.89 | −12.11 | 59.89 | 399 |
| 5 | 2025/08/19 12:38:04 | 2025/08/19 12:40:28 | 37 | −65.89 | −44.00 | 65.89 | 111 |
| 6 | 2025/08/19 13:15:32 | 2025/08/19 13:25:56 | 157 | −58.44 | −15.25 | 58.44 | 231 |
| 7 | 2025/08/19 13:48:52 | 2025/08/19 13:51:16 | 37 | −31.09 | −13.18 | 31.09 | 111 |
| 8 | 2025/08/19 13:58:52 | 2025/08/19 14:00:08 | 20 | −22.21 | −12.47 | 22.21 | 94 |
| 9 | 2025/08/19 15:20:20 | 2025/08/19 15:20:28 | 3 | −22.11 | −20.48 | 22.11 | 77 |

창 4는 오후에 음수 잔차가 12 MW 이상으로 5분 이상 유지된 구간이다. 12:05 고원이 이 목록에 들어 있는지는 **성공 기준이 아니다** (9절 사후 참고).

엔진 `reasonCounts` (WDBESS1, 사건일):

| reasonCode | 건 |
|---|---|
| `MEASURED_MW statistical/ramp anomaly` | 297 |
| `MEASURED_MW statistical/ramp anomaly + DEVIATION_MW target deviation` | 70 |
| `DEVIATION_MW target deviation` | 60 |
| `MEASURED_MW statistical/ramp anomaly + DEVIATION_MW sustained deviation` | 148 |
| `DEVIATION_MW sustained deviation` | 1108 |
| 합계 | 1683 |

---

## 5. 과탐지 평가

**창 9개는 과탐지가 아니다.** 12시간 파일에서 지속 오프셋 사건으로 보면 하루 한 자릿수다. 수백·수천 창이 아니다.

행 발화 1,256은 많아 보인다. 기존 두 규칙과 같이 **조건을 만족하는 매 행**에 켜기 때문이다. 창 1이 449행(약 30분), 창 4가 325행이다. 이벤트 수가 아니라 고원의 길이다.

짧은 꼬리(창 2: 6행, 창 9: 3행)는 75샘플을 갓 넘긴 뒤 `|dev|`가 12 아래로 떨어진 경우다. 짧은 스파이크를 잡은 것이 아니다 (스파이크는 유닛 테스트에서 안 걸린다).

임계를 숫자 맞추려고 올리지 않았다.

---

## 6. 기존 두 규칙은 그대로다

PR #12 사건일 WDBESS1:

| | PR #12 | 이번 |
|---|---|---|
| MEASURED_MW가 포함된 행 | 445+70 = **515** | 297+70+148 = **515** |
| onset (`target deviation`)이 포함된 행 | 70+60 = **130** | 70+60 = **130** |
| onset 전용 | 60 | 60 |
| 지속 전용 | — | 1108 |
| MEASURED + 지속 | — | 148 (이전 MEASURED 전용 445 중 148) |

onset 130건과 MEASURED 515건은 그대로다. 지속이 겹치는 행의 `reasonCode`만 ` + `로 늘어났다. 대체·약화 없음.

---

## 7. T2 — Case A 재발행

입력은 PR #11과 동일: 중첩 ZIP, 발행일 20250818/19/20 (거래일 17/18/19).
엔티티 필터 `BESS` 자동 제안, 일당 64,800행, 6개 그룹.

### 7.1 P4 다중 소스 시계열 병합

A-F1 시리즈 **3일을 덮는다.**

| | 이전 (last-source-wins) | 이번 (`mergeFrozenSeries`) |
|---|---|---|
| tMin | 2025-08-18T19:00:04Z (사건일 파일만) | **2025-08-16T19:00:04Z** (20250818 파일 시작) |
| tMax | 2025-08-19T07:00:00Z | **2025-08-19T06:59:56Z** (20250820 파일 끝) |
| 포인트 | (사건일 빈) | 1,800 (상한 2,000, pairwise 재빈) |

파일 사이 UTC 07:00–19:00 (AEST 17:00–05:00) 갭에 점을 넣지 않았다. 차트에 보이는 긴 연결선은 빈 구간 보간이 아니라 인접 빈을 잇는 렌더다.

부작용: A-F1 최대 ΔP 앵커가 사건일이 아니라 **2025-08-17T01:26:12Z** (ΔP −250.6 MW)로 옮겨 갔다. 3일 병합 후 가장 큰 빈 변화가 거래일 17일 쪽에 있기 때문이다. 이전 보고서의 −241 MW @ 2025-08-18T23:04:20Z는 last-source-wins가 사건일만 그린 결과다.

A-F3 p95는 3206 → **1538.5 MW/h**로 줄었다. 3일 분포로 퍼센타일을 다시 매긴 것이다.

### 7.2 A-F6

**available.** 클레임: `WDBESS1 DEVIATION_MW 최대 |편차| -119.5 MW — SCHEDULED_MW 대비 실측 잔차`.
시리즈 구간은 A-F1과 같은 3일. 앵커 시각 2025-08-19T04:12:36Z (빈 다운샘플; 원본 4초 min은 PR #12의 −124.83 MW).
이전 보고서는 "Dispatch Target 컬럼이 없어" unavailable이었다. 값을 채워 넣은 것이 아니라 `DEVIATION_MW` 시리즈가 실제로 있어서 그린 것이다.

### 7.3 파생 사유에 새 규칙

사건일 WDBESS1 최다 사유가 `DEVIATION_MW sustained deviation` 1,108건.
파일별 전체 파생 이상 (6 엔티티): 1,240 → 1,465 → 2,877 (이전 879 / 901 / 915). 증분은 지속 규칙이다.

### 7.4 사람 검토

가설 3개. **이전 결론(다수 설비 공통 스케줄 대칭 확장)에 맞추지 않았다.**

| | 가설 | 채택 |
|---|---|---|
| H1 | 계통 주파수에 대한 다수 BESS 동조 (Grid, Low) | 아니오. A-F4 `mode=local`, score=0. |
| H2 | SCHEDULED_MW 엔벌로프에 반영되지 않은 FCAS/AGC 추종 또는 재디스패치 (Dispatch, Medium) | **예.** A-F6 available, 지속 편차가 사건일 최다 사유, 품질 플래그 1. 주장 한도: 지속 이탈은 입증, FCAS vs 추종 실패는 Dispatch Target 없이 미확정. |
| H3 | 스케줄/리포트 파이프라인 아티팩트 (Telemetry, Low) | 아니오. 핵심 표본 quality=1, MEASURED_MW 램프가 실측. |

심각도 **중**. 공개 대조는 독립 보고서 저장 **이후**. 발췌는 저장소가 정리해 둔 AEMO 두 줄.

### 7.5 공개 대조 (발췌만, 독립 저장 후)

방향은 부분 일치. A-F6 −119.5 MW(3일 최대 \|잔차\|)와 공개 −55 MW는 정의·창이 달라 크기 불일치를 오류로 적지 않았다. A-F4 local-fault 문구는 공개 자료·Finding 2와 상충한다고 대조표가 적었고, score=0이라 약한 신호로 처리했다. 독립 findings 배열은 대조 전후 동일 (`findingsFrozen`).

벽시계: catalog 22s, stream 3×25s, detect-anomaly 630s, hypotheses 439s, review wait 288s, draft 416s, compare 409s. Playwright **38.3분**. 429 없음.

---

## 8. 이전 Case A 보고서와 무엇이 달라졌는가

| | 이전 (PR #11 재실행, A-F6 unavailable) | 이번 |
|---|---|---|
| 확정 가설 | 다수 설비 공통 스케줄(입찰밴드) 대칭 확장 | **SCHEDULED_MW 엔벌로프에 미반영된 FCAS/AGC 추종 또는 재디스패치** |
| A-F1 구간 | 사건일 파일만 | **3일** 2025-08-16T19:00Z .. 2025-08-19T07:00Z |
| A-F1 앵커 | ΔP −241 MW @ 2025-08-18T23:04:20Z | ΔP **−250.6 MW** @ **2025-08-17T01:26:12Z** |
| A-F6 | unavailable (Dispatch Target 컬럼 없음) | **available**, −119.5 MW |
| 지배 파생 사유 | MEASURED_MW statistical/ramp | 사건일 **DEVIATION_MW sustained deviation** |
| 헤드라인 | 스케줄 대칭 전환 + Dispatch Target 부재 | 지속 이탈 + FCAS vs 추종 실패 미확정 |

다른 결과는 의도된 것이다. 3일 병합과 지속 규칙이 신호를 바꿨고, 사람 검토는 이번 가설 중 근거가 가장 강한 것을 골랐다.

---

## 9. 사후 참고 — AEMO 공개 수치 (성공 기준 아님)

설계·임계·픽스처에 쓰지 않았다. 측정 후에만 적는다.

AEMO Market Notice는 12:15–12:20, −55 MW. 창 4 (11:53:40–12:15:16, min −59.89 MW)는 그 오후 음수 고원을 포함한다. FPP `DEVIATION_MW`가 공지의 물리량인지는 여전히 확정하지 못했다 (`DISPATCH_UNIT_CONFORMANCE`/`TOTALCLEARED`일 수 있고 이 아카이브에 없다). 시각도 공지 5분과 10분 넘게 어긋날 여지가 있다. **규칙을 그 창에 맞춘 것이 아니다.**

---

## 10. 못 한 것 / 남은 것

- `DISPATCH_UNIT_CONFORMANCE` / `DISPATCHLOAD.TOTALCLEARED`와 FPP `DEVIATION_MW`의 동일 객체 여부는 아카이브에 테이블이 없어 닫지 못했다.
- `parseTimestampMs` naive `Date.parse`는 범위 밖이라 그대로다. CSV 벽시계 문자열로 창을 나열했다.
- A-F1 앵커가 3일 병합 때문에 거래일 17일로 이동한 것은 P4의 결과다. 사건일 창을 코드에 넣지 않은 것과 같다.
- 지속 규칙은 매 행 발화라 행 카운트가 크다. 창 단위 집계를 UI에 넣지는 않았다.
- Case B는 손대지 않았다.

---

## 11. 한 줄 요약

지속 편차 규칙(12 MW × 5분)을 분포와 디스패치 인터벌에서 정당화해 기존 두 규칙 옆에 넣었고, 사건일 WDBESS1에서 9개 창(과탐지 아님)이 걸렸다. Case A를 재발행하니 A-F1이 3일을 덮고 A-F6가 available이며, 채택 가설은 이전의 공통 스케줄 대칭이 아니라 스케줄 엔벌로프에 안 담긴 지속 이탈이다.
