# Gold-run deliverables (2026-08-27)

| File | What |
|---|---|
| `case_a_report.html` | Orca live Case A executive HTML (A-F1–F6, 3-box, FTA). Charts are inlined PNG. |
| `case_a_report_compared.html` | Same after `/api/compare-published` vs AEMO 19 Aug 2025 excerpt. Independent findings were not rewritten. |
| `case_a_pipeline.json` | Compact JSON of headline, figures, findings. |
| `case_b_evidence.html` | Case B independent evidence after detect (B-F1–F6). Hypothesis/executive draft blocked by Claude CLI session limit. |
| `case_b_pipeline.json` | Figure catalog + window summary. |
| `next-ranks-2-to-5.md` | Remaining work re-ranked from this gold run. |
| `case_b_report.html` | Regenerated 2026-08-30 on `main` after the Rank 4 resistance-event-cap fix (PR #4) — same hypothesis/severity (Cell 8 유효 직렬저항 증가 후보, 상), but now honestly surfaces a Cell 8 (voltage-residual, B-F3) vs Cell 5 (event-resistance, B-F1/B-F4) attribution conflict that the previous, silently-truncated version could never have shown. B-F1–B-F4 inlined PNG. |
| `case_b_findings.md` | 2026-08-29: first attempt via Orca orchestration + Grok worker failed twice at Step2 detect-anomaly (600s timeout); second attempt same day, after raising the CLI timeout to 20min, succeeded end-to-end. 2026-08-30 update: report regenerated after the Rank 4 cap-bug fix — see the top section for the Cell 8/Cell 5 discrepancy this newly surfaced. |
| `rank-3-4-plan.md` | Grounded Rank 3 (CLI overhead) / Rank 4 (sys_6 cap bug) plan. |
| `rank-3-4-findings.md` | 2026-08-29: Rank 3 CLI 12.9s→5.5s (detect-anomaly with flags 700.9s, schema intact); Rank 4 sys_6 19,248,213-row UI stream in 14.2 min with late resistance events kept. |
| `rank4-sys6-progress.png` | sys_6 stream at 99% (progress bar advancing, no tab hang). |
| `rank4-sys6-stream-done.png` | sys_6 ready: 19,248,213 rows, 575,026 resistance events omitted (non-silent). |
| `pipeline-latency-plan.md` | 2026-08-30: plan (not yet implemented) to cut actual model think-time — missing `maxItems` on `anomalyWindows` (only unbounded array in `schemas.js`), `--effort` tuning, streaming UX; caching downgraded after checking that later stages don't resend raw log text. |
| `latency-root-cause-and-plan.md` | 2026-08-30: measured 700s as extended thinking (not ZIP/prompt size); tasks 6-1–6-4. |
| `latency-findings.md` | 2026-08-30: 6-1 timeout 20min; 6-2 cli still ignores maxTokens (thinking 4k–21k); 6-3 --effort not adopted (n=3, spread > gap); 6-4 per-chunk yield removed (yieldWait 29%→8% on System 6). |
| `latency-effort-outputs/` | Raw `--effort` structured outputs + COMPARISON.md for human quality judgment. |
| `latency-stream-profiles/` | Node phase profiles for stride80 CSV and System 6 ZIP, before/after yield change. |

PR: https://github.com/guyster323/academy_essanlyzer/pull/2
