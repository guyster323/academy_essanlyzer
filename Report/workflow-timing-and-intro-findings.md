# Workflow timing and intro refresh — findings (2026-08-30)

Pair document: `Report/workflow-timing-and-intro-plan.md`. Branch
`feat/workflow-timings-and-intro`. Machine: this worktree, Claude Code CLI
2.1.251, `AI_PROVIDER=cli`, `ANTHROPIC_MODEL=claude-sonnet-5`. Measurement
server: `http://127.0.0.1:3011` with `CLAUDE_CLI_TIMEOUT_MS=1800000` (code
default 30 min; `.env` still has 1_200_000 and was **not** used for these
calls). Reproduction: `scripts/measure-workflow-paths.mjs`.

Raw request/response JSON lives under `tmp/workflow-timing-runs/` (gitignored).
This file copies every wall-clock number that was used in the docs.

A well-measured negative result is a success here. Failed attempts are listed
as failed attempts.

---

## Task A — what was measured

Two paths, separately, through the production HTTP routes
(`/api/detect-anomaly`, `/api/generate-hypotheses`, `/api/draft-report`).
That is the clock a user waits on. Client-side parse of the 10-row sample is
milliseconds; Case B figure/conflict compute was 7.0–7.9 s and is **not**
folded into the AI totals below.

### Sample path (GETTING_STARTED built-in sample)

Input: `SAMPLE_CS` + `SAMPLE_CSV` + `SAMPLE_PRIOR` from `src/state.js`.
10 rows, format `generic`, combined log text 1,661 chars, 3 alarm rows,
`derivedAlarmCount=0`, attribution status `cross-check-unavailable`.
Human review was simulated (first hypothesis + its `severityDraft`); that is
not an AI call and was not timed.

| stage | startedAt (UTC) | wall_s | http | ok | notes |
|---|---|---|---|---|---|
| detect-anomaly (attempt 1) | 2026-08-30T03:58:54.227Z | ~209.9 | 200 (payload lost) | n/a | HTTP finished; measurement script then crashed on `started.replace` (number, not string). Process duration 209.93 s. **Not used in docs.** |
| detect-anomaly (kept) | 2026-08-30T04:03:02.923Z | **214.3** | 200 | yes | `tmp/workflow-timing-runs/detect-anomaly-2026-08-30T04-03-02-923Z.*` |
| generate-hypotheses (attempt 1) | 2026-08-30T04:06:37.273Z | 302.9 | 0 | no | Node `fetch` default `headersTimeout` 300 s. Server-side `claude -p` was still running. **Not a completed measurement.** |
| generate-hypotheses (kept) | 2026-08-30T04:16:43.238Z | **318.6** | 200 | yes | Resumed from saved detect JSON. Client switched to `node:http`. |
| draft-report (kept) | 2026-08-30T04:22:01.803Z | **340.7** | 200 | yes | |

AI total (kept stages only): **873.6 s ≈ 14.6 min**.

"Within 5 minutes" is false for the sample path. "Usually 30 seconds to a few
minutes" is false even for a single sample stage (fastest kept stage 214.3 s).

### Gold Case B path (`Log_sample/extracted/data_sys_6_stride80.csv`)

240,603 rows, format `lfp-cell-array`, derived alarms 9,366. Detect-anomaly
was **not re-run today** — the plan said those numbers already exist.

Live extras computed before the chained calls (7.0 s on the successful run):

- figures B-F1..B-F4 available, B-F5/B-F6 unavailable
- attribution **conflict**: voltage residual **Cell 8** 9,271 / 9,366 (99%),
  event resistance **Cell 5** matched 1,330 / 4,000, droppedEvents 51,677

| stage | startedAt (UTC) | wall_s | http | ok | notes |
|---|---|---|---|---|---|
| detect-anomaly | — | **707.8 / 732.7 / 820.7 / 1,139.8** | — | yes (prior) | `Report/latency-effort-real-outputs/COMPARISON.md`. Reused `real-detect-medium-1` (707.8 s) as the chain input. **Previously measured, not re-measured today.** |
| generate-hypotheses (attempt 1) | 2026-08-30T04:28:09.578Z | 0 | 0 | no | `read ECONNRESET` immediately after the 7.9 s figure build. Retried. |
| generate-hypotheses (kept) | 2026-08-30T04:31:43.228Z | **557.4** | 200 | yes | |
| draft-report (kept) | 2026-08-30T04:41:00.682Z | **485.6** | 200 | yes | Request included `attributionConflict`. |

End-to-end AI total using the reused detect:

- with 707.8 s detect: **1,750.8 s ≈ 29.2 min**
- with 1,139.8 s detect: **2,182.8 s ≈ 36.4 min**

No 429 on any kept call today. Historical 429 on Case B hypotheses
(`Report/latency-effort-real-outputs/COMPARISON.md`, 2.7 s, spend limit) is
**not** re-presented as a fresh number.

Historical UI-stopwatch figures in `Report/case_b_findings.md` (hypotheses
5–13 min, draft-report 9–10 min) sit next to today's 557.4 s / 485.6 s and
are labeled there as previously observed. Today's numbers are the ones the
docs quote for those two stages.

---

## Task B — docs

Replaced the 100–240 s / "5 minutes" / "30 seconds to a few minutes" /
"up to about 4 minutes" claims in:

- `README.md`, `README.en.md` (AI invocation paragraph)
- `docs/GETTING_STARTED.md`, `docs/GETTING_STARTED.en.md` (step 3 heading,
  wait copy, FAQ)

Both paths are stated. Extended thinking 87–94% of output tokens is cited
from `Report/latency-findings.md` / the real-prompt suite (not re-measured
on the HTTP path; the HTTP envelope does not return token usage). Timeout
default 30 min (`1_800_000`) is mentioned.

Commit: `e389cea`.

---

## Task D — intro

Hero captions on README KR/EN and GETTING_STARTED KR/EN now say the clip is
an edit, quote sample ~15 min and Case B ~29–36 min, and say waits were cut.
Intro paragraphs state that when evidence conflicts the app does not pick a
winner.

Commit: `ee4cb9b` (captions later updated from 38 s → 24 s with the new
assets).

---

## Task C — demo re-record

Playwright `video: { mode: 'on' }` walkthrough
(`tests/e2e/record-demo-case-b.spec.js`, `RECORD_DEMO=1`, `PW_PORT=5183`).
API routes were **mocked**. This is a UI walkthrough with waits cut, not a
live 30-minute Claude run. The overlay on the video says so:
`Real Case B elapsed 29-36 min | waits cut`.

Shown in the clip (verified from extracted frames):

- omission notice: 저항 이벤트 51,677건 생략 + 이상 구간 4건 생략(상한 16)
- evidence-conflict banner: Cell 8 vs Cell 5, "앱은 어느 쪽이 맞다고 판정하지 않습니다"
- human-review checkpoint banner
- report headline that the app does not adopt one cell

Encode (`C:\Program Files\Metadata++\ffmpeg.exe`):

- mp4: libx264 High, yuv420p, 1280×720, 25 fps, **`-movflags +faststart`**,
  silent AAC stereo 2 kb/s, 23.56 s, **938,292 bytes** (was 2,722,499)
- gif: palettegen then paletteuse, 720×405, 10 fps, **3,219,378 bytes**
  (was 3,485,714)

The 4 dropped anomaly windows in the mock exist to exercise the omission
chrome. The 51,677 resistance-event drop is from the real stride80 stream.

---

## What was not finished / not claimed

- Case B detect-anomaly was not re-run (by design). Docs that quote
  707.8–1,139.8 s label it as previously measured.
- HTTP responses do not include thinking-token counts. The 87–94% figure is
  the prior CLI-envelope measurement, not a new HTTP measurement.
- Human-review wall clock was not measured (interactive; a few clicks).
- The demo is not a live three-call Claude capture. Compressing that into
  24 s without a label would have repeated the original lie; the overlay
  and captions label the cut.
- Sibling checkout still holds 5173/3001. This worktree used 3011 and
  `PW_PORT=5183`. `vite.config.js` proxy remains hardcoded to 3001; mocked
  recording does not need it. A live Playwright run against this worktree's
  API would need a proxy env — not done.
- `.env` `CLAUDE_CLI_TIMEOUT_MS=1200000` was not changed. Measurement used
  an explicit 1_800_000 on the 3011 process.

---

## Tooling notes (so the next measurement does not repeat them)

1. Node 24 `fetch` `headersTimeout` is 300 s. Sample hypotheses ran 318.6 s.
   Use `node:http` (or an undici Agent with a 35-minute headers timeout).
2. `playwright.config.js` global `timeout: 30_000` was **not** raised. The
   recording spec uses `test.setTimeout(240_000)` and is skipped unless
   `RECORD_DEMO=1`.
3. `scripts/measure-workflow-paths.mjs` now `process.exit`s. Without that,
   huge Case B figure objects kept the event loop alive after "ALL DONE".
