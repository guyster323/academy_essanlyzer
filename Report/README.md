# Gold-run deliverables (2026-08-27)

| File | What |
|---|---|
| `case_a_report.html` | Orca live Case A executive HTML (A-F1–F6, 3-box, FTA). Charts are inlined PNG. |
| `case_a_report_compared.html` | Same after `/api/compare-published` vs AEMO 19 Aug 2025 excerpt. Independent findings were not rewritten. |
| `case_a_vs_aemo_log_analysis.md` | 2026-08-31: log-analysis comparison of our Case A report against AEMO's public material. Key finding: AEMO's -55 MW at 12:15 is a deviation-from-target event, ours is a -241 MW raw output change at 09:04 — different physical quantities. We cannot detect AEMO's kind of event, and the cause is not missing data: `DEVIATION_MW` is present and populated (±124.8 MW that day) but `formats.js` reads only `MEASURED_MW` and A-F6 is a hardcoded empty figure. |
| `dispatch-target-deviation-plan.md` | 2026-08-31: plan to actually use `DEVIATION_MW`/`SCHEDULED_MW` (P1), make A-F6's unavailable reason truthful (P2), measure the column identity (P3), and merge multi-source figure series (P4). |
| `dispatch-target-deviation-findings.md` | 2026-08-31: measured `DEVIATION_MW ≈ MEASURED_MW − SCHEDULED_MW` except 55 bad-quality rows. The 12:15–12:20 AEST window is −16..+5 MW, not −55; a −55-scale FPP residual sits at 12:05 and the rolling-z rule does not flag that plateau. A-F6 is now available. Did not regenerate `case_a_report.html`. |
| `case_a_pipeline.json` | Compact JSON of headline, figures, findings. |
| `case_b_evidence.html` | Case B independent evidence after detect (B-F1–F6). Hypothesis/executive draft blocked by Claude CLI session limit. |
| `case_b_pipeline.json` | Figure catalog + window summary. |
| `next-ranks-2-to-5.md` | Remaining work re-ranked from this gold run. |
| `case_b_report.html` | Regenerated 2026-08-30 from the **full-resolution** 19,248,213-row run (PR #9), superseding the stride80 version. Evidence now spans the entire 2018-04-28~2022-01-10 log: Cell 8 holds ~99% of 751,686 derived anomalies, deviation sign tracks charge/discharge current, and both frequency and magnitude climb through 2021-03~2021-12. Flags two things the downsampled run could not: a non-zero rest-state deviation (−0.038~−0.050 V) that pure ohmic resistance does not explain, and event-resistance naming **Cell 1** — left explicitly unresolved. 3 inlined PNG (B-F4 is unavailable at full resolution). |
| `case_b_report_compared.html` | Same run after `/api/compare-published` against the TU Darmstadt/MIT paper's reported values. Independent findings verified byte-identical before and after (`findingsFrozen: true`) — the comparison never overwrites them. |
| `case_b_findings.md` | 2026-08-29: first Grok-worker attempt failed twice at Step2 (600s timeout); second attempt succeeded after raising the CLI timeout. 2026-08-30: regenerated after the Rank 4 cap fix (Cell 8/Cell 5 conflict surfaced), then regenerated again after PR #8 — the top section covers the horizon result plus the concurrent-run and spend-limit problems hit along the way. |
| `rank-3-4-plan.md` | Grounded Rank 3 (CLI overhead) / Rank 4 (sys_6 cap bug) plan. |
| `rank-3-4-findings.md` | 2026-08-29: Rank 3 CLI 12.9s→5.5s (detect-anomaly with flags 700.9s, schema intact); Rank 4 sys_6 19,248,213-row UI stream in 14.2 min with late resistance events kept. |
| `rank4-sys6-progress.png` | sys_6 stream at 99% (progress bar advancing, no tab hang). |
| `rank4-sys6-stream-done.png` | sys_6 ready: 19,248,213 rows, 575,026 resistance events omitted (non-silent). |
| `pipeline-latency-plan.md` | 2026-08-30: plan (not yet implemented) to cut actual model think-time — missing `maxItems` on `anomalyWindows` (only unbounded array in `schemas.js`), `--effort` tuning, streaming UX; caching downgraded after checking that later stages don't resend raw log text. |
| `latency-root-cause-and-plan.md` | 2026-08-30: measured 700s as extended thinking (not ZIP/prompt size); tasks 6-1–6-4. |
| `latency-findings.md` | 2026-08-30: 6-1 timeout 20min; 6-2 cli still ignores maxTokens (thinking 4k–21k); 6-3 --effort not adopted (n=3, spread > gap); 6-4 per-chunk yield removed (yieldWait 29%→8% on System 6). |
| `latency-effort-outputs/` | First `--effort` suite (invalid: 7/9 empty windows). Kept as the failed measurement. |
| `latency-effort-real-outputs/` | 2026-08-30 remake with the real 54,738-char stride80 detect prompt. 4/9 valid, 5/9 429. No level adopted. |
| `latency-stream-profiles/` | Node phase profiles for stride80 CSV and System 6 ZIP, before/after yield change. |
| `evidence-conflict-and-cleanup-plan.md` | 2026-08-30: Cell 8 (voltage residual) vs Cell 5 (event resistance) must be a structural UI warning, plus follow-up profiling/docs/cleanup. |
| `evidence-conflict-and-cleanup-findings.md` | What this branch did, what it deliberately did not do, and the measured negatives. |
| `evidence-conflict-step2.png` / `evidence-conflict-step4.png` | Live UI: the Cell 8 vs Cell 5 split on anomaly view (Step 2) and at the hypothesis decision point (Step 4). |
| `evidence-conflict-no-false-positive.png` | Same banner absent on generic CSV with no conflict. |

| `case_b_swot_vs_paper.md` | 2026-08-30: SWOT of our log-based Case B analysis against the published paper's System 6 claims. Key finding: our report's evidence window is days 165-217 of a 1,353-day dataset (12-16%), while the paper's phenomenon starts ~day 500 — traced to `ALARM_SAMPLE_CAP` keeping only the earliest 40 alarm windows. |

PR: https://github.com/guyster323/academy_essanlyzer/pull/2
