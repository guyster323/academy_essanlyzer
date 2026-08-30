# Latency findings (tasks 6-1–6-4) — 2026-08-30

Pair document: `Report/latency-root-cause-and-plan.md`. Branch
`feat/latency-timeout-and-measurement`. Machine: this worktree, Claude Code
CLI 2.1.251, `ANTHROPIC_MODEL=claude-sonnet-5`, `AI_PROVIDER=cli`.

The 700-second stage latency is still thinking time, not ZIP size or prompt
budget. This file records every raw measurement from the follow-up work, not
just the conclusions.

Reproduction scripts (not part of the runtime): `scripts/measure-cli-latency.mjs`,
`scripts/profile-stream.mjs`.

---

## 6-1. Timeout default raised (applied)

`server/lib/claude-cli.js` `CLI_TIMEOUT_MS` default `600_000` → `1_200_000`.
`.env.example` comment updated to the same 20-minute safety ceiling.

This is not a performance target. Rank 3 measured Case B detect-anomaly at
**700.9s** (`Report/rank-3-4-findings.md`), which exceeds the old 10-minute
code default. A fresh clone without the gitignored `.env` override was
guaranteed a 504 on the gold case.

---

## 6-2. `maxTokens` on the cli path — declined, with measurements

`server/routes/analysis.js` still passes `maxTokens` per stage
(detect-anomaly 2000 / generate-hypotheses 2000 / draft-report 4000).
`server/lib/anthropic.js` honors it. `server/lib/ai-provider.js` does **not**
forward it to `callStructuredViaCli`. That omission is now documented in
`ai-provider.js` and `claude-cli.js` so it is no longer silent.

### Why it was not wired through

Thinking tokens share the CLI output budget. A cap below observed thinking
kills `structured_output` (plan case D: `CLAUDE_CODE_MAX_OUTPUT_TOKENS=4000`
→ `is_error:true`, `stop_reason:stop_sequence`, no `structured_output`).

This session's detect-anomaly thinking tokens, same ~200-character prompt as
the plan table, production flags (`-p --output-format json --json-schema
--model sonnet --allowedTools '' --disable-slash-commands --safe-mode
--strict-mcp-config --no-session-persistence --system-prompt PERSONA`):

| run | effort | wall s | output tokens | **thinking tokens** | thinking % of output | windows | structured_output |
|---|---|---|---|---|---|---|---|
| low-1 | low | 105.4 | 6,469 | **4,449** | 69% | 0 | yes |
| medium-1 | medium | 148.6 | 8,732 | **5,098** | 58% | 0 | yes |
| high-1 | high | 441.9 | 35,485 | **20,736** | 58% | 16 | yes |
| low-2 | low | 143.4 | 8,838 | **5,059** | 57% | 0 | yes |
| medium-2 | medium | 115.0 | 7,043 | **3,990** | 57% | 0 | yes |
| high-2 | high | 120.7 | 7,733 | **4,484** | 58% | 0 | yes |
| low-3 | low | 172.2 | 11,542 | **7,775** | 67% | 0 | yes |
| medium-3 | medium | 333.2 | 26,722 | **15,218** | 57% | 16 | yes |
| high-3 | high | 116.8 | 7,948 | **5,029** | 63% | 0 | yes |

Thinking range **3,990–20,736**. The route cap of 2,000 sits below every
run, including the fastest empty-window ones. Envelope `modelUsage` for
`claude-sonnet-5` reports `maxOutputTokens: 64000` already — that is the
CLI default, and it is the only cap that actually sat above observed
thinking. Wiring 2000/4000 through as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
would recreate plan case D.

A "safe" number with headroom above 20,736 thinking + ~15,000 answer
tokens (high-1 total 35,485) would be on the order of the CLI's existing
64k default. Applying that would change nothing. Applying the route
values would break the default provider. So: **do not apply**.

Probe of the usage field shape (trivial schema, 5s, not a stage
measurement): `usage.output_tokens_details.thinking_tokens` is the
thinking counter used in the table above.

### generate-hypotheses / draft-report

After the 9 detect-anomaly runs, the chained generate-hypotheses call
returned in 4.0s with `api_error_status: 429`,
`result: "You've hit your session limit · resets 10:10am (Asia/Seoul)"`,
`duration_api_ms: 0`, `output_tokens: 0`, no `structured_output`.
A trivial follow-up probe at ~07:20 KST reproduced the same 429.

Those two stages were **not** re-measured this session because of that
limit. They are not needed to justify the decline: detect-anomaly
thinking already exceeds both 2000 and 4000. Historical gold-run
wall-clock from `Report/case_b_findings.md` (same CLI path, real Case B
pipeline, not re-run today): generate-hypotheses ~5–13 min, draft-report
~9–10 min — the same thinking-dominated band.

If a later session re-measures those two stages, the raw envelopes should
be appended here. The code decision (cli ignores maxTokens) should not
flip unless thinking usage drops below the route caps **and** a cap still
returns `structured_output` for every stage.

---

## 6-3. `--effort` — measured, not adopted

> **이후 재측정 (2026-08-30).** The n=3 table below used a ~200-character
> prompt and is **not a valid effort comparison** (7/9 empty windows). A
> remake with the real 54,738-char stride80 detect prompt is in
> `Report/latency-effort-real-outputs/COMPARISON.md`: 4/9 valid (15–16
> windows), 5/9 429 spend-limit, no level adopted.

`server/lib/claude-cli.js` still passes no `--effort`. That is intentional.

Same prompt as the plan's section 1 (the ~200-character LFP summary asking
to list anomaly windows), production flags, interleaved low/medium/high so
cache warmup did not land on one bucket. n=3 each.

Raw rows are in the 6-2 table. Summaries:

| effort | n | wall s (raw) | mean | min | max | spread (max−min) | thinking mean (min–max) | windows |
|---|---|---|---|---|---|---|---|---|
| low | 3 | 105.4, 143.4, 172.2 | **140.3** | 105.4 | 172.2 | 66.8 | 5,761 (4,449–7,775) | 0, 0, 0 |
| medium | 3 | 148.6, 115.0, 333.2 | **198.9** | 115.0 | 333.2 | 218.2 | 8,102 (3,990–15,218) | 0, 0, **16** |
| high | 3 | 441.9, 120.7, 116.8 | **226.5** | 116.8 | 441.9 | 325.1 | 10,083 (4,484–20,736) | **16**, 0, 0 |

Mean wall-clock looks like low < medium < high, but **within-level spread
exceeds the between-level gap** (high spread 325s vs low-vs-high mean gap
86s). That is the same pattern that made the plan's n=1 table
self-contradictory (medium 220s faster than low 303s).

The two runs that actually listed 16 windows were **medium-3 at 333.2s**
and **high-1 at 441.9s** — both inside the plan's 220–367s band, neither
"fast". The "fast" means are almost entirely empty-`anomalyWindows` runs.

### Quality comparison material (human judgment, not a worker call)

Side-by-side files: `Report/latency-effort-outputs/`. Guide:
`Report/latency-effort-outputs/COMPARISON.md`. Suite JSON:
`Report/latency-effort-outputs/effort-suite.json`.

`detect-anomaly` has `evidenceTier` on windows. It does **not** have
`disconfirmingEvidence` / `missingSignals` / `claimLimit` (those fields
belong to generate-hypotheses, which this session could not re-run).

Snapshot of the only two 16-window runs (first window, same timestamp
`2018-10-10 08:31:50`, Vdev_Cell_8):

| field | medium-3 | high-1 |
|---|---|---|
| evidenceTier | Derived | Inferred |
| observedValue | `Vdev=+0.038V, robust z=3.02, voltageClosureError=0.005` | same numbers |
| sourceFile | `data_sys_6_stride80.csv` | annotated as prior-session cache, unverified |

medium-3 mixed Derived 9 / Observed 7. high-1 labeled all 16 Inferred
(and noted the original Observed/Derived classification in `deviation`).
Both appear to recall a prior-session window list (`anomaly4.json` is
mentioned in `priorHistory`) rather than invent 16 windows from the short
prompt. All six low runs, plus most medium/high runs, returned 0 windows
and said the raw log was not attached.

**The worker does not adopt `--effort` from speed or from this quality
picture.** A human should open the JSON files and decide. Speed alone
would be a dishonest reason to take low/medium: those levels mostly
skipped listing windows.

---

## 6-4. ZIP streaming profile — yield strategy changed, justified

Instrumentation (opt-in 4th argument `{ profile, yieldDelayMs }` on
`streamIntoSource`; `{ profile }` on `zipEntryByteChunks`) records
inflate / zip-read / TextDecoder / split / feedLine / yield wait /
applyAccumulator. Default callers are unchanged.

Raw JSON: `Report/latency-stream-profiles/`.

### stride80 CSV (36,113,717 bytes, 240,603 data rows, Node, `setTimeout(0)`)

| phase | yield0 ms | % | yieldDelayMs=4 ms | % |
|---|---|---|---|---|
| inflateOrRead (disk) | 35 | 0.4 | 42 | 0.5 |
| decode | 17 | 0.2 | 18 | 0.2 |
| split | 29 | 0.3 | 27 | 0.3 |
| **feedLine** | **7,685** | **86.2** | **7,386** | **81.8** |
| yieldWait | 1,084 | 12.2 | 1,492 | 16.5 |
| apply | 1 | 0.0 | 1 | 0.0 |
| wall | 8,912 | | 9,025 | |
| yieldCount / chunkCount | 138 / 138 | | 138 / 138 | |
| MB/s | 3.86 | | 3.82 | |

`LINES_PER_YIELD=2000` did **not** fire: 256KB file chunks hold ~1,743
lines. The only yields were the unconditional per-chunk ones.

### System 6 ZIP `field_data/data_sys_6.csv` (before changing yield)

Direct pako path, Node, `setTimeout(0)`. Uncompressed 2,889,184,963 bytes,
19,248,213 data rows (19,248,214 nonempty lines including header).

| phase | ms | % of 1038.7s wall |
|---|---|---|
| zipRead | 501 | 0.05 |
| inflate (pako) | 10,472 | 1.0 |
| inflateOrRead (iterable wait; ≈ zipRead+inflate) | 11,586 | 1.1 |
| decode | 783 | 0.1 |
| split | 1,728 | 0.2 |
| **feedLine** | **716,805** | **69.0** |
| **yieldWait** | **303,165** | **29.2** |
| apply | 2 | 0.0 |
| wall | 1,038,664 | |
| chunkCount / yieldCount | 44,086 / **44,086** | |
| MB/s | 2.65 | |

Inflate is **not** the bottleneck (10s). Row parsing (`feedLine`: CSV
cells + LFP Vdev/forensics/series) is. Yield is the second term, not 5%.

The plan's 5% / 41s estimate used 4MB chunks → ~722 extra yields. Actual
inflate output is `INFLATE_OUTPUT_CHUNK_BYTES=64KB` → **44,086 chunks**,
~436 lines each, so `LINES_PER_YIELD=2000` never fired and the
unconditional per-chunk `setTimeout(0)` ran 44,086 times. Node mean wait
303,165 / 44,086 ≈ **6.9ms/yield**. Browser nested-timer clamp of 4ms
would be 44,086 × 4ms ≈ **176s ≈ 21% of the Rank 4 850s**, not 41s.

That is not negligible. The change: **drop the per-chunk yield**, keep
`LINES_PER_YIELD=2000` (now actually reachable because `sinceYield` is no
longer reset every 64KB). `processedBytes` is still assigned every chunk
and flushed at end, so small files that never hit 2000 lines (the ZIP
retry unit test) still report a final byte count.

### System 6 ZIP after the change

| phase | before ms (%) | after ms (%) |
|---|---|---|
| zipRead | 501 (0.0) | 483 (0.1) |
| inflate | 10,472 (1.0) | 10,217 (1.3) |
| decode | 783 (0.1) | 731 (0.1) |
| split | 1,728 (0.2) | 1,576 (0.2) |
| feedLine | 716,805 (69.0) | 727,138 (89.9) |
| **yieldWait** | **303,165 (29.2)** | **63,946 (7.9)** |
| wall | **1,038.7s / 2.65 MB/s** | **809.0s / 3.41 MB/s** |
| yieldCount | 44,086 | **9,624** (= 19,248,214 / 2000) |

Node wall **1039s → 809s (−230s, −22%)**, almost exactly the yieldWait
drop (303s → 64s). Browser clamp estimate: 9,624 × 4ms ≈ **38s** leftover
yield vs 176s before (~138s / 16% of Rank 4's 850s). Remaining ~90% is
still `feedLine`. No Web Worker. No MessageChannel — leftover yield is
now in the plan's original "about 5%" band, and the 180ms progress-bar
throttle in `src/zip.js` is coarser than 2000 LFP lines (~75ms of work).

### UI verification (must not break Rank 4)

`tests/e2e/stream-progress.spec.js` uploads
`Log_sample/extracted/data_sys_6_stride80.csv` (skipped if the gitignored
fixture is absent), clicks **분석 포함 (스트리밍 시작)**, and asserts:

- `.progress-fill` width samples are monotonically non-decreasing and not
  a single value (the bar actually advances)
- the source ends at `240,603행`
- `pageerror` count is 0 (tab did not hang)

Measured 2026-08-30: desktop-chromium 14.1s pass, mobile-chromium 9.1s
pass, re-check after the `processedBytes` flush 13.6s pass.

Unit test: `streamIntoSource yields every LINES_PER_YIELD lines, not once
per byte chunk`.

### What was not changed

- `LINES_PER_YIELD` stays 2000
- yield primitive stays `setTimeout(0)` (not MessageChannel/queueMicrotask)
- no Web Worker
- prompt-budget constants untouched
- B-F5 / GP-BattGP not fabricated

feedLine (LFP derived + series + forensics per row) is the remaining 90%.
Speeding that up is a different task and was not in scope.

---

## Out of scope (plan 6-5) — not done

- Reducing hypothesis count / FTA leaves / email body
- Removing or automating a human-review checkpoint
- Switching `AI_PROVIDER=api`
- Touching `MAX_TOTAL_ALARM_CONTEXTS` and friends
- Introducing a Web Worker
- Fabricating B-F5 / GP-BattGP

---

## Verification

- `npm run test:unit` — run after the 6-4 change; see the commit that
  records the exact count.
- `npm run build`
- Playwright stream-progress spec as above
- 6-1 applied; 6-2 declined with measurements; 6-3 comparison files saved
  and `--effort` not adopted; 6-4 profiled, per-chunk yield removed
  because yieldWait was 29% not 5%, UI re-checked
