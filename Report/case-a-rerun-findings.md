# Case A 재실행 findings (2026-08-31)

짝 문서: `Report/case-a-rerun-plan.md`.
브랜치 `feat/case-a-rerun`. 이 워크트리만 사용.
`C:\Users\windo\ESSanalyzer`와 `main`은 건드리지 않았다.

`npm run test:unit` 138 passed / 1 skipped / 0 failed, `npm run build` 통과.
라이브 파이프라인: `RUN_CASE_A=1 PW_PORT=5186 npx playwright test tests/e2e/regenerate-case-a.spec.js --project=desktop-chromium` — **1 passed, 54.7분**.
하니스: `tests/e2e/regenerate-case-a.spec.js` (`feat: drive Case A through the real nested-zip pipeline`).

독립 보고서: `Report/case_a_report.html` (385,685 bytes).
대조 HTML: `Report/case_a_report_compared.html` (397,680 bytes).
파이프라인 스냅샷: `Report/case_a_pipeline.json`.
원본 덤프: `tmp/case-a-regen/` (gitignore).

프롬프트 예산 상수, Web Worker, GP 관련 코드는 건드리지 않았다.
`CLAUDE_CLI_TIMEOUT_MS` 코드 기본값(30분)은 그대로다. `.env`도 30분.
`Report/case_b_*`는 수정하지 않았다.

---

## 1. 입력과 날짜 선택

`Log_sample/case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip` (520,040,023 bytes)를 미리 추출한 CSV가 아니라 **중첩 ZIP 그대로** 올렸다. 로컬 헤더 기준 내부 zip 7개(20250817–23, 각 약 76–79 MB). 각 내부 zip은 CSV 하나(~522 MB uncompressed, 라벨 약 498 MB)를 들고 있다. 계획문의 “7일 전부 ≈545 MB 스트리밍”은 **내부 zip 파일 크기**를 CSV 스트리밍 양으로 적은 것이다. 실제 CSV는 일당 ~522 MB.

AEMO NEXT_DAY 파일명 날짜는 **발행일**이다.

| 내부 zip / CSV | 데이터 시작 (MEASUREMENT_DATETIME) | 비고 |
|---|---|---|
| `…_20250819_…` | 2025/08/18 04:05 | 이전 골드런 `WDBESS1_peers_20250819.csv`와 같은 거래일 |
| `…_20250820_…` | 2025/08/19 04:05 | **2025-08-19 사건일 포함** — 이 파일을 반드시 넣었다 |

스트리밍한 날은 **3일**: 발행일 `20250818`, `20250819`, `20250820` (거래일 17/18/19일). 이유:

- 사건일 파일(20250820)은 필수.
- 인접 이틀은 PR #8 시간축을 하루짜리 추출과 다르게 보여 준다.
- 일당 ~522 MB라 7일 전부는 ~3.6 GB. Case B 원본 2.89 GB 스트리밍과 겹치는 부담을 피했다.
- `collectSeriesContext`가 같은 엔티티를 **나중 소스가 덮어쓴다.** 카탈로그 순서에서 20250820이 선택된 셋의 마지막이라 A-F1 시계열은 사건일 파일에 남는다. 20250821 이상을 넣으면 그림이 사건일 다음 날로 넘어간다.

카탈로그는 7개 CSV를 모두 올렸고(22초), 엔티티 필터는 카탈로그·스트리밍 뒤 모두 `BESS` 자동 제안, 입력칸 표시·활성화 상태. 숨기거나 고정하지 않았다. 6개 그룹: CHBESS1, HBESS1, PIBESS1, TARBESS1, ULPBESS1, WDBESS1.

BESS 필터 후 일당 64,800행 / 파생 이상 879·901·915건. 컬럼에 Dispatch Target은 없다 (`INTERVAL_DATETIME, MEASUREMENT_DATETIME, FPP_UNITID, VERSIONNO, MEASURED_MW, MW_QUALITY_FLAG, SCHEDULED_MW, DEVIATION_MW, PARTICIPANTID`).

---

## 2. 시간 커버리지 (PR #8)

세 소스 모두 **데이터 구간 = 알람 근거 구간, 커버리지 100%**. 짧은 구간을 길게 말하지 않는다. 유지 샘플은 소스당 8개 시간 계층에 나뉘어 있다.

| 소스 (발행일) | 데이터·근거 구간 (UTC) | 커버리지 | 대략 AEST |
|---|---|---|---|
| 20250818 | 2025-08-16T19:00:04Z .. 2025-08-17T07:00:00Z | 100% | 08-17 05:00–17:00 |
| 20250819 | 2025-08-17T19:00:04Z .. 2025-08-18T07:00:00Z | 100% | 08-18 05:00–17:00 |
| 20250820 | 2025-08-18T19:00:04Z .. 2025-08-19T07:00:00Z | 100% | 08-19 05:00–17:00 |

각 NEXT_DAY 파일은 약 **12시간**만 들고 있다 (AEST 05:00–17:00). 파일 사이 UTC 07:00–19:00 (AEST 17:00–05:00)은 이 아카이브에 없다. 보고서는 이 범위를 사실로 적었고, 3년·전 기간처럼 과장하지 않았다.

알람 샘플은 사건 5분에만 몰리지 않고 계층화되어 있다. Case B의 “퍼져야 좋다”를 이식하지 않았다. A-F1의 max-ΔP 앵커는 `2025-08-18T23:04:20Z` (AEST 08-19 09:04) — 공개 12:15를 코드에 넣지 않은 결과다. 오후 쪽 진동은 A-F1/A-F3에 보이지만 최대 빈 변화는 오전 급락이다.

이전 보고서(2026-08-27, 사전 추출 3.1 MB, 약 12시간 단일 구간, 피어 중첩 ~1시간)는 자기 시간축을 헤드라인에 넣지 못했다. 이번 보고서는 구간·커버리지·3개 파일을 본문에 명시한다.

---

## 3. Figure available / unavailable

| Figure | 이전 (3.1 MB 추출) | 이번 (중첩 ZIP 3일) | 사유 |
|---|---|---|---|
| A-F1 | available | **available** | WDBESS1 MW 시계열. rangeMw **513** (이전 ~334). eventDeltaMw **−241 MW**. |
| A-F2 | available | **available** | 이벤트 창 5점 (빈이 굵다). Precursor→Main→Recovery. |
| A-F3 | available | **available** | p95 **3206.3 MW/h** (이전 2835). |
| A-F4 | **unavailable** (`타 설비와 상관 없음 — 포커스 단독 급변`) | **available**, mode=`local`, score=0, peerCount=5, supportingCount=0 | 이전엔 피어가 이벤트 창에 점이 없어 unavailable. 하루 통째로 스트리밍하니 피어 6개(포커스+5)가 창에 들어 available이 됐다. 판정은 여전히 local — common-mode로 바뀌지 않았다. |
| A-F5 | available | **available** | eventQuality=1, 품질 저하 없음. |
| A-F6 | unavailable | **unavailable** (동일 문구) | Dispatch Target 컬럼 없음. 만들어내지 않았다. |

A-F4가 available로 바뀐 것은 결함이 아니라 입력 범위가 넓어진 결과다. mode는 local 그대로라서 “피어와 같이 움직인다”로 뒤집히지는 않았다.

---

## 4. Step 4 — 이번 실행의 가설

AI가 낸 세 개:

| # | 가설 | domain | conf |
|---|---|---|---|
| H1 | 다수 설비 공통 스케줄(입찰밴드) 대칭 확장 — Dispatch/시장운영 변경 가능성 | Dispatch | Medium |
| H2 | WDBESS1 PCS 지령추종 편차 확대 — H1만으로 안 남는 초과분 | PCS | Low |
| H3 | 알람 집계 파이프라인 정합성 (통계 515 vs 전체 1243) | Telemetry/SCADA | Low |

**채택: H1, 심각도 중.** 이전 보고서의 `PCS 유효전력 폐루프 제어 불안정(헌팅) 의심`에 맞추지 않았다.

이유 (이번 데이터만):

- 3일 입력이 없으면 보이지 않는 관측: WDBESS1·HBESS1·CHBESS1의 SCHEDULED_MW가 3일차에 각각 ±255/±150/±100으로 대칭화. Medium confidence의 핵심.
- A-F4 available+local 이라 MEASURED_MW 급변(−241 MW, quality=1)은 포커스 단독. 스케줄 대칭화와 실측 급변을 한 물리현상으로 합치지 않았다.
- H2의 PCS 주장은 A-F6 unavailable과 Low confidence로 닫히지 않는다. 이전 결론과 비슷해 보여도 이번 근거로는 약하다.
- H3의 728건 차이는 품질플래그 알람과 파생 MW 규칙이 같이 잡힌 쪽으로 설명될 여지가 크다.

심각도 중: 공개 FPPMW만으로 설비 결함도 정상 시장운영도 확정 불가. −241 MW 국소 급락은 후속 로그가 필요하지만 하드웨어 Confirmed로 올리지 않는다.

---

## 5. 이전 보고서와 달라진 것

| | 2026-08-27 (`WDBESS1_peers_20250819.csv`) | 2026-08-31 (중첩 ZIP 3일) |
|---|---|---|
| 입력 | 사전 추출 3.1 MB, 하루, 피어 중첩 ~1시간 | 520 MB 중첩 ZIP 카탈로그 + 3×~522 MB 스트림 |
| 시간축 명시 | 본문에 구간은 있으나 PR #8 커버리지 카드/헤드라인 요구 이전 | 소스별 구간·100% 커버리지·계층 샘플이 UI·보고서에 있음 |
| 확정 가설 | PCS 폐루프 헌팅 의심 | **공통 스케줄 대칭 확장 (Dispatch)** |
| 심각도 | 중 | 중 (근거가 다름) |
| A-F4 | unavailable | **available / local** |
| A-F1 ΔP | 엔벌로프 침범 ~1.88–5.95 MW 서술 | max-bin ΔP **−241 MW** (사건일 파일) |
| 피어 | TARBESS1·HBESS1·ULPBESS1 등 | CHBESS1·PIBESS1 포함 6개. TARBESS1은 1·3일차 MEASURED_MW=0 고정(flag=2) |
| ULPBESS1 | ~1시간 동결 | 3일 모두 ~−0.494 MW 고정, flag=2 |

다른 결론이 난 것이 정상이다. 맞추려고 보고서를 고치지 않았다.

---

## 6. 단계별 벽시계

Playwright 시작 `2026-08-30T21:10:44Z`, 종료 약 `22:05:28Z`, **54.7분**. 429/spend-limit 없음.

| 단계 | 소요 |
|---|---|
| 카탈로그 (7 CSV, 중첩 zip) | 22 s |
| 스트림 20250818 | 25 s (64,800행) |
| 스트림 20250819 | 25 s |
| 스트림 20250820 | 25 s |
| detect-anomaly | 648 s (10.8 min) |
| generate-hypotheses | 493 s (8.2 min) |
| 사람 검토 대기 (decision 파일) | 418 s |
| draft-report | 1140 s (19.0 min) |
| published-comparison | 482 s (8.0 min) |

공개 대조는 **독립 HTML을 저장한 뒤**에만 돌렸다. `findingsFrozen: true` — `independentFindings`는 대조 전후 동일.

대조 표는 A-F1을 공개 Notice(이탈 존재)와 `agree=yes`로 맞췄고, A-F6는 `rawSufficient=false`. 스키마가 Case B용 GP/Vdev 행(X2, X3)도 뱉었는데, 이번 AEMO 실행에서는 해당 없음·rawSufficient=false로 표시됐다. 프롬프트 상수 재조정은 하지 않았다.

---

## 7. 못 한 것

- **7일 전부 스트리밍하지 않음.** CSV가 일당 ~522 MB라 3일로 잘랐다. 카탈로그는 7일 모두 수행.
- **그림 시계열은 사건일 파일만.** 소스 병합이 엔티티 단위 last-write-wins라서 18/19일 MW 빈은 A-F1에 안 겹친다. 시간 커버리지·프롬프트 블록은 3일 모두 들어간다. 코드로 빈을 이어 붙이지 않았다 (범위 밖).
- **A-F6는 계속 unavailable.** 공개 FPPMW에 Target 컬럼이 없다.
- **AEMO 본문 PDF는 읽지 않았다.** 대조 발췌는 저장소가 정리해 둔 표제·Market Notice 두 줄만, 독립 저장 후에 붙였다.
- 엔티티 필터를 비우거나 WDBESS1-only로 다시 돌리지는 않았다. 필터는 사람이 지울 수 있는 상태로 두었다.

`npm run test:unit` 138 passed / 1 skipped (stride80 CSV 없음) / 0 failed. `npm run build` 통과.
