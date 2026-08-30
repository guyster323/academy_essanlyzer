# 원본 해상도 저항 이벤트 + 공개 결과 대조 — 계획 (2026-08-30)

`Report/case_b_swot_vs_paper.md`의 P3·P5. 방금 재발행한 `Report/case_b_report.html`이
**스스로 다음에 무엇을 해야 하는지 적어 두었고**, 이 계획은 그걸 실행한다.

> 보고서 「조치」 항목 원문: "저항 이벤트(B-F1) 원본 51,677건 중 생략된 상세 구간을
> **복원하여** Vdev-Cell8과 저항-Cell5 지목 결과의 시간적·Cell별 일치 여부를
> **교차검증해야 한다**"

---

## 1. 왜 지금 이게 최우선인가

재발행된 보고서에도 **Cell 8(전압 잔차) vs Cell 5(이벤트 저항) 불일치가 미해결로 남아
근본원인 셀 확정을 막고 있다.** 그런데 이 불일치가 진짜 물리 현상인지, 아니면 우리가
쓴 입력 데이터의 아티팩트인지 **아직 아무도 확인하지 않았다.**

의심할 근거가 구체적이다:

- 지금까지 모든 Case B 분석의 입력은 `data_sys_6_stride80.csv` — **1/80 다운샘플**이다.
- `src/forensics/lfp.js`의 `considerResistanceEvent`는 **연속한 두 행의 전류 전이(ΔI)**
  로 저항을 추정한다(`LFP_DI_THRESHOLD` 이상일 때만 이벤트로 인정).
- 80행 중 79행을 버리면 그 전이 구조 자체가 성립하지 않는다. 실제로 B-F1의 매칭 통과가
  **1,330/4,000**에 그쳤고 **51,677건이 drop**됐다.
- 즉 **Cell 5 지목은 "전이가 살아남은 극히 일부 구간"에서만 계산된 결과일 수 있다.**

그리고 이걸 확인할 조건이 **이미 다 갖춰져 있다**:

- 원본 zip이 이 워크트리에 있다: `Log_sample/case_b_field_data.zip` (1,668,409,464 bytes,
  내부 `field_data/data_sys_6.csv` 압축 해제 시 2.89GB)
- Rank 4에서 **1,924만 행 전체 스트리밍이 14.2분에 완주**하고 탭도 멈추지 않는 것을
  이미 검증했다(`Report/rank-3-4-findings.md`).

**어느 결과가 나와도 가치가 있다**: Cell 5가 사라지면 다운샘플 아티팩트였다는 뜻이고,
남으면 진짜 두 번째 이상 셀이라는 뜻이다. **결론을 미리 정하지 말 것.**

---

## 2. T1 — 원본 해상도로 저항 이벤트 재계산 (핵심)

`Log_sample/case_b_field_data.zip`을 실제 UI로 업로드하고, 카탈로그된
`field_data/data_sys_6.csv`에서 **「분석 포함 (스트리밍 시작)」**을 눌러 전 구간을
스트리밍한 뒤, stride80 결과와 나란히 비교한다.

비교할 값 (stride80 기준값은 `Report/case_b_report.html`과
`Report/analysis-horizons-stride80.json`에 있다):

| 항목 | stride80 | 원본 해상도 |
|---|---|---|
| 행 수 | 240,603 | 19,248,213 (Rank 4 실측) |
| B-F1 `outlierCell` | **Cell 5** | ? |
| B-F1 `matchedCount` / `eventCount` | 1,330 / 4,000 | ? |
| `droppedEvents` | 51,677 | ? |
| B-F4 knee 시점 | 2018-11-24 | ? |
| Vdev `outlierCell` | Cell 8 (9,271/9,366, 99%) | ? |
| 근거 상충 상태 | `conflict` | ? |

**주의**: 저항 이벤트 캡은 `MAX_RESISTANCE_EVENTS=4000`이고, PR #4 이후 "초기 기준선
2000 + 최근 창 2000"으로 유지된다. 원본 해상도에서는 drop이 51,677건보다 **훨씬**
커질 것이다(Rank 4에서 575,026건 관측). 그 자체는 정상이며, **drop 수치를 줄이려고
캡을 임의로 올리지 말 것** — 메모리 상한은 의도된 설계다. 다만 이번 비교에서 캡이
결론에 영향을 주는지는 반드시 함께 기록할 것.

**하지 말 것**: `MAX_RESISTANCE_EVENTS`나 `LFP_DI_THRESHOLD` 등 임계값을 결과가
"보기 좋게" 나오도록 조정하는 것. 조정이 필요하다고 판단되면 **그 근거를 먼저 측정으로
제시**하고 findings에 남길 것.

### 검증 기준

- 원본 스트리밍이 완주하고(탭 정지·크래시 없음) 행 수가 19,248,213으로 나오는지
- B-F5/GP-BattGP가 여전히 `unavailable`인지 (Vdev로 추정 금지 — `docs/verification/
  gold-case-acceptance.md`)
- 위 표를 채운 실측 비교
- **결론**: Cell 8/Cell 5 불일치가 (a) 해소됐는지 (b) 그대로인지 (c) 다른 양상으로
  바뀌었는지를 **사실대로** 기록. 어느 쪽이든 정당한 결과다.

## 3. T2 — 공개 결과 대조를 Case B에 실행 (이미 만들어 둔 기능)

`buildPublishedComparisonPrompt` / `runPublishedComparison()`은 **이미 구현되어 있고
Case A에서는 실제로 쓰였다**(`Report/case_a_report_compared.html`). 그런데 **Case B에는
한 번도 실행한 적이 없다.**

- 보고서 생성 후 UI의 **「공개 결과와 대조」** 패널(`#publishedExcerpt` textarea →
  `runPublishedComparison()`)에 논문 주장을 붙여넣고 실행한다.
- 붙여넣을 발췌는 `Log_sample/ESS_Public_Log_Analysis_Strategy_WDBESS1_LFP.md` 13절에
  정리된 논문 보고값을 쓸 것:
  Equivalent Full Cycles 약 1,446 / Max age 약 1,352일 / Cell 8 resistance가 타 셀보다
  높음 / 약 3년 이후 resistance knee / Cell 8 fault probability는 약 500일 이후 증가 /
  약 800일 직전 0.5 초과.
- **이 단계는 반드시 독립 분석이 끝난 뒤에 실행한다.** 논문 값을 먼저 읽고 분석을
  끼워 맞추면 이 프로젝트의 전제가 무너진다. 순서를 지킬 것.
- 결과 대조표를 포함한 HTML을 `Report/case_b_report_compared.html`로 저장할 것
  (Case A의 `case_a_report_compared.html`과 같은 명명).
- `buildPublishedComparisonPrompt`는 **독립 findings를 덮어쓰지 않도록** 이미 설계되어
  있다. 그 성질이 유지되는지 확인할 것.

## 4. 실행 방법 — 새로 만든 Playwright 스펙을 재사용/확장할 것

`tests/e2e/regenerate-case-b.spec.js`가 이미 실제 파이프라인을 모킹 없이 구동한다
(`RUN_CASE_B=1`로만 실행, `waitForStage()`가 `.error-box`를 만나면 즉시 실패).
**`orca computer` 데스크톱 자동화를 쓰지 말 것** — 창 ID stale, 네이티브 `<select>`
문제로 과거에 몇 시간을 소모했고, Playwright의 `selectOption()`이 그걸 대체한다.

이 스펙을 참고해 원본 zip 업로드용 변형(또는 파라미터화)을 만들 것.

### 타임아웃·자원 주의 (지난 실행에서 실제로 겪은 것)

- **동시에 두 번 실행하지 말 것.** 지난 재발행 때 두 실행이 같은 Claude 계정 quota를
  동시에 소비해 한쪽이 `You've hit your individual spend limit`으로 죽었다.
- `.env`의 `CLAUDE_CLI_TIMEOUT_MS`는 현재 코드 기본값과 같은 30분이다. 이번 작업에서
  필요하면 로컬에서 올리되(예: 5400000), **코드 기본값은 바꾸지 말 것.**
- 원본 zip 스트리밍만 14분 이상, AI 3단계가 각 5~19분이므로 **전체 1시간 이상**을
  예상할 것. 긴 대기는 백그라운드로 돌리고 폴링할 것 — 포그라운드 20분짜리 명령은
  도구 타임아웃에 걸린다.
- 429(지출 한도)를 만나면 **무리하게 재시도하지 말 것.** 몇 시에 막혔는지 기록하고,
  얻은 부분 결과라도 남길 것.

## 5. 하지 말 것

- GP/BattGP 구현 (B-F5는 계속 `unavailable`)
- 논문 수치를 threshold·기대값으로 코드에 심는 것
- B-F5/GP-BattGP를 Vdev 등으로 추정·백필하는 것
- 결과가 원하는 방향으로 나오게 임계값을 조정하는 것
- 프롬프트 예산 상수 재조정, Web Worker 도입

## 6. 산출물

- `Report/case_b_report_compared.html` (T2)
- `Report/full-resolution-and-comparison-findings.md` — T1 비교표(실측값 전부), T2 대조
  결과, 그리고 **불일치가 해소됐는지에 대한 결론**. 못 한 것과 그 이유도 쓸 것.
- 원본 해상도 결과가 stride80과 유의미하게 다르면, `Report/case_b_report.html` 재발행
  여부는 **사람이 판단하도록 findings에 권고만 남기고 임의로 덮어쓰지 말 것.**

## 7. 작업 규칙

- 이 워크트리(`C:\Users\windo\ESSanalyzer-fullres`, 브랜치
  `feat/full-resolution-resistance`)에서만 작업. `C:\Users\windo\ESSanalyzer`와 `main`은
  건드리지 말 것.
- `.env`, `npm install`, `Log_sample/case_b_field_data.zip`,
  `Log_sample/extracted/data_sys_6_stride80.csv` 모두 준비되어 있다.
- 작업별 커밋 분리. 기존 스타일(`fix:`/`feat:`/`docs:`).
- `npm run test:unit`, `npm run build` 통과 필수.
- 시간이 부족하면 **T1을 확실히 끝내는 편**이 낫다 — 불일치 해소가 이번 작업의 목적이고
  T2는 이미 있는 기능을 한 번 돌리는 것이다.
