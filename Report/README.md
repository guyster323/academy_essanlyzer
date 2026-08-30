# Gold-run deliverables (2026-08-27)

| File | What |
|---|---|
| `case_a_report.html` | Orca live Case A executive HTML (A-F1–F6, 3-box, FTA). Charts are inlined PNG. |
| `case_a_report_compared.html` | Same after `/api/compare-published` vs AEMO 19 Aug 2025 excerpt. Independent findings were not rewritten. |
| `case_a_pipeline.json` | Compact JSON of headline, figures, findings. |
| `case_b_evidence.html` | Case B independent evidence after detect (B-F1–F6). Hypothesis/executive draft blocked by Claude CLI session limit. |
| `case_b_pipeline.json` | Figure catalog + window summary. |
| `next-ranks-2-to-5.md` | Remaining work re-ranked from this gold run. |
| `case_b_report.html` | Regenerated 2026-08-30 after the analysis-horizon work (PR #8), superseding the post-PR#4 version. The headline now states its own evidence window and coverage (2018-10-09~2022-01-10, 87.8%) and captures the ~60x rise in anomaly density toward the end of the 3.7-year log — the multi-year degradation the earlier 7-week-window report missed entirely. Hypothesis: Cell 8 부하상관형 유효 직렬저항 증가(진행성) 후보, severity 상; the Cell 8 vs Cell 5 conflict is still flagged unresolved. B-F1–B-F4 inlined PNG. |
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
