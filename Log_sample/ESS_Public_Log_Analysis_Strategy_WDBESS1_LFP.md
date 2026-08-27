# ESS 공개 로그 2개 사례 독립 분석 전략
## Western Downs BESS + TU Darmstadt / MIT LFP Field Dataset

> **목적**  
> 본 문서는 Codex 또는 Claude가 공개 RAW Log를 직접 분석하여, 기존 보고서/논문의 결론을 단순 재현하지 않고 **독립적인 Fault Reconstruction → Hypothesis Test → FTA → Evidence-backed Root Cause Assessment → 한글 임원향 보고서**를 구현하기 위한 분석 전략서다.
>
> 공통 원칙: **RAW Data → Observable Fact → Event/Degradation Reconstruction → Fault Hypothesis → 반증 → FTA → Root Cause / Limitation → External Validation**
>
> 기존 AEMO 보고서 및 TU Darmstadt/MIT 논문은 **초기 결론의 근거가 아니라 마지막 교차검증 자료**로 사용한다.

---

# 1. 분석 대상 개요

| 구분 | Case A | Case B |
|---|---|---|
| 사례 | Western Downs BESS (`WDBESS1`) | TU Darmstadt / MIT 24 V LFP Field Dataset |
| 규모 | Grid-scale BESS | 24 V, 약 160 Ah, 8S LFP × 28 systems |
| 주 분석 레벨 | Grid / Market / Dispatch / Plant response | Cell / Pack / BMS telemetry / degradation |
| 주 데이터 | 4초급 계통/설비 출력 telemetry | 약 5초 중앙값의 cell voltage/current/temp/balancing |
| 핵심 질문 | Hardware fault인가, 외부 제어/Dispatch 문제인가? | 특정 Cell의 열화가 Pack 이상을 선행했는가? |
| 대표 Target | 2025-08-19 WDBESS1 | System 6 / Cell 8 중심 |
| 내부 BMS 데이터 | 없음 | 있음 |
| 핵심 한계 | Battery/PCS 내부 fault code 미공개 | 실제 반품 사유·정확한 fault type/time 미공개 |

두 사례를 같은 분석 알고리즘으로 처리하지 않는다. Case A는 **동시성·계통 공통요인·명령/응답 불일치**가 핵심이고, Case B는 **셀 간 상대 변화·내부저항 추정·weakest-link degradation**이 핵심이다.

---

# 2. 공통 구현 원칙

## 2.1 Evidence-first

모든 주요 결론은 아래 세 계층 중 하나로 명시한다.

- **Observed**: RAW Log에서 직접 관측
- **Derived**: 관측값으로 계산
- **Inferred**: 복수 근거를 이용한 Engineering inference

보고서에서 Inferred를 Observed처럼 표현하지 않는다.

## 2.2 Confirmation Bias 방지

분석 초기에 다음 자료의 결론을 읽지 않는다.

- AEMO incident root-cause conclusion
- TU Darmstadt/MIT 논문의 System별 해석

우선 RAW 분석을 완료한 뒤 별도 단계에서 비교한다.

## 2.3 반증 우선

각 Leading Hypothesis에 대해 반드시 다음을 실행한다.

> **이 가설이 틀렸다는 증거는 무엇인가?**

예:
- PCS Trip이면 예상되는 abrupt MW loss/restart pattern이 있는가?
- BMS intervention이면 특정 Cell의 voltage/temperature/current signature가 있는가?
- External dispatch issue라면 다른 DUID도 동시 반응하는가?
- Cell degradation이면 temperature/SOC operating point를 보정한 뒤에도 resistance divergence가 유지되는가?

## 2.4 데이터 보존

원본은 수정하지 않는다.

```text
project/
├─ 00_source/
├─ 01_inventory/
├─ 02_extracted/
├─ 03_processed/
├─ 04_scripts/
├─ 05_figures/
├─ 06_tables/
├─ 07_evidence/
├─ 08_external_sources/
└─ report/
```

각 source file에 대해 filename, byte size, SHA-256, source URL, acquired date, extraction path를 `SOURCE_MANIFEST.csv`에 남긴다.

---

# 3. Case A — Western Downs BESS 분석 전략

## 3.1 사건 정의

Target:
- DUID: `WDBESS1`
- Date: `2025-08-19`
- 공개 사건: AEMO Non-Conformance
- Market Notice 공개 구간: **12:15–12:20 AEST**
- 공개 Non-Conformance amount: **-55 MW**

이 시간은 **분석 시작점이 아니라 validation marker**로 취급한다. 분석기는 하루 전체에서 이상시점을 독립적으로 찾아야 한다.

## 3.2 Primary Data

### P1. `PUBLIC_NEXT_DAY_FPPMW`
주요 신호:
- interval timestamp
- measurement timestamp
- measured MW
- MW quality flag
- DUID

목적:
- 고해상도 WDBESS1 actual MW reconstruction
- timestamp integrity
- telemetry quality
- abrupt ramp / response analysis

### P2. Dispatch / Dispatch_SCADA
가능하면 추가 확보:
- INITIALMW
- Dispatch Target 계열
- State of Energy / Energy Storage 관련 field
- FCAS enablement
- regional dispatch variables

**Primary 520 MB archive만으로 먼저 분석하고, 추가 데이터는 가설 검증에 필요할 때 취득한다.**

---

# 4. Western Downs — Phase A1: Data Integrity

## Sampling
- 실제 sample interval distribution
- median / p95 / max gap
- duplicate timestamp
- frozen value

## Timestamp
`INTERVAL_DATETIME`과 `MEASUREMENT_DATETIME`이 모두 있다면:

```text
latency = INTERVAL_DATETIME - MEASUREMENT_DATETIME
```

분포를 분석한다. 실제 출력 급변인지 telemetry delay/timestamp batching인지 구분한다.

## Quality
Quality Flag별 count/period/event overlap을 확인한다.

**Quality degradation과 MW anomaly가 동시에 발생하면 물리적 출력 변화로 즉시 해석하지 않는다.**

---

# 5. Western Downs — Phase A2: Event Detection

기존 보고서 시간을 사용하지 않고 전체일에서 탐지한다.

계산:

```text
P(t)
dP/dt
ΔP_4s
rolling_mean
rolling_std
rolling_MAD
change_point_score
```

권장 방법:
1. Robust z-score
2. Rolling MAD
3. Step detection
4. `ruptures` 기반 change point
5. 지속시간 조건이 있는 ramp anomaly

이벤트를 다음 상태로 구분한다.

```text
Normal → Precursor → Initial deviation → Main response → Peak deviation → Stabilization → Recovery
```

출력: `event_timeline.csv`

| Timestamp | State | MW | dP/dt | Quality | Evidence |
|---|---|---:|---:|---|---|

---

# 6. Western Downs — Phase A3: Expected vs Actual

가능하면 Actual MW와 Dispatch Target을 비교한다.

```text
Tracking Error = Actual MW - Dispatch Target
```

분석:
- error magnitude
- error duration
- error sign
- recovery
- target change가 먼저인지 actual response가 먼저인지

가능하면 cross-correlation으로 `lag(Target → Actual)`을 계산한다.

### 핵심 질문
> WDBESS1이 명령을 못 따라간 것인가, 아니면 잘못된 외부 명령/상황에 정상적으로 반응한 것인가?

---

# 7. Western Downs — Phase A4: Cross-Asset Analysis

이 Case에서 가장 중요한 단계다.

동일 시간대 다른 DUID를 비교한다.

우선순위:
1. 동일 self-forecast/provider 영향 대상
2. 동일 Region
3. 다른 Region의 영향 설비
4. unaffected reference asset

각 설비 Event 직전 값을 normalize하여 `ΔP_normalized(t)`를 비교한다.

계산:
- change-point timestamp
- direction
- magnitude
- lag
- Pearson/Spearman correlation
- event synchronization score

### 판단 논리
다수의 서로 독립적인 발전설비가 거의 동시에 유사한 변화를 보이면:

> **Local BMS/PCS hardware failure 가능성은 하락하고 Common-mode external cause 가능성은 상승**

반대로 WDBESS1만 독립적으로 급락한다면 Local Fault branch를 강화한다.

---

# 8. Western Downs — Fault Hypothesis

| ID | Domain | Hypothesis |
|---|---|---|
| A-HW1 | Battery/BMS | Protection / unavailable |
| A-HW2 | PCS | PCS trip / derating |
| A-C1 | PPC | plant active-power controller error |
| A-C2 | EMS | stale/wrong setpoint |
| A-T1 | SCADA | stale / substituted / timestamp issue |
| A-M1 | Dispatch | incorrect dispatch target/input |
| A-M2 | Forecast | self-forecast/common provider error |
| A-G1 | Grid | frequency-driven response |
| A-N1 | Normal response | 정상 설비가 비정상 외부정보에 정상 반응 |

각 Hypothesis에 대해 `Expected Signature / Observed Signature / Contradiction / Required Missing Signal / Final Disposition / Confidence`를 작성한다.

---

# 9. Western Downs — Simplified FTA

```text
TOP: WDBESS1 Active Power / Dispatch Behavior Abnormality
|
+-- Local Hardware
|   +-- Battery/BMS unavailable
|   +-- PCS trip
|   +-- PCS derating
|
+-- Local Control
|   +-- PPC tracking failure
|   +-- EMS setpoint error
|
+-- Telemetry
|   +-- stale MW
|   +-- bad timestamp
|   +-- substituted value
|
+-- External Command / Market
|   +-- dispatch target error
|   +-- forecast input error
|   +-- provider software issue
|
+-- Grid response
    +-- frequency response
    +-- common-mode system disturbance
```

각 Leaf는 `Confirmed / Probable / Possible / Unlikely / Rejected / Unobservable` 중 하나로 종료한다.

---

# 10. Western Downs — 필수 그래프

- **A-F1 — “12시대 출력 급변은 정상 운전 범위를 명확히 이탈”**: full-day MW + detected event marker
- **A-F2 — “주요 변화는 수 분 단위 사건으로 집중”**: high-resolution event zoom + change points
- **A-F3 — “출력 변화율은 정상 Baseline 대비 ○배”**: dP/dt + baseline percentile
- **A-F4 — “타 설비와 동시 반응 여부가 Local Fault 판별의 핵심”**: normalized cross-asset plot
- **A-F5 — “Telemetry 품질 저하 없이 물리적 출력 변화가 관측되는가?”**: quality flag + MW + latency
- **A-F6 — “Actual–Target 오차가 어느 신호에서 먼저 시작됐는가?”**: dispatch target vs actual

---

# 11. Western Downs — 공식 보고서 검증 단계

독립 분석 완료 후 AEMO 자료를 읽는다.

| 항목 | Independent RAW Finding | AEMO Finding | 일치 | RAW만으로 입증 가능? |
|---|---|---|---|---|

특히 구분한다.

### RAW로 직접 입증 가능한 것
- 실제 MW 변화
- timing
- telemetry quality
- 타 설비 동시성

### AEMO 내부정보 없이는 입증 불가능한 것
- 특정 third-party software deployment detail
- provider 내부 forecast generation logic
- operator communication
- 내부 command chain

---

# 12. Case B — TU Darmstadt / MIT LFP Field Dataset 분석 전략

## 12.1 Dataset Fact

공개 dataset:
- 28 battery systems
- 각 system: 8S prismatic LFP
- nominal 24 V
- nominal capacity 약 160 Ah
- 총 224 cells
- 총 약 133 million rows
- measurement interval median 약 5 s
- data duration: 약 1개월 ~ 최대 5년
- returned-to-manufacturer field systems

센서:
- system current × 1
- cell voltage × 8
- total voltage sensor count 9
- temperature × 4
- balancing current × 8

Temperature sensor는 인접 Cell 두 개가 공유한다.

**중요:** 연구진도 정확한 반품 사유와 실제 fault type/time은 알 수 없다고 명시한다.

따라서 사전에 “System 6의 고장 원인은 Cell 8이다”라고 정의하지 않는다.

정확한 분석 출발점은:

> **System 6에서 Cell 8의 비정상 resistance divergence가 장기간 관측되는지 독립 검증하고, pack-level weakest-link degradation candidate인지 평가한다.**

---

# 13. Case B Primary Target

1차 Target:
- **System 6**
- 주 관찰 Cell: **Cell 8**

논문이 보고한 값은 독립 분석 후 validation reference로만 사용한다.

- Equivalent Full Cycles: 약 1,446
- Max age: 약 1,352 days
- Cell 8 resistance가 다른 cell보다 높음
- 약 3년 이후 resistance knee
- Cell 8 fault probability는 약 500일 이후 증가
- 약 800일 직전 0.5 초과

이 값들을 초기 threshold로 사용하지 않는다.

---

# 14. Case B — Phase B1: Schema / Signal Audit

field data를 먼저 탐색하여 실제 column name을 확인한다.

예상 계열:

```text
timestamp
system current
cell voltage 1..8
pack/system voltage
temperature 1..4
SOC
balancing current 1..8
```

논문의 표를 그대로 schema로 가정하지 않는다. 실제 CSV의 column/dtype/unit/missing/range를 inventory한다.

---

# 15. Case B — Phase B2: Sensor Quality

먼저 sensor fault 가능성을 별도 branch로 평가한다.

각 Cell Voltage:
- constant/frozen
- impossible step
- clipping
- offset
- correlation with pack voltage
- sum(cell voltages) vs pack voltage

검증:

```text
Voltage Closure Error = Pack Voltage - Σ(Cell Voltage_i)
```

Temperature:
- sensor pair consistency
- abrupt offset
- seasonal profile
- impossible value

Current:
- >1000 A outlier
- isolated impulse
- sustained high current
- sensor saturation 가능성

논문은 일부 system의 >1,000 A discharge outlier가 실제 short/inrush/installation abuse/sensor error 중 무엇인지 구분할 수 없다고 설명한다. 따라서 outlier를 자동 삭제하지 않는다.

---

# 16. Case B — Phase B3: Cell Imbalance

각 시간 t에서 Cell i에 대해:

```text
Vdev_i(t) = V_i(t) - robust_center(other 7 cells)
```

robust center 권장:
- median
- Hodges–Lehmann

추가 지표:

```text
V_range = max(V_i) - min(V_i)
V_std
V_IQR
```

SOC band별로 분리한다.

LFP는 OCV plateau가 넓기 때문에 단순 voltage difference만으로 SOH를 단정하지 않는다.

---

# 17. Case B — Phase B4: Event-Based Resistance Estimation

전체 데이터에 단순 `R = ΔV / ΔI`를 적용하지 않는다.

Current transition event를 선별한다.

조건 예:
- |ΔI| > threshold
- event 전/후 stable window
- balancing 영향 최소
- timestamp gap 없음
- temperature 급변 없음

Cell별:

```text
R_i,event ≈ -ΔV_i / ΔI
```

이후 resistance를 SOC/current/temperature/age에 대해 stratify한다.

가장 중요한 비교:

```text
R8 - median(R1..R7)
R8 / median(R1..R7)
```

시간에 따라 추적한다.

---

# 18. Case B — Phase B5: Operating Point 보정

LFP resistance는 `R = f(I, SOC, T, age)`에 의존한다.

따라서 Cell 8 resistance 증가가 단순히 저온/특정 SOC/특정 current/usage pattern 변화 때문인지 배제해야 한다.

### Level 1 — Bin matching
동일 SOC bin / temperature bin / current bin 안에서 Cell간 비교.

### Level 2 — Regression

```text
R ~ I + SOC + Temperature + Cell + Age
```

### Level 3 — GP / BattGP reproduction
논문의 GP-ECM 접근을 재현하되 최종 단계에서만 사용한다.

---

# 19. Case B — Signal-based Fault Analysis

GP보다 먼저 간단한 signal-based 분석을 수행한다.

### Cell voltage residual
`V_i - median(V_others)`

### Cell voltage correlation
rolling `corr(V_i, median(V_others))`

### Cell dispersion
`std(V_1..V_8)`, `range(V_1..V_8)`

### balancing burden
Cell별:
- total balancing Ah
- balancing time ratio
- repeated high balancing period

Cell 8이 다른 Cell보다 지속적으로 balancing intervention을 요구하는지 분석한다.

---

# 20. Case B — Thermal Analysis

Cell 8 주변 temperature sensor가 다른 sensor와 달라지는지 확인한다.

다만 sensor 하나가 Cell 두 개를 공유하므로 특정 Cell의 국부 발열을 temperature만으로 직접 입증할 수 없다.

분석:

```text
T_sensor - median(other T)
rolling temperature residual
temperature vs current
temperature vs estimated resistance
```

Cell 8 resistance 상승과 인접 Temperature가 함께 상승한다면 supporting evidence이지만 causation은 아니다.

---

# 21. Case B — Charge Throughput / Usage

가능하면 current integration:

```text
Ah_throughput = ∫ |I| dt
Equivalent Full Cycles ≈ Ah_throughput / (2 × nominal_Ah)
```

단 logging gap / shipping-manufacturing period 미상 / switched-off period 때문에 실제 total lifetime throughput으로 단정하지 않는다. Dataset 안에서 관측 가능한 기간 기준으로 계산한다.

---

# 22. Case B — Knee Detection

Cell 8 resistance trend에 대해 knee를 독립 탐지한다.

후보:
- piecewise linear regression
- PELT change point
- Bayesian change point
- Kneedle
- slope ratio

최소 두 방법으로 교차검증한다.

출력:

```text
candidate knee date/age
pre-knee slope
post-knee slope
slope ratio
confidence interval
```

논문의 “약 3년”은 마지막 validation에만 사용한다.

---

# 23. Case B — GP / BattGP Reproduction

독립 signal/resistance 분석 완료 후 논문 방법을 재현한다.

논문 핵심:
- Equivalent Circuit Model
- Gaussian Process
- operating-point-dependent resistance
- time-dependent resistance
- recursive spatiotemporal GP
- resistance-distribution fault probability

구현 시 원 논문의 reference operating point / kernel / band width / initialization / recursive structure를 BattGP code에서 확인하고 그대로 재현한다.

**논문의 숫자를 hard-code하지 않는다.**

---

# 24. Case B — System 6 Fault Hypothesis

| ID | Hypothesis |
|---|---|
| B-C1 | Cell 8 intrinsic electrochemical degradation |
| B-C2 | Cell 8 contact/connector resistance increase |
| B-C3 | Cell 8 sensor bias/fault |
| B-C4 | Cell 8 temperature-associated resistance increase |
| B-C5 | balancing/control issue |
| B-C6 | usage/SOC operating-point artifact |
| B-C7 | pack-level common aging |
| B-X1 | external connection/corrosion |
| B-U1 | unknown field-use abuse |

### 매우 중요한 제한
논문 저자도 resistance pattern만으로 battery degradation / connector loss / corrosion / connector resistance increase / 기타 external degradation을 구분할 수 없다고 설명한다.

따라서 최종 Root Cause는 최대:

> **Cell 8 경로의 유효 직렬저항 증가**

수준까지 입증될 수 있으며,

> **전극 내부 degradation이 확정 원인**

이라고 표현하면 안 된다.

---

# 25. Case B — FTA

```text
TOP: System 6 Pack Performance / Health Abnormality
|
+-- Cell 8 electrochemical degradation
|
+-- Cell 8 electrical path degradation
|   +-- connector resistance
|   +-- corrosion
|   +-- contact loss
|
+-- Sensor artifact
|   +-- voltage bias
|   +-- current error
|   +-- temperature error
|
+-- Operating condition
|   +-- temperature
|   +-- SOC usage
|   +-- high-current abuse
|
+-- Balancing / BMS
|   +-- unequal balancing
|   +-- persistent correction burden
|
+-- Pack-wide aging
```

---

# 26. Case B — 필수 그래프

- **B-F1 — “Cell 8은 수명 후반 다른 7개 Cell과 점진적으로 분리”**: cell resistance time series
- **B-F2 — “Cell 8 deviation은 operating point 보정 후에도 유지되는가?”**: matched SOC/T/current resistance
- **B-F3 — “Cell imbalance가 장기적으로 확대되는 시점 확인”**: voltage std/range
- **B-F4 — “Resistance knee가 어느 시점에 시작되는지 독립 탐지”**: trend + detected knee
- **B-F5 — “Cell 8 이상 확률이 Peer Cell보다 먼저 증가하는가?”**: independent score + GP probability
- **B-F6 — “Balancing 및 Temperature가 Cell 8 열화를 설명하는가?”**: balancing burden / thermal residual

---

# 27. Case B — 논문 결과와 비교

RAW 독립분석 후 최종적으로 비교한다.

| 항목 | Independent Analysis | Paper | 일치 | 비고 |
|---|---|---|---|---|
| abnormal cell | | Cell 8 | | |
| divergence onset | | | | |
| resistance knee | | ~3 years | | |
| fault probability rise | | ~500 days | | |
| p > 0.5 | | shortly before ~800 days | | |
| pack weakest-link interpretation | | yes | | |
| exact physical root cause | | unresolved | | |

---

# 28. 두 사례의 공통 Evidence Ledger

`07_evidence/EVIDENCE_LEDGER.csv`

```text
Evidence_ID
Case
Timestamp_or_Age
Source_File
Signal
Observation
Derived_Metric
Supports
Contradicts
Confidence
Figure_ID
Notes
```

모든 Executive Report의 핵심 문장은 Evidence_ID에 연결한다.

---

# 29. Confidence Rule

- **Confirmed**: RAW에서 직접 확인
- **High**: 복수 독립 signal이 같은 결론 지지
- **Medium**: 근거는 있으나 alternative hypothesis 존재
- **Low**: 정황 근거
- **Unknown**: 공개 데이터로 판별 불가

---

# 30. 비교 분석의 최종 목적

두 사례를 억지로 하나의 failure mode로 통합하지 않는다.

## Case A
### “설비가 이상해 보인다고 설비 고장인 것은 아니다.”
Grid/dispatch/external control 문제는 정상 BESS를 Non-Conforming 상태처럼 보이게 할 수 있다.

## Case B
### “Pack 고장은 평균값보다 단일 Cell의 장기 Divergence에서 먼저 드러날 수 있다.”
8S 직렬 구조에서는 weakest cell이 pack usability를 제한할 수 있다.

---

# 31. 회사 관점 Engineering Lesson

분석 결과에 따라 검증하되 다음 관점을 평가한다.

1. **End-to-End observability**  
   Battery → BMS → PCS → PPC → EMS → SCADA → external dispatch 전체 command/response chain을 동일 timestamp로 기록.

2. **Relative anomaly monitoring**  
   절대 threshold뿐 아니라 Cell vs peer cell / Asset vs peer asset 비교.

3. **Common-mode detection**  
   동시간대 타 설비 분석으로 Local Fault 오판 방지.

4. **Long-term weak-link detection**  
   Cell 간 resistance divergence / balancing burden / voltage residual을 장기 열화 조기경보 후보로 활용.

5. **Raw forensic logging**  
   Fault 발생 후 Command / Actual / Protection / Quality / Time Sync / Cell-level data를 함께 보존.

---

# 32. 최종 Executive Report 구조

각 Case별 **5~8 Page 이하**를 목표로 한다.

## Page 1 — Executive Summary
Headline은 결론형 한 문장.

## Page 2 — What Happened
Timeline + 핵심 그래프 1개 + Observable Fact.

## Page 3 — Why We Think So
핵심 Evidence 3개 이하 + 반증 결과.

## Page 4 — FTA
Simplified FTA만 본문. 상세 FTA는 Appendix.

## Page 5 — Fault Domain Assessment
| Domain | Likelihood | Key Evidence | Limitation |
|---|---|---|---|

## Page 6 — Independent Findings
기존 AEMO/논문을 읽지 않고 RAW에서 도출한 Finding 최대 3개.

## Page 7 — Published Finding Comparison
독립분석 vs AEMO 또는 논문.

## Page 8 — Management Implication
3~5개.

---

# 33. Executive Writing Rule

최종 보고서는 **한국어**.

각 Page:

```text
Headline Message
↓
Key Evidence 2–4개
↓
Figure/Table 1개
↓
So What? 1–2문장
```

장문의 기술 설명은 Appendix로 이동한다.

Headline은 제목이 아니라 **결론**이어야 한다.

나쁜 예:
> System 6 분석 결과

좋은 예:
> **Cell 8의 저항 Divergence가 다른 Cell 대비 수백 일 먼저 명확해짐**

---

# 34. 필수 최종 구분

각 Case 결론 마지막에 반드시 세 Box를 둔다.

## Data가 직접 입증하는 것
Observed 사실만.

## Data가 강하게 시사하는 것
복수 증거 기반 Engineering inference.

## Data로 판단할 수 없는 것
미공개 내부 정보 / 물리검사 / 실제 사용자 history가 필요한 항목.

---

# 35. 구현 순서

```text
STEP 01  Source integrity / SHA-256
STEP 02  Archive inventory
STEP 03  Schema discovery
STEP 04  Raw extraction
STEP 05  Data-quality audit
STEP 06  Baseline characterization
STEP 07  Independent anomaly detection
STEP 08  Fault hypothesis generation
STEP 09  Signal-based analysis
STEP 10  Cross-asset / cross-cell comparison
STEP 11  Model-based analysis
STEP 12  Counterfactual / contradiction test
STEP 13  FTA
STEP 14  Evidence ledger
STEP 15  External published-source validation
STEP 16  Executive report
STEP 17  Technical appendix
```

---

# 36. 구현 산출물

```text
report/
├─ 01_WDBESS1_Executive_Report_KR.html
├─ 02_LFP_System6_Executive_Report_KR.html
├─ 03_Cross_Case_Lessons_KR.html
├─ Technical_Appendix_WDBESS1_KR.html
├─ Technical_Appendix_LFP_KR.html
└─ assets/
```

가능하면 PDF도 생성한다.

분석 산출물:

```text
05_figures/
06_tables/
07_evidence/
08_external_sources/
```

---

# 37. 구현 시 금지사항

- AEMO 결론을 먼저 읽고 로그를 끼워 맞추기
- 논문의 Cell 8 결론을 label로 주고 모델 학습
- missing data를 근거 없이 interpolation
- 1,000 A outlier 자동 삭제
- voltage anomaly를 곧바로 cell degradation으로 해석
- resistance rise를 곧바로 electrochemical degradation으로 확정
- WDBESS1 MW deviation을 곧바로 PCS fault로 해석
- correlation을 causation으로 표현
- 내부 BMS/PCS fault code를 추정 생성
- 공개되지 않은 반품 원인을 만들어내기

---

# 38. Stop Condition

## Western Downs
- [ ] MW event independent detection 완료
- [ ] Telemetry quality 검증
- [ ] Local vs common-mode 비교
- [ ] Hardware branch 반증
- [ ] external/dispatch branch 검증
- [ ] AEMO 결과는 마지막에 비교

## LFP System 6
- [ ] Cell sensor integrity 검증
- [ ] Cell 8 voltage divergence 검증
- [ ] event-based resistance 독립 추정
- [ ] SOC/T/I operating point 보정
- [ ] knee independent detection
- [ ] balancing/temperature 분석
- [ ] GP/BattGP reproduction
- [ ] physical root cause limitation 명시
- [ ] 논문 결과는 마지막에 비교

---

# 39. 성공 기준

### Western Downs
> **공개 계통 로그만으로 Local Hardware Fault와 External/Common-mode Fault를 어디까지 구분할 수 있는가?**

### LFP Dataset
> **현장 BMS 로그만으로 단일 Cell의 장기 열화를 얼마나 조기에 검출할 수 있으며, 어느 수준까지 Root Cause를 좁힐 수 있는가?**

### 공통
> **어떤 추가 Log가 있었다면 FTA의 Unknown branch를 닫을 수 있었는가?**

---

# 40. Reference Sources

## Western Downs / AEMO

1. Australian Energy Market Operator (AEMO), *Self-Forecasting Errors and Frequency Excursion on 19 August 2025*.  
   https://www.aemo.com.au/-/media/files/electricity/nem/market_notices_and_events/power_system_incident_reports/2025/self-forecasting-errors-and-frequency-excursion-on-19-august-2025.pdf

2. AEMO Market Notices — WDBESS1 Non-Conformance, 19 Aug 2025. WDBESS1: 12:15–12:20, -55 MW.  
   https://www.aemo.com.au/market-notices

3. AEMO, *Frequency Monitoring Q3 2025*.  
   https://www.aemo.com.au/

4. ARENA / Neoen, Western Downs BESS knowledge-sharing reports.  
   https://arena.gov.au/

## TU Darmstadt / MIT LFP Field Dataset

5. Schaeffer, J. et al., *Gaussian process-based online health monitoring and fault analysis of lithium-ion battery systems from field data*, Cell Reports Physical Science 5, 102258 (2024). DOI: 10.1016/j.xcrp.2024.102258  
   https://web.mit.edu/braatzgroup/Schaeffer_CellRepPhysSci_2024.pdf

6. Schaeffer, J. et al., *Lithium-Ion Battery Field Data: 28 LFP battery systems with 8 cells in series, up to 5 years of operation*, Zenodo. DOI: 10.5281/zenodo.13715694  
   https://zenodo.org/records/13715694

7. BattGP — associated open-source Python library.  
   https://github.com/JoachimSchaeffer/BattGP

---

# 41. 최종 지시

분석 중 결론이 예상과 다르면 **예상 결론을 버리고 데이터에 따른다.**

- WDBESS1이 실제 Local Fault signature를 보이면 이를 숨기지 않는다.
- System 6에서 Cell 8보다 다른 Cell/Signal이 더 강한 이상을 보이면 Target을 재평가한다.
- 논문 또는 공식보고서와 불일치하면 이를 오류로 간주하지 말고 원인을 분석한다.

최종 보고서의 가장 중요한 문장은 항상 다음 질문에 답해야 한다.

> **그래서 무엇이 실제로 관측됐고, 무엇이 가장 가능성이 높으며, 무엇은 아직 증명할 수 없는가?**
