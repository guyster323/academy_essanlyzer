# Case A 재실행 계획 (2026-08-31)

현재 `Report/case_a_report.html`은 **2026-08-29** 산출물로, 그 뒤 merge된 다음 작업들이
전혀 반영되어 있지 않다:

| PR | 내용 | Case A(AEMO)에 적용되는가 |
|---|---|---|
| #6 | 근거 상충 배너 + `attribution-conflict` 모듈 | 부분 — LFP 전용 지표 기반이라 AEMO에선 `cross-check-unavailable`이 정상 |
| #8 | **분석 시간축**: 시간 커버리지 측정·노출, 알람 샘플 전 구간 계층화, 파생 집계 시간 버킷, 보고서가 자기 시간축 명시 | ✅ **전면 적용** |
| #9 | 원본 해상도 스트리밍 검증 | ✅ 방법론 적용 |
| #10 | 저항 이벤트 캡 재설계 | ❌ LFP 전용 |

**즉 Case A에서 확인할 핵심은 PR #8의 시간축 작업이다.** Case B에서는 그것이
"3년 knee를 처음으로 보고서에 넣는" 결정적 개선이었는데, Case A는 성격이 다르다 —
아래 참조.

---

## 1. 입력 — 이번엔 다일(multi-day) 중첩 ZIP을 쓴다

`Log_sample/case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip` (520,040,023 bytes)은
**중첩 ZIP**이며 내부에 일자별 zip 7개가 들어 있다 (직접 확인함):

| 내부 항목 | 압축 해제 크기 |
|---|---|
| `PUBLIC_NEXT_DAY_FPPMW_20250817_*.zip` | 77,475,628 |
| `PUBLIC_NEXT_DAY_FPPMW_20250818_*.zip` | 75,877,839 |
| `PUBLIC_NEXT_DAY_FPPMW_20250819_*.zip` | 78,561,587 |
| `PUBLIC_NEXT_DAY_FPPMW_20250820_*.zip` | 78,609,774 |
| `PUBLIC_NEXT_DAY_FPPMW_20250821_*.zip` | 78,306,437 |
| `PUBLIC_NEXT_DAY_FPPMW_20250822_*.zip` | 78,900,097 |
| `PUBLIC_NEXT_DAY_FPPMW_20250823_*.zip` | 77,681,428 |

**이전 Case A 실행은 하루치를 미리 추출한 `WDBESS1_peers_20250819.csv`(3.1MB)를
썼다**(`Report/next-ranks-2-to-5.md`). 이번엔 중첩 ZIP을 그대로 올려서:

1. 중첩 ZIP 카탈로그 경로를 실제로 태우고 (README가 주장하는 기능의 검증),
2. **여러 날에 걸친 시간 커버리지**를 PR #8 기능으로 실제 확인한다.

각 항목이 20MB를 넘으므로 **「분석 포함 (스트리밍 시작)」을 눌러야** 스트리밍된다
(`CATALOG_AUTOSTREAM_THRESHOLD_BYTES = 20 * 1024 * 1024`).

**어느 날짜를 포함할지**: AEMO 공개 사건은 **2025-08-19**다. 최소한 사건일을 포함해야
하고, 시간축 기능을 의미 있게 보려면 **여러 날**을 넣는 것이 좋다. 다만 7일 전부는
약 545MB 스트리밍이라 시간이 든다. **최소 사건일 포함 + 가능하면 인접일을 함께**
넣되, 몇 개를 넣었는지와 그 이유를 findings에 기록할 것. 몇 개를 넣든
**엔티티 필터(`BESS` 자동 채움)는 사람이 지울 수 있게 보이는 상태로 유지**할 것
(`Report/next-ranks-2-to-5.md` Rank 5).

## 2. Case B와 다른 점 — 기대를 미리 정하지 말 것

Case B는 1,353일 로그였고 시간축 작업이 극적으로 작용했다. Case A는 **하루~일주일**
스케일이므로 같은 효과를 기대하면 안 된다. 오히려 확인할 것은:

- 시간 커버리지가 **정직하게 표시되는지** (짧은 구간에서도 과장 없이)
- 알람 샘플이 사건 구간(12:15–12:20)에 **몰려 있는지 퍼져 있는지** — 어느 쪽이든
  사실대로. AEMO 사건은 특정 5분에 집중된 사건이므로 **몰려 있는 것이 정상일 수 있다.**
  Case B의 "퍼져야 좋다"를 기계적으로 적용하지 말 것.
- A-F4(common-mode)가 이전처럼 `unavailable`인지, 여러 날/여러 엔티티가 들어오면서
  달라지는지
- A-F6(Dispatch Target)은 공개 FPPMW에 컬럼 자체가 없으므로 **계속 unavailable이 정답**
  (`Report/next-ranks-2-to-5.md` Rank 5). 만들어내지 말 것.

## 3. 실행 방법

`tests/e2e/regenerate-case-b.spec.js`가 이미 실제 파이프라인을 모킹 없이 구동한다
(`RUN_CASE_B=1`로만 실행, `waitForStage()`가 `.error-box`를 만나면 즉시 실패,
`selectOption()`으로 심각도 드롭다운 처리). 이를 참고해 Case A용 스펙을 만들 것
(예: `RUN_CASE_A=1` 가드). **`orca computer` 데스크톱 자동화는 쓰지 말 것.**

- **동시에 두 파이프라인을 실행하지 말 것** — 지난번 Claude 계정 quota 충돌로 한쪽이
  `You've hit your individual spend limit`으로 죽었다.
- `.env`의 `CLAUDE_CLI_TIMEOUT_MS`는 코드 기본값과 같은 30분이다. 필요하면 로컬에서만
  올리고 **코드 기본값은 바꾸지 말 것.**
- 스트리밍 + AI 3단계로 **1시간 이상**을 예상할 것. 긴 대기는 백그라운드로 돌리고 폴링.
- 429를 만나면 무리하게 재시도하지 말고 시각을 기록하고 부분 결과를 남길 것.

## 4. 사람 검토 단계

Step 4는 이 프로젝트의 핵심 게이트다. 가설을 고르고 심각도를 확정하되:

- **AI가 낸 것 중 근거가 가장 잘 뒷받침되는 것**을 고를 것. 이전 보고서의 결론
  (`PCS 유효전력 폐루프 제어 불안정(헌팅) 의심`, 심각도 `중`)에 **맞추려 하지 말 것.**
  이번 실행이 실제로 무엇을 냈는지가 기준이다.
- 심각도 근거는 이번 데이터에서 실제로 관측된 것으로 쓸 것.

## 5. 하지 말 것

- A-F6/Dispatch Target을 없는 데이터로 만들어내는 것
- 엔티티 필터를 숨기거나 고정하는 것 (사람이 지울 수 있어야 함)
- AEMO 결론을 먼저 읽고 분석을 끼워 맞추는 것 — **공개 자료 대조는 마지막에만**
- 프롬프트 예산 상수 재조정, Web Worker, GP 관련 작업
- `Report/case_b_*`를 건드리는 것

## 6. 산출물

- `Report/case_a_report.html` — 이번 실행의 독립 보고서로 교체
- (선택) 공개 결과 대조를 실행했다면 `Report/case_a_report_compared.html`도 갱신.
  대조에 쓸 발췌는 이 저장소가 정리해 둔 AEMO 참고 자료를 쓸 것
  (`Log_sample/ESS_Public_Log_Analysis_Strategy_WDBESS1_LFP.md` 940행 부근:
  *Self-Forecasting Errors and Frequency Excursion on 19 August 2025*,
  Market Notice — WDBESS1 Non-Conformance 12:15–12:20 −55 MW).
  **독립 분석이 끝난 뒤에만** 실행할 것.
- `Report/case-a-rerun-findings.md` — 무엇이 이전과 달라졌는지, 시간 커버리지 실측,
  각 Figure의 available/unavailable과 사유, 단계별 소요 시간, 못 한 것과 그 이유.

## 7. 작업 규칙

- 이 워크트리(`C:\Users\windo\ESSanalyzer-casea`, 브랜치 `feat/case-a-rerun`)에서만 작업.
  `C:\Users\windo\ESSanalyzer`와 `main`은 건드리지 말 것.
- `.env`, `npm install`, Case A zip 준비 완료.
- 작업별 커밋 분리. 기존 스타일(`fix:`/`feat:`/`docs:`).
- `npm run test:unit`, `npm run build` 통과 필수.
- 결과가 이전 보고서와 다르면 **그것이 정상**이다. 같게 만들려 하지 말 것.
