# Case A 공개 대조본 재실행 — findings (2026-09-03)

짝 문서: `Report/case-a-compare-rerun-plan.md`.
브랜치 `feat/case-a-compare-rerun`, 워크트리 `C:\Users\windo\ESSanalyzer-tz`.

`npm run test:unit` 180 pass / 1 skip / 0 fail, `npm run build` 통과.
라이브 런: `RUN_CASE_A=1 PW_PORT=5186` regenerate-case-a.spec.js → **1 passed (52.4m)**.

**갭이 닫혔다.** 독립본과 대조본이 **같은 세션**에서 나왔다:

| 산출물 | bytes | 시각 |
|---|---|---|
| `Report/case_a_report.html` | 616,957 | `2026-09-03T14:58:59Z` |
| `Report/case_a_report_compared.html` | 626,978 | `2026-09-03T15:06:58Z` |
| `Report/case_a_pipeline.json` | 17,116 | `publishedComparison.ok = true` |

대조본은 독립본 + 10,021 bytes다. 독립본 본문 609,832 bytes(인라인 PNG 6장 포함)가 대조본에
**바이트 그대로** 들어 있음을 확인했다 — 대조는 추가이고 재작성이 아니다. `findingsFrozen: true`.

`Report/case_b_*`는 수정하지 않았다. 코드·테스트 픽스처에 −55 MW, 12:15, 12:05, 19 Aug를 넣지 않았다.

---

## 1. 대조 단계는 세 번째 시도에 성공했다

| 시도 | 결과 | 실패 원인 |
|---|---|---|
| 2026-08-31 (PR #14) | 독립본까지 성공 | `You've hit your session limit · resets 2:20am` @ `14:52:14Z` |
| 2026-09-03 1차 | 독립본까지 성공 | **API 서버가 호출 중 사라짐** — `/api/compare-published` `read ECONNRESET`, 대조 시작 59초 후 |
| 2026-09-03 2차 | **전 구간 성공** | — |

1차 실패는 세션 한도가 아니었다. 서버 프로세스가 하니스 백그라운드 작업으로 떠 있었고 그것이
정리되면서 호출이 끊겼다. 2차는 서버와 Playwright를 **하니스 밖 분리 프로세스**로 띄웠고 끊기지
않았다. 1차 산출물은 `tmp/case-a-regen-sep3-attempt1/`에 남겼다(gitignore).

**대조 한 단계 때문에 전체 런을 두 번 날렸으므로 재개 경로를 만들었다** — 아래 5절.

## 2. 결정적 단계는 세 런에서 동일하다

`catalog.json` · `stream.json` · `t1-figures.json`이 PR #14 런, 1차, 2차에서 `capturedAt`만
빼면 **바이트 동일**하다. 즉 TZ 해석·시리즈 병합·figure·앵커는 재현되고, 달라지는 것은 AI
단계뿐이다.

- 일당 64,800행, 알람 22,866 / 22,965 / 25,314
- 파생 이상 **1,240 / 1,465 / 2,877** (PR #14와 동일)
- A-F1 앵커 −250.6 MW @ `2025-08-17T00:26:12Z`, `anchorScope=global-maximum`, `eventDay=2025-08-17`
- A-F4 `mode=local, score=0, peerCount=5, supportingCount=0`
- A-F5 `eventQuality=1`, A-F6 −119.5 MW @ `2025-08-19T03:12:36Z` (available)

## 3. AI 단계는 런마다 다르다 — 가설 세트가 통째로 바뀌었다

| | PR #14 | 09-03 1차 | 09-03 2차 (채택 런) |
|---|---|---|---|
| H1 | Battery/BMS 출력한계 (Low) | Grid 교차설비 동조 (Medium, draft 상) | Dispatch 외부 공통요인 (Medium, draft 중) |
| H2 | **PPC/EMS 급전 추종편차 (Medium)** | Battery/BMS derating (Low) | **PPC 디스패치 추종/램프 (Low, draft 상)** |
| H3 | 계통 FCAS 동조 (Low) | Telemetry/SCADA 대체값 (Medium) | Normal Response FCAS (Low) |
| 채택 | H2 · 중 | (런 실패) | **H2 · 중** |

세 런의 가설 문구가 전부 다르다. 같은 입력·같은 figure에서 이렇게 갈리므로, 보고서의 가설
문구는 런에 종속된 산출물로 읽어야 한다. 결정적 근거(figure·카운트)는 그렇지 않다.

## 4. 사람 검토 — 모델 라벨을 따르지 않았다

`hypIndex=1` (H2, PPC), 심각도 **중**. 판단 근거는 `tmp/case-a-regen/review-applied.json`에
전문이 남아 있다.

**모델이 H1에 Medium, H2에 Low를 붙였는데 H2를 채택했다.** 증거 분포가 로컬 쪽이기 때문이다:

- 지속편차 창 14건 중 **10건이 상대 설비 대응 구간 없는 단독**
- 목록 최장·최대(**449행 ≈30분, 124.20 MW**)가 WDBESS1 단독
- 동조 검정용 A-F4가 앵커에서 `score=0, supportingCount=0`
- H1의 근거인 교차 중첩은 14건 중 **2쌍**이고, H1 자신의 `claimLimit`이 우연의 일치를 배제하지
  못한다고 적는다

**초안 심각도 상은 받지 않았다.** 가장 무거운 이유는 기준선이다:

> 편차는 실제 디스패치 타깃이 아니라 **`SCHEDULED_MW` 엔벌로프** 대비 값이고, CS 의뢰문 자체가
> 타깃 컬럼 부재를 명시한다. **이것이 순응성 위반인지 자체가 미확정이다.**

여기에 PPC 커맨드·응답 로그 부재(결함/지시/보간 구분 불가), A-F5 `quality=1`(품질 저하 없음),
트립·보호동작 등 관측된 결과 피해 부재, 그리고 상의 근거로 든 이상행 비율 22.3%가 추세가 아니라
세 번째 파일이 사건 거래일이라는 사실로 설명된다는 점을 더했다.

채택된 헤드라인은 이 판단을 반영한다 — `증거는 WDBESS1 국소 요인 쪽에 무게가 실리지만
(A-F4 local, score=0) 교차설비 시간 중첩 2건으로 순수 로컬 원인 단정은 불가`.

## 5. 재개 경로 (커밋 `f765845`)

대조가 마지막 라이브 단계인데 두 번 그것만 실패했고, 두 번 다 독립본은 이미 디스크에 있었는데도
재시도가 detect/hypotheses/draft를 다시 돌렸다(약 30분의 모델 시간).

- `regenerate-case-a.spec.js`가 독립본 저장 시점에 `tmp/case-a-regen/report-full.json`을 덤프한다.
  보고서 본문·`figureSpecs`(**시리즈 포함**)·`sourceProfiles`·심각도·확정 가설. figureSpecs를
  통째로 덤프하는 이유는 내보낸 HTML이 그 데이터로 그린 PNG를 인라인하기 때문이다 — 카탈로그
  수준 덤프로는 다시 그릴 수 없다(1차 실패 때 확인).
- 신규 `tests/e2e/resume-case-a-compare.spec.js`가 그 덤프를 주입해 **대조만** 실행한다.
  zip·스트리밍·AI 3단계 없이 라이브 호출 1회.
- **fidelity gate**: 대조를 호출하기 전에 주입된 상태로 독립본을 내보내 원본 런의
  `case_a_report.html`과 **바이트 동일**한지 검사하고, 다르면 실패시킨다. 비슷한 것을 발행하지
  않기 위한 장치다. `CASE_A_COMPARE_DRY=1`로 이 경로 전체를 모델 호출 없이 점검할 수 있다.
- `src/main.js`가 `render`를 `state`와 같은 이유로 window에 노출한다(주입 후 재그리기).
  앱 동작은 바뀌지 않는다.

**이 재개 경로는 이번 런에서 실행되지 않았다** — 대조가 성공해서 필요가 없었다. 즉 실제 실패
상황에서의 동작은 아직 검증되지 않았고, 유닛/DRY 수준까지만 확인됐다.

## 6. 공개 대조가 실제로 말한 것 (10행, `findingsFrozen: true`)

`agree`: partial 4 / unknown 6 / yes 0 / no 0. rawSufficient=false 3행.

- **A-F6 −119.5 MW vs AEMO 통보 −55 MW** — 설비·부호는 일치, 크기는 2배 이상 차이. 대조는
  "A-F6은 3일 구간 전체 최대치이고 AEMO는 특정 5분 창 값이므로 모순으로 단정하지 않되 시각 단위
  매칭이 필요"로 적었다. 이 판단은 `Report/case_a_vs_aemo_log_analysis.md`가 남긴 "서로 다른
  물리량" 결론과 방향이 같다.
- **약 30분·449행 창 vs AEMO 5분 창** — 지속편차 창(광의)과 통보 판정 창(협의)이 다른 정의일
  가능성으로 처리, 실제 시각 중첩은 추가 확인.
- **파생 이상 1,240→1,465→2,877은 단조 증가지만 지속편차 창은 11→8→17로 한 번 감소** —
  22.3% 급등이 창 개수보다 건당 강도·지속시간 확대에 기인했을 가능성(Inferred).
- **품질 플래그 미저하가 'Self-Forecasting Errors' 프레이밍과 방향은 부합** 하나 상관일 뿐
  인과가 아니라고 명시.

## 7. 발견 — 대조 프롬프트가 케이스를 가리지 않는다

10행 중 3행(AEMO self-forecast 내부 로직, 논문 GP fault probability, Vdev vs 시간의존 저항)은
**Case A 발췌에 없는 항목**이다. 모델 드리프트가 아니라 `server/lib/prompts.js`의
`buildPublishedComparisonPrompt`가 그 세 항목을 문자열로 하드코딩하기 때문이다 — Case B 논문
항목이 Case A 대조표에 항상 실린다.

출력 자체는 정직하다(전부 `rawSufficient=false`, `agree=unknown`). 그러나 케이스 무관 항목이
표의 30%를 차지한다. **이번 증분에서 고치지 않았다** — 범위는 산출물 교체와 재개 경로다.
고치면 대조표 형태가 바뀌므로 별도 증분에서 판단할 일이다.

## 8. 벽시계

| 단계 | 이번 런 | PR #14 런 |
|---|---|---|
| catalog | 21s | 21s |
| stream ×3 | 25s / 25s / 25s | 25s / 25s / 25s |
| detect-anomaly | **1,233s** | 591s |
| generate-hypotheses | 482s | 465s |
| human-review | 118s | 58s |
| draft-report | 716s | 505s |
| independent-save | 4s | 4s |
| **published-comparison** | **476s** | (실패) |
| 총 | **3,126s (52.1분)** | 1,719s + 실패 |

detect-anomaly가 2배 넘게 걸렸다. 입력은 바이트 동일하므로 프롬프트 크기 요인이 아니고,
`Report/latency-root-cause-and-plan.md`가 측정한 thinking 시간 편차와 같은 성질로 보인다 —
단정하지 않는다.

## 9. 못 한 것 / 남은 것

- **Case B 재발행은 여전히 사람 판단 대기.** T1(LFP naive 시각 UTC 전환)·T3(캡 슬롯)이 Case B
  수치에 영향을 준다는 PR #14의 권고는 그대로 유효하다. zip은 이 워크트리에 있다.
- 재개 경로의 **실전 검증** — 실제 대조 실패 상황에서 돌려본 적이 없다.
- 대조 프롬프트의 케이스 무관 3행 (7절).
- FPP `DEVIATION_MW` vs `DISPATCH_UNIT_CONFORMANCE`/`TOTALCLEARED` 동일성 — 아카이브에 테이블이
  없어 여전히 미해결. 계획에서 제외한 항목이다.
- `calendarBinStart`는 여전히 머신 로컬 달력이다 (PR #14에서 이미 기록).
