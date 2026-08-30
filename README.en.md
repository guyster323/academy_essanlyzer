<p align="center">
  <a href="README.md">🇰🇷 한국어</a> · <strong>🇺🇸 English</strong>
</p>

<p align="center">
  <a href="docs/GETTING_STARTED.en.md"><strong>🔰 New here? Read the Beginner's Guide first →</strong></a>
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%5E20.19%20%7C%20%3E%3D22.12-339933?logo=node.js&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white">
  <img alt="Claude" src="https://img.shields.io/badge/AI-Claude-D97757?logo=anthropic&logoColor=white">
  <img alt="Status" src="https://img.shields.io/badge/status-internal%20PoC-yellow">
</p>

<p align="center">
  <img src="docs/assets/demo-case-b-hero.gif" alt="Case B (Darmstadt LFP) analysis demo" width="720">
</p>

<p align="center">
  ▶️ <a href="docs/assets/demo-case-b.mp4">Watch the full demo (MP4, 38s edit)</a> —
  upload through anomaly detection, hypothesis, human review, and report. Real elapsed time is
  ~15 min on the built-in sample and ~29–36 min on gold Case B; waits in this clip are cut.
</p>

---

# ESS BMS Issue Analysis Workstation

A semi-automated workstation for LG Energy Solution's ESS Analysis team, built around
CS-request-driven BMS/EMS issue analysis. A human makes every consequential call (which
hypothesis, what severity); the AI only ever produces drafts (anomaly window detection →
root-cause hypotheses → report/email). That human-review checkpoint is never skipped, no
matter what feature gets added on top. When two methods disagree (for example voltage
residual pointing at Cell 8 while event resistance points at Cell 5), the app does not
pick a winner. It does not decide for the engineer — it makes sure the engineer sees every
basis for deciding.

> This document is the technical reference for developers already familiar with the
> project structure. If this is your first time here, read the
> [Beginner's Guide](docs/GETTING_STARTED.en.md) first.

## Architecture

```
Browser (src/)                          Backend (server/)
├─ ZIP / nested-ZIP catalog + streaming  ├─ /api/detect-issues
│  parsing (files stay local — no        ├─ /api/detect-anomaly
│  upload of raw logs)                   ├─ /api/generate-hypotheses
├─ Automatic log-format detection        └─ /api/draft-report
│  (generic CSV / AEMO MMS /                → AI_PROVIDER=cli (default, demo) | api (production)
│   LFP cell-array)
├─ Entity (e.g. BESS) filter + group aggregation
└─ Only stats/sample/alarm context ever leave the browser
```

- **Raw log files never leave the browser.** Parsing streams in 4MB chunks, so no matter
  the file size (500MB+, even a 3GB+ archive with a zip nested inside a zip), the prompt
  sent to the AI stays a fixed size — stats, head samples, and alarm-context windows only.
- The backend only ever assembles a prompt from aggregates the frontend already computed
  and calls the AI — it never receives the raw log.

### AI invocation (demo vs. production)

Switched via `AI_PROVIDER` in `.env`.

| Value | Behavior | Requires | Implementation |
|---|---|---|---|
| `cli` (default) | Shells out to a locally installed **Claude Code CLI** (`claude -p`) as a subprocess | `claude` installed and logged in on this machine (reuses your subscription auth — no separate API key/billing) | `server/lib/claude-cli.js` |
| `api` | Calls the Anthropic Messages API directly via the SDK (metered, pay-per-token) | `ANTHROPIC_API_KEY` in `.env` | `server/lib/anthropic.js` |

Both paths enforce structured output using the same JSON Schema in `server/lib/schemas.js`
(`api` uses strict tool-use, `cli` uses the `--json-schema` flag). The route layer
(`server/lib/ai-provider.js`) branches purely on `AI_PROVIDER`, so the rest of the codebase
never knows which provider is active.

`cli` mode spins up a fresh Claude Code harness per call, so it's slower than calling the
API directly. The format-aware prompts (cross-referencing derived statistics, distinguishing
evidence tiers, requiring disconfirming evidence) ask for materially more rigorous reasoning
than a plain scan. Measured 2026-08-30 (`AI_PROVIDER=cli`): the beginner's-guide built-in
sample (10-row generic CSV) took 214.3s / 318.6s / 340.7s per call (detect-anomaly /
generate-hypotheses / draft-report; 873.6s ≈ 14.6 min combined). Gold Case B
(`Log_sample/extracted/data_sys_6_stride80.csv`, 240,603 rows) took 707.8–1,139.8s for
detect-anomaly (previously measured, not re-run today —
`Report/latency-effort-real-outputs/COMPARISON.md`) and 557.4s / 485.6s today for
hypotheses / draft-report — about 29–36 min end-to-end. Quoting only the sample would hide
the large-log path, so both are listed. Why it is slow: extended thinking is 87–94% of
output tokens on valid runs (`Report/latency-findings.md`). If the elapsed-time counter is
still climbing, the call is healthy, not frozen. The timeout default is 30 minutes
(`CLI_TIMEOUT_MS` = `1_800_000` in `server/lib/claude-cli.js`). The loading screen shows a
live elapsed-time counter and staged status messages so a slow-but-healthy call never reads
as frozen. On the
rare occasion the model returns a response that only satisfies the schema shape but not its
substance (e.g. every field literally `"test"`), `server/lib/validation.js` rejects it and
`server/routes/analysis.js` retries once automatically for that class of 502 failure.

## Supported log formats

| Format | Detected by | Notes |
|---|---|---|
| Generic CSV/TSV | First line is a header, followed by data rows | Typical BMS/EMS export |
| AEMO MMS report | `C,` (comment) / `I,` (header) / `D,` (data) record types | Real columns start at the 4th field |
| LFP cell-array field CSV | `Timestamp` + `U_Battery` + `U_Cell_1..8` header | One file = one system; computes cross-cell derived metrics |

For AEMO, entities are grouped by the physical asset identifier `FPP_UNITID`, prioritized
over the market-participant company code `PARTICIPANTID`. `MW_QUALITY_FLAG != 1` is kept as
a secondary quality signal, while a separate rolling mean/std, MAD robust z-score, and ramp
detector runs over the whole `MEASURED_MW` series so output events are caught even when the
quality flag looks normal. An entity whose value contains `BESS` auto-fills the filter box
(editable). Verified live against the real public WDBESS1 data (2025-08-19, 497MB): 534
independent anomalies were flagged without relying on `MW_QUALITY_FLAG` or the publicly known
incident window at all.

LFP cell-array data has no static alarm column, and that's treated as expected rather than a
gap: for every row, each cell's `Vdev_i = U_Cell_i - robust_center(the other 7 cells)`, a
robust z-score, and `U_Battery - Σ(U_Cell_i)` are computed. The most-deviating cell is chosen
from the data — Cell 8 is never hardcoded as the assumed target. All derived statistics and
alarm context are kept in fixed-size rolling/bounded structures only. Verified live against
the real TU Darmstadt/MIT public LFP field dataset: the pipeline correctly pointed at a
different cell than the paper's Cell 8 assumption, purely from the data.

The AI stages receive the detected format profile and derived summary alongside the log
context. Grid-scale telemetry uses the Battery/BMS, PCS, PPC, EMS, Telemetry/SCADA, Dispatch,
Forecast, Grid, and Normal-Response domains; cell-array uses Cell/Pack, Electrical Path,
Operating Condition, Balancing/BMS, and Thermal/Sensor. Every anomaly/hypothesis is tagged
`Observed`, `Derived`, or `Inferred`, and must state disconfirming evidence plus what signal
is missing from the current logs. For cell-array sources, a resistance/voltage pattern alone
can never be escalated to a confirmed electrochemical-degradation, connector, or corrosion
root cause — the claim is capped at "increased effective series resistance in Cell N's path."

## Executive report structure

The report produced in Step 5 isn't a free-form summary — it follows a fixed schema
specifically designed to make it structurally hard to overclaim
(`buildDraftReportPrompt` in `server/lib/prompts.js`, `server/lib/schemas.js`).

- **Headline**: a conclusion in one sentence, not a title — label-like phrasing (e.g. "Analysis
  Results") is rejected.
- **Occurrence / anomaly summary / root cause / action recommendation**: each capped at 2-3
  sentences, with every sentence tagged `Observed` (in the raw log), `Derived` (computed), or
  `Inferred` (hypothesis).
- **Figure citation**: if any figure has `available: true`, the headline or root-cause text
  must cite at least one figure id (`server/lib/validation.js`) — no claim is allowed to stand
  without a chart behind it. Only catalog ids can be cited; raw time-series points never reach
  the prompt.
- **FTA (Fault Tree Analysis)**: every relevant domain branch is scored
  `Confirmed`/`Probable`/`Possible`/`Unlikely`/`Rejected`/`Unobservable`.
- **The 3-box**: *what the data proves* (Observed only), *what the data strongly suggests*
  (inference from multiple pieces of evidence), and *what the data cannot determine* are kept
  in three separate boxes so a "suggests" can't quietly slide into a "proves."
- **Independent findings**: limited to 1-3 findings derived directly from the raw log —
  copying a published report's or paper's conclusions verbatim is disallowed.
- **"Save as HTML"**: bakes the charts into inline PNGs client-side and downloads one
  fully self-contained HTML file (`src/report-export.js`) — viewable and shareable with no
  server or network required.
- **Compare against published results (optional)**: the last step, enabled only after the
  report exists. Paste in an official AEMO announcement or a paper excerpt and it builds a
  side-by-side table (agreement, whether RAW data was sufficient, notes) — this step can never
  overwrite the independent findings already locked in
  (`buildPublishedComparisonPrompt` in `server/lib/prompts.js`).

Real output samples live in `Report/` — `case_a_report.html` (plus its published-comparison
version) built from the public WDBESS1/AEMO data, `case_b_report.html` built from the public
TU Darmstadt/MIT LFP data, and `case_b_findings.md`, which documents an issue hit along the
way and how it was resolved.

## Large ZIP (including nested ZIP) handling

Opening a large archive — e.g. seven days of 500MB-class CSVs, each zipped again inside the
outer zip:
1. The contents are cataloged first (name, size, format only — nothing is decompressed yet).
2. Entries ≤20MB stream-aggregate immediately (keeps the small-zip convenience).
3. Larger entries stay "cataloged" until you click "Include in analysis (start streaming)" —
   preventing unwanted, unbounded CPU/time cost.

JSZip has a known defect where it reads the uncompressed-size field as a signed 32-bit
integer, so any entry whose real size exceeds 2GB (2³¹ bytes) wraps negative and its internal
validation throws `uncompressed data size mismatch`. This project detects that failure and
falls back to parsing the ZIP local file header directly, reading only the compressed bytes
via `File.slice()`, and decompressing them through a separate streaming inflate path — so a
single entry over 2GB still streams to completion (`src/zip-stream.js`, called from
`src/zip.js`). Verified end-to-end against a real 2.75GB entry (19,248,213 rows) from the
public LFP field dataset. Encrypted, multi-disk, unsupported-compression, or genuinely
corrupted entries beyond even that fallback are isolated as a per-source "read failed"
state; the rest of the archive keeps cataloging/streaming normally.

## Getting started

Requirements: Node.js `^20.19.0` or `>=22.12.0` (what Vite 8 requires).

```bash
npm install
cp .env.example .env   # default AI_PROVIDER=cli — works immediately if claude is already logged in
npm run dev            # Vite dev server (5173) + Express API (3001, proxied at /api)
```

Production build:

```bash
npm run build
npm start               # NODE_ENV=production node server/index.js — serves API + static files on one port
```

## Principles that must hold

- **Keep the human-review checkpoint.** The report-generation button never activates without
  an explicitly selected hypothesis and a confirmed severity.
- **State derived signals and their limits explicitly.** Data with no static flag still gets
  a derived-anomaly computation, but a derived observation is never promoted to a confirmed
  physical root cause.
- **Keep the prompt budget in sync.** `src/log-engine.js` (frontend) and
  `server/lib/validation.js` (backend) must agree on `MAX_LOG_TEXT_CHARS=300000`; any omission
  is surfaced in both the prompt text and the UI, never silent.
- **Never commit real customer data.** `.gitignore` excludes `*.zip`/`*.csv`/`*.tsv`/`.env`.
  Develop and test only against sample, synthetic, or public data.
- **No `localStorage`.** Case history lives only in session memory and resets on reload.

## Further reading

- [Beginner's Guide (docs/GETTING_STARTED.en.md)](docs/GETTING_STARTED.en.md) — step-by-step,
  no prior context required, from install to your first analysis
- [DONE.md](DONE.md) — implementation/verification history
- [Report/](Report/) — real executive reports and evidence from Case A/B runs
- [design-mockups/](design-mockups/) — static mockups explored for a UI redesign direction
  (start at `index.html`). Not wired to the app code.
