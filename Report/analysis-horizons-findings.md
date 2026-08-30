# Analysis time horizons — findings (2026-08-30)

Plan: `Report/analysis-horizons-plan.md`. Branch `feat/analysis-horizons`.
Worktree only; `C:\Users\windo\ESSanalyzer` and `main` were not touched.

`npm run test:unit` 136/136, `npm run build` green.
Playwright `tests/e2e/analysis-horizons.spec.js` (desktop-chromium) green
against `Log_sample/extracted/data_sys_6_stride80.csv`.

Raw stride80 dump: `Report/analysis-horizons-stride80.json`.
Prompt excerpt captured from the live detect-anomaly request:
`Report/analysis-horizons-prompt-excerpt.txt`.

---

## 1. What shipped

| task | commit | what |
|---|---|---|
| T1 | `feat: measure data vs alarm-evidence time coverage` | min/max timestamps while streaming; `sourceProfiles.dataTimeRange` vs `evidenceTimeRange` kept separate; `<20%` notice in prompt and UI; `figureCatalog.timeRange` |
| T2 | `feat: sample alarm contexts across the full time span` + `fix: fill alarm samples by time-stratum quota` | replaced first-40 with equal-width data-span quotas (8 strata); full `CONTEXT_WINDOW` kept; drop count + histogram exposed |
| T3 | `feat: aggregate outlier-cell counts by time bucket` | capped online histogram (`MAX_CATEGORY_TIME_BUCKETS=24`) of `outlierCell` |
| T4 | `feat: require reports to state their evidence time horizon` | draft-report prompt gets ranges as fact; concentrated evidence must be named in headline/rootCause; missing long-horizon → `unknownBox` |

GP/BattGP was not implemented. Paper day numbers (500 / 800 / 1095 / 3-year)
are not in code. Short-term context windows were not thinned.

---

## 2. stride80 observations (required e2e)

File: 240,603 rows, 9,366 derived alarms, 40 kept alarm-context windows
(9,326 dropped, counted).

### (1) Alarm evidence is no longer confined to late 2018

| | before (first-40, SWOT) | after T2 |
|---|---|---|
| evidence range | 2018-10-10 .. 2018-12-01 (days 165–217 of 1,353) | **2018-10-09 .. 2022-01-10** |
| coverage vs data span | ~4–16% | **87.8%** |
| years in kept samples | 2018 only | **2018, 2019, 2020, 2021, 2022** |

Data span is 2018-04-28 .. 2022-01-10. The 12.2% not covered is
**2018-04-28 .. 2018-10-09** — months of log *before the first derived
alarm*, not a sampling hole. The 20% warning correctly does **not** fire.

Kept-sample histogram over the data span (8 buckets):

| bucket | count |
|---|---|
| 2018-04-28 .. 2018-10-14 | 1 |
| 2018-10-14 .. 2019-04-01 | 6 |
| 2019-04-01 .. 2019-09-17 | 7 |
| 2019-09-17 .. 2020-03-04 | 6 |
| 2020-03-04 .. 2020-08-20 | 7 |
| 2020-08-20 .. 2021-02-06 | 3 |
| 2021-02-06 .. 2021-07-25 | 5 |
| 2021-07-25 .. 2022-01-10 | 5 |

The first bucket has one sample because derived alarms only start on
2018-10-09. Interior 2019–2021 buckets are filled. This is the opposite of
the first-40 policy.

Each kept window still has up to 5 surrounding rows (`CONTEXT_WINDOW`).

Screenshots: `Report/analysis-horizons-intake.png`,
`Report/analysis-horizons-coverage-card.png`.

### (2) Time coverage is visible in the UI and the prompt

UI (intake source card after stream, and Step 2 `시간 커버리지` panel):

- 데이터 구간 2018-04-28 ~ 2022-01-10
- 알람 근거 구간 2018-10-09 ~ 2022-01-10 · 커버리지 87.8%
- 유지 샘플 분포 across 2018–2021
- 알람 컨텍스트 9,326건 생략(시간 계층화 유지)

Prompt (`combinedLogText` of the real detect-anomaly request):

```
- 데이터 시간 범위: 2018-04-28 ~ 2022-01-10
- 알람 근거 시간 범위: 2018-10-09 ~ 2022-01-10 (커버리지 87.8%)
- 유지된 알람 샘플 시간 분포: 2018-04-28:1, 2018-10-14:6, … 2021-07-25:5
- 알람 컨텍스트 생략: 9,326건 (시간 계층화 유지)
```

`sourceProfiles` carries the two ranges as separate objects plus
`timeCoverageRatio: 0.878…`. Figures: B-F1/B-F2/B-F4 timeRange
2018-10-09 .. 2022-01-06; B-F3 2018-04-27 .. 2022-01-09 (full series);
B-F5/B-F6 have no time axis.

Screenshots: `Report/analysis-horizons-anomaly.png`,
`Report/analysis-horizons-anomaly-panel.png`.
Prompt: `Report/analysis-horizons-prompt-excerpt.txt`.

### (3) outlierCell over time — Cell 8 does **not** change

Whole-log: Cell 8 9,271 / 9,366 (99%), then Cell 3 45, Cell 1 40, Cell 5 6,
Cell 7 4.

Every time bucket's top cell is **Cell 8**. The attribution is robust
across the span. That is the result; it is not a miss.

Alarm *volume* does change: ~11–60 per ~2-month bucket in 2018–early 2020,
then 106 → 161 → 182 → 394 → 1,080 → 2,262 → **3,708** through 2021.
Secondary cells (1, 3, 5) appear from 2021-03 onward but never overtake
Cell 8 (e.g. 2021-10-01 .. 2021-12-04: Cell 8 3,708, Cell 1 25, Cell 3 4).

Screenshot: `Report/analysis-horizons-outlier-over-time.png`.

This is enough to test the paper's "different cell later" story against
*this* log: Vdev outlierCell does not migrate. (Event-resistance still
names Cell 5 on B-F1; that conflict is unchanged.)

---

## 3. T4 prompt rules (no live report stage)

`buildDraftReportPrompt` now includes a `[시간 커버리지 — 사실 기록]`
block with the two ranges and:

- name the evidence window in headline/rootCause when it is a subset
- `unknownBox`: long-term behavior unverified if the log is months–years
  and evidence is a short window
- do not instruct a conclusion; do not treat figure `timeRange` as the
  alarm-evidence range

Verified by unit tests. A live Claude draft-report was **not** run (one
AI stage is 3–10+ min; detect-anomaly was mocked so the e2e could capture
the real client-built prompt and figures). The payload the model would
see is in the excerpt above.

On *this* stride80 run, coverage is 87.8% over 2018-10 .. 2022-01, so the
"narrow window presented as whole-span" failure mode is gone. The
2018-04 .. 2018-10 pre-alarm stretch is still a fact the report should
not paper over; T4 tells the model to say so rather than inventing a
long-horizon conclusion.

---

## 4. What was not done, and why

- **No GP/BattGP.** B-F5 stays unavailable, as required.
- **No live report/hypothesis AI call.** Instrumentation, sampling, UI,
  and prompt text were verified against the real CSV. Generated prose
  under T4 was not sampled from Claude.
- **No paper thresholds in code.** Day-500 / 3-year are not expected
  values. The 2021 volume rise is visible in `categoryTimeBuckets` for a
  human to compare to the paper; the app does not label it a knee.
- **First histogram bucket is sparse (1 sample).** Derived alarms do not
  exist in 2018-04 .. 2018-10. Quota cannot invent samples.
- **`scripts/measure-time-coverage.mjs`** dumps the same numbers without
  a browser; used to write this file.

---

## 5. Screenshots

| file | what |
|---|---|
| `Report/analysis-horizons-intake.png` | source card after stride80 stream |
| `Report/analysis-horizons-coverage-card.png` | data vs evidence range + histogram |
| `Report/analysis-horizons-outlier-over-time.png` | Cell 8 in every bucket |
| `Report/analysis-horizons-anomaly.png` | Step 2 with 시간 커버리지 panel |
| `Report/analysis-horizons-anomaly-panel.png` | panel close-up |
