# Dispatch Target 편차 분석 도입 (P1~P4) — 계획 (2026-08-31)

`Report/case_a_vs_aemo_log_analysis.md`가 남긴 개선안 P1~P4를 전부 수행한다.

**출발점**: AEMO가 실제로 문제 삼은 사건(**타깃 대비 편차**, 12:15–12:20 −55 MW)을 우리
파이프라인은 구조적으로 탐지하지 못한다. 그런데 **데이터가 없어서가 아니다** —
`DEVIATION_MW`가 같은 행에 들어 있고 값도 채워져 있다(사건일 WDBESS1 min −124.83 /
max +124.20 MW). 읽지 않을 뿐이다.

아래 코드 인용은 전부 직접 확인한 것이다.

---

## 1. 현재 상태 (확인 완료)

AEMO CSV 실제 컬럼:

```
INTERVAL_DATETIME, MEASUREMENT_DATETIME, FPP_UNITID, VERSIONNO,
MEASURED_MW, MW_QUALITY_FLAG, SCHEDULED_MW, DEVIATION_MW, PARTICIPANTID
```

그런데 코드는 이렇게 되어 있다:

| 위치 | 현재 | 문제 |
|---|---|---|
| `src/formats.js:201` `computeDerivedAlarm` | `MEASURED_MW`만 읽음 | 타깃 대비 편차 규칙이 아예 없음 |
| `src/formats.js:267` `seriesSignals` | `['mw','quality','deltaMw']` | 편차 신호가 시계열 버퍼에 없음 |
| `src/formats.js:268` `extractSeriesSample` | `{mw, quality, deltaMw}` 반환 | 위와 동일 |
| `src/figures.js:159` A-F6 | **무조건** `emptyFigure`, 사유 `이 소스에 Dispatch Target 컬럼이 없어…` | 컬럼 검사를 **하지 않는다.** 문구가 데이터가 아니라 구현에 대한 사실 |
| `src/figures.js:302` `collectSeriesContext` | `seriesByEntity[id] = frozen` | 같은 엔티티를 **나중 소스가 덮어씀** (last-write-wins) |

---

## 2. P1 — `DEVIATION_MW` / `SCHEDULED_MW`를 실제로 사용한다 (핵심)

**(a) 시계열에 편차 신호 추가**
`seriesSignals`와 `extractSeriesSample`에 `SCHEDULED_MW`·`DEVIATION_MW` 기반 신호를
추가한다. 값이 없는 행/소스에서는 안전하게 빠져야 한다(다른 AEMO 파일이 이 컬럼을
갖지 않을 수 있다 — **컬럼 존재를 가정하지 말 것**).

**(b) 파생 이상 규칙에 타깃 대비 편차 추가**
`computeDerivedAlarm`에 편차 기반 판정을 더한다. 기존 `MEASURED_MW` 통계/램프 규칙은
**그대로 두고** 추가하는 것이다 — 기존 탐지를 대체하지 말 것.
판정 사유(`reasonCode`/`reason`)로 **어느 규칙이 걸렸는지 구분 가능해야** 한다
(예: 통계 이상 vs 타깃 편차). 지금처럼 뭉뚱그리면 W1을 고쳐도 사람이 알 수 없다.

**(c) 임계값은 데이터로 정할 것**
`DEVIATION_MW`의 실제 분포를 먼저 측정하고 그 근거로 임계를 정한다.
**AEMO 수치(−55 MW, 12:15)를 threshold나 기대값으로 코드에 심지 말 것.** 그건 검증에만
쓴다. 기존 `MEASURED_MW` 규칙이 `deviationFromMedian >= 5` 같은 절대 하한과 robust
z를 함께 쓰는 방식을 참고하되, 편차 신호의 성격에 맞게 재검토할 것.

### P1 검증 기준 — 미리 정해 둔다

`Log_sample/case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip`(이 워크트리에 있음)의
**발행일 `_20250820_`** 파일(= 거래일 **2025-08-19**, AEMO NEXT_DAY 파일명은 발행일이다)로
스트리밍해서:

> **2025-08-19 12:15–12:20 AEST(= 02:15–02:20 UTC) 구간에서 WDBESS1의 −55 MW 규모
> 타깃 편차가 탐지되는가?**

- **탐지되면** W1 해소. 그 구간이 파생 이상으로 잡히고 A-F6에 보이는지 확인.
- **탐지 안 되면** 왜 안 되는지가 또 다른 발견이다 — 예를 들어 그 구간이 데이터
  커버리지 밖일 수도 있고(각 NEXT_DAY 파일은 AEST 05:00–17:00만 담는다 →
  12:15는 **범위 안**이다), `SCHEDULED_MW`가 AEMO dispatch target과 다른 값일 수도 있다.
- **어느 쪽이든 사실대로 기록할 것.** "탐지됐다"를 만들기 위해 임계를 조정하지 말 것.

## 3. P2 — A-F6의 unavailable 문구를 사실에 맞게

P1이 잘 되면 A-F6는 available이 된다. 그래도 **컬럼이 없는 소스에서는 여전히
unavailable**이어야 하고, 그때 사유는 실제 상태를 말해야 한다.

- `emptyFigure` 하드코딩을 **컬럼/신호 존재 여부 판정**으로 바꾼다.
- 사유 문구를 상황별로 구분한다(예: 편차 컬럼이 진짜 없는 경우 vs 있는데 값이 부족한
  경우). 지금처럼 항상 "컬럼이 없어"라고 말하지 말 것.

## 4. P3 — `SCHEDULED_MW`와 AEMO dispatch target의 관계 확인

이걸 모르면 P1의 해석이 흔들린다. 코드 변경 전에 **데이터로 확인**할 것:

- `MEASURED_MW − SCHEDULED_MW`가 `DEVIATION_MW`와 일치하는가? (일치하면 `DEVIATION_MW`가
  이미 타깃 편차이고, 별도 계산이 불필요하다)
- 일치하지 않으면 어떤 관계인가?
- 결과를 findings에 수치로 남길 것. **같다고 단정하지 말고 측정 결과로 말할 것.**

`SCHEDULED_MW`가 AEMO의 *dispatch target*과 동일한 개념인지는 공개 문서 없이 확정할 수
없다. **확정할 수 없으면 확정할 수 없다고 쓸 것** — 이 프로젝트의 기존 규율 그대로.
용어도 조심할 것: 확인 전까지 "Dispatch Target"이라고 단정하지 말고 관측된 컬럼명을 쓸 것.

## 5. P4 — 그림 시계열 다중 소스 병합

`src/figures.js:302`:

```js
Object.entries(block.seriesByEntity || {}).forEach(([id, frozen]) => {
  if (frozen?.bins?.length) seriesByEntity[id] = frozen;   // ← 덮어씀
});
```

여러 날을 스트리밍해도 **A-F1이 마지막 파일만 그린다**(PR #11 findings에 기록됨).
PR #8 시간축 작업의 취지와 어긋난다.

- 같은 엔티티의 bins를 **시간순으로 병합**할 것. `src/series-engine.js`에 이미
  `MAX_SERIES_POINTS` 상한과 `pairwiseMerge` 재빈닝이 있으니 그걸 써서 **상한을 넘기지
  않게** 할 것.
- 병합 후에도 시간 순서·`MAX_SERIES_POINTS` 상한이 지켜지는지 유닛 테스트로 고정.
- 소스 간 시간 구간이 겹치거나 비어 있을 수 있다(NEXT_DAY는 하루 12시간만 담고 사이가
  빈다). **빈 구간을 보간해 채우지 말 것** — 없는 데이터를 만들어내는 것이다.

---

## 6. 하지 말 것

- AEMO 수치(−55 MW, 12:15, 19 Aug)를 threshold·기대값·테스트 고정값으로 코드에 심기
- 원하는 탐지 결과가 나오도록 임계값 조정 (임계는 데이터 분포로 정한다)
- 기존 `MEASURED_MW` 통계/램프 탐지를 대체·약화하는 것 (추가하는 것이다)
- A-F6를 그럴듯한 값으로 채우는 것 — 신호가 없으면 unavailable이 정답
- 시계열 빈 구간 보간
- 프롬프트 예산 상수 재조정, Web Worker, GP 관련 작업
- `Report/case_b_*` 수정

## 7. 검증

- `npm run test:unit`, `npm run build` 통과
- 유닛 테스트: 편차 규칙(걸림/안 걸림), 컬럼 없는 소스에서 A-F6 unavailable + 사유,
  다중 소스 시계열 병합(순서·상한), 기존 `MEASURED_MW` 탐지 회귀 없음
- **실데이터 검증**: 위 P1 검증 기준. 사건일 파일로 스트리밍해 12:15–12:20 구간 결과를
  수치로 기록
- P3의 `MEASURED_MW − SCHEDULED_MW` vs `DEVIATION_MW` 대조 수치

## 8. 산출물

- `Report/dispatch-target-deviation-findings.md` — P1 검증 결과(탐지 여부와 수치),
  P3 대조 수치, P4 병합 전후, 못 한 것과 그 이유.
- **`Report/case_a_report.html` 재발행은 하지 말 것.** 결과가 유의미하면 findings에
  권고만 남기고 사람이 판단한다 (PR #9~#11과 같은 규율).

## 9. 작업 규칙

- 이 워크트리(`C:\Users\windo\ESSanalyzer-target`, 브랜치
  `feat/dispatch-target-deviation`)에서만 작업. `C:\Users\windo\ESSanalyzer`와 `main`은
  건드리지 말 것.
- `.env`, `npm install`, Case A zip 준비 완료.
- P3 → P1 → P2 → P4 순서를 권장한다 (P3가 P1의 해석 근거를 준다).
- 작업별 커밋 분리. 기존 스타일(`fix:`/`feat:`/`docs:`).
- 라이브 AI 단계는 **필수가 아니다.** 파생 이상·A-F6·시계열 병합은 전부 클라이언트
  계산이므로 스트리밍만으로 검증된다. AI 없이 검증할 수 있으면 그렇게 할 것.
- 동시에 두 파이프라인을 실행하지 말 것.
- 정기 하트비트를 보내지 말 것 — 사용자 터미널에 알림이 뜬다. 에스컬레이션과 최종
  `worker_done`만 보낼 것.
