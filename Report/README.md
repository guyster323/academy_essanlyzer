# Gold-run deliverables (2026-08-27)

| File | What |
|---|---|
| `case_a_report.html` | Orca live Case A executive HTML (A-F1–F6, 3-box, FTA). Charts are inlined PNG. |
| `case_a_report_compared.html` | Same after `/api/compare-published` vs AEMO 19 Aug 2025 excerpt. Independent findings were not rewritten. |
| `case_a_pipeline.json` | Compact JSON of headline, figures, findings. |
| `case_b_evidence.html` | Case B independent evidence after detect (B-F1–F6). Hypothesis/executive draft blocked by Claude CLI session limit. |
| `case_b_pipeline.json` | Figure catalog + window summary. |
| `next-ranks-2-to-5.md` | Remaining work re-ranked from this gold run. |
| `case_b_report.html` | 2026-08-29 Case B executive HTML (B-F1–B-F4 inlined PNG). Hypothesis: Cell 8 유효 직렬저항 증가 후보(전류방향 연동), severity 상. Published after raising `CLAUDE_CLI_TIMEOUT_MS` to 1200000. |
| `case_b_findings.md` | 2026-08-29: first attempt via Orca orchestration + Grok worker failed twice at Step2 detect-anomaly (600s timeout). Second attempt same day, after raising the CLI timeout to 20min, succeeded end-to-end and produced `case_b_report.html`. |

PR: https://github.com/guyster323/academy_essanlyzer/pull/2
