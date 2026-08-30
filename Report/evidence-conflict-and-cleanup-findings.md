# Evidence-conflict UI + cleanup — findings (2026-08-30)

Plan: `Report/evidence-conflict-and-cleanup-plan.md`. Branch
`feat/evidence-conflict-ui-and-cleanup`. Worktree only; `C:\Users\windo\ESSanalyzer`
and `main` were not touched.

`npm run test:unit` 122/122, `npm run build` green.

---

## 1. Evidence-conflict UI — done

Two attributions already existed at runtime. Nothing new is computed.

| side | source | stride80 numbers (this worktree) |
|---|---|---|
| voltage residual | `derived.categoryCounts.outlierCell` | **Cell 8**, 9,271 / 9,366 (99%) |
| event resistance | `B-F1.summaryStats` | **Cell 5**, ΔR=6.333e-5, matched 1,330, drop 51,677, events 4,000 |

Module: `src/attribution-conflict.js`. Not inlined into `figures.js` or `render.js`.

Three states, unit-tested:

- **conflict** — both present and different cells
- **cross-check-unavailable** — one or both sides missing (including a tied
  voltage-residual top count). This is not a conflict.
- **agreement** — both present and the same cell (`8` vs `"Cell 8"` normalize)

The banner renders **only** on conflict (no false positives). It sits:

- Step 2 (`renderAnomalyView`) above the evidence figures
- Step 4 (`renderHypothesisView`) immediately under the human-review
  checkpoint and **above** the hypothesis radios

Both sides are shown with equal weight (voltage residual left, event
resistance right — method identity, not a ranking). Copy states what each
method can and cannot prove. The app does not auto-resolve, pre-select,
sort as ranked, or disable radios.

`buildDraftReportPrompt` receives the conflict object when present. The
prompt states the two numbers as fact and says it does not instruct a
conclusion.

### Verification

- Unit tests for the three states, plus a stride80 integration test that
  streams the real CSV and asserts Cell 8 vs Cell 5.
- Playwright against `Log_sample/extracted/data_sys_6_stride80.csv` with
  detect-anomaly/hypotheses mocked (figures are built client-side from the
  file, so the split is real):
  - Step 2 and Step 4 banners: `Report/evidence-conflict-step2.png`,
    `Report/evidence-conflict-step4.png`
  - Radios stay enabled; none are pre-checked
  - Generic CSV: banner absent (`Report/evidence-conflict-no-false-positive.png`)

First Playwright pass reused port 5173 from the **sibling** checkout
`C:\Users\windo\ESSanalyzer` (stale bundle, no banner). `playwright.config.js`
now accepts `PW_PORT` so this worktree can pin its own Vite. That is a
test-infra change, not a product change.

### Deliberately not done

- No auto-pick of Cell 8 or Cell 5
- No blocking of hypothesis selection
- No bypass of the human-review checkpoint
- Conflict is not shown for "one side missing" — that would be a false
  conflict
- `generate-hypotheses` prompt was not given the conflict object (the plan
  only recommended `buildDraftReportPrompt`)

---

## 2. `feedLine` profile — measured, not optimized

`scripts/profile-stream.mjs` now records parse / derived / series /
forensics / stats inside `feedLine` when a profile object is passed.
Production `feedLine(acc, line)` is unchanged.

stride80 (`Report/latency-stream-profiles/csv-stride80-feedline-sub.profile.json`):

| phase | ms | % of 9.8 s wall |
|---|---|---|
| feedLine (total) | 8763 | 89.9 |
| · computeDerivedAlarm | 2841 | 29.1 |
| · series pushSample | 1981 | 20.3 |
| · stats / row object | 1642 | 16.8 |
| · collectForensics | 1592 | 16.3 |
| · CSV parse | 531 | 5.4 |
| yieldWait | 816 | 8.4 |

Identity check on the same run: **240,603 rows, 9,366 derived alarms**.

No single callee is a 60%+ hotspot. Derived is the largest slice (~29% of
wall) but rewriting `computeDerivedAlarm` (median/MAD per row) would be a
value-sensitive change without a measured before/after of a specific
patch. **No optimization was applied. No Web Worker.**

System 6 ZIP was not re-profiled here (the zip is not in this worktree).
The 89.9% feedLine share matches the earlier ZIP finding; the internal mix
above is from stride80 CSV only.

---

## 3. `--effort` remeasure — real prompt, then 429

Previous `Report/latency-effort-outputs/` used a ~200-character summary.
7/9 runs returned empty windows. That comparison is invalid.

This run: `node scripts/measure-cli-latency.mjs --suite effort-real`

- Prompt: 54,738 chars (`Report/latency-effort-real-outputs/detect-anomaly-real-prompt.txt`)
- Interleaved low/medium/high × 3
- Valid = structured_output + `anomalyWindows.length > 0` + not "log not attached"

| | n |
|---|---|
| attempted | 9 |
| valid | 4 |
| excluded | 5 (all `api_error_status: 429`, spend limit, 2.9–4.6 s, 0 tokens) |

Valid walls (s): low 732.7 / 1139.8, medium 707.8, high 820.7.
Every valid run produced 15 or 16 windows. Thinking was 87–94% of output
tokens. generate-hypotheses also 429; not retried.

**No quality judgment. No effort level adopted.** Numbers:
`Report/latency-effort-real-outputs/COMPARISON.md`.

---

## 4. Doc consistency — done

- `Report/next-ranks-2-to-5.md`: ranks 2–4 marked done. Original Rank 3
  "shrink the detect prompt" sentence is still there, with a correction
  that thinking time (not input size) is the bottleneck.
- `Report/pipeline-latency-plan.md`: superseded pointer at the top.
  `maxItems` is not the 700 s cause.
- `Report/README.md`: new rows for this plan, screenshots, real-effort
  outputs, findings.

---

## 5. Small cleanups — done

- `anomalyWindows` `maxItems: 16` (Case B gold run produced 16). Overflow
  is sliced to 16 and `truncation.droppedAnomalyWindows` is set; the UI
  and `buildTruncationNote` mention the drop. Not silent. Not treated as
  the latency fix.
- `src/figures.js`: `unavailableReasonWhen(available, reason)` after
  pinning A-F4 / B-F3 available↔reason with unit tests. B-F4 still keys
  the reason off `knee.available`, matching previous behavior.
- `src/pipeline.js`: `SNAPSHOT_DROP_FROM_SOURCE` and
  `SNAPSHOT_DROP_FROM_BUCKET` are the only two omit lists.

---

## Commits (not squashed)

1. `feat: surface voltage-residual vs event-resistance cell conflict in the UI`
2. `docs: mark ranks 2-4 done and point at the corrected latency diagnosis`
3. `docs: measure feedLine internals; leave unoptimized because cost is split`
4. `fix: cap anomalyWindows, share figure availability helper, unify snapshot omit lists`
5. `docs: remeasure --effort with the real stride80 detect prompt`
6. `docs: record evidence-conflict UI and cleanup findings`
