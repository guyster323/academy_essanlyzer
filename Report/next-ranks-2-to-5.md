# Remaining ranks 2–5 (re-established 2026-08-27 gold run)

Gold Case A/B live run superseded the previous 2–5 list (FPPMW day inventory is done; System 6 is on disk). Rank 1 remains: finish this PR’s evidence-figure / 3-box report path.

**Status 2026-08-30 — ranks 2, 3 and 4 are done.** Rank 5 is still open. The original
sections below are **kept verbatim**: this repo preserves its own mistaken diagnoses
instead of rewriting history. What changed:

| Rank | Original “next” (2026-08-27, preserved below) | Status 2026-08-30 |
|---|---|---|
| 2 | ≤20 MB CSV autostream + durable File bytes + checkbox | **Done** (live Case A hang is gone; e2e uploads a real CSV and asserts `행`). |
| 3 | “Gold CLI finishes without 504; **shrink the detect prompt — not 2500 alarm rows**” | **Done as CLI overhead** (`--safe-mode` etc., 12.9s→5.5s, `Report/rank-3-4-findings.md`). The *prompt-shrink* half of the original diagnosis is **wrong** — see the correction after the original Rank 3 text. |
| 4 | System 6 span in-browser (stride or worker) with B-F5 unavailable | **Done**: stride80 in-tab + full `data_sys_6.csv` ZIP stream (14.2 min, late resistance events kept). B-F5 stays unavailable. |
| 5 | A-F6 only if Target exists; otherwise unknownBox | Still open. Public FPPMW still has no Dispatch Target column. |

## 2. Small-file autostream and upload I/O (blocks every gold CSV)

Live Case A (`WDBESS1_peers_20250819.csv`, 3.10 MB) stayed at **스캔 중 0%** in Chrome, Orca, and Playwright.

- `makeSourceShell` started as `processing`, then `startSourceProcessing()` returned immediately because that status means “already in flight”. Files ≤20 MB never streamed. Files >20 MB worked only because they stay `cataloged` until “분석 포함”.
- After `render()` replaces `<input type=file>`, a second `File.slice().arrayBuffer()` can hang. Persist bytes in a WeakMap before the first re-render.
- The privacy checkbox had no `checked` binding, so any `render()` cleared it and `submitIntake()` no-oped.

Ship: keep autostream + persist-bytes + checkbox binding; add an e2e that uploads a real ≤20 MB CSV and asserts `행` not `스캔 중 0%`.

## 3. Claude CLI wall-clock vs gold prompts

`/api/detect-anomaly` 504 at 240 s on this day’s FPPMW window. Raised default to 600 s (`CLAUDE_CLI_TIMEOUT_MS`). Gold still waits 3–10 minutes **per gate** (detect → hypotheses → draft → compare) with no streaming progress from `claude -p`.

Next: keep the 10 min cap, surface 504 as a recoverable retry in the UI, and shrink the detect prompt (entity-filtered stats + figure catalog only — not 2500 alarm rows). Do not drop the five human gates.

**Correction (2026-08-30):** the sentence above (“shrink the detect prompt — not 2500 alarm rows”) was the diagnosis at the time. It is **false**. Rank 3 measured the real stride80 detect prompt at **54,780 characters** (`Report/rank-3-4-findings.md`); after CLI overhead flags the same call still took **700.9 s**, almost all `duration_api_ms`. `Report/latency-root-cause-and-plan.md` then sent a ~200-character prompt and still got **220–367 s**, of which 56–80% of output tokens were **thinking**. Input size is not the bottleneck; thinking time is. Timeout was later raised to 20 min so the gate can finish, which is a different lever from shrinking the prompt. The original “next” line is left in place so a later reader can see what we believed and why it was overturned.

## 4. Case B System 6 in the browser (without GP/BattGP)

`field_data/data_sys_6.csv` is 2.89 GB uncompressed / ~275 MB deflate. JSZip signed-size fallback exists, but a 2.9 GB inflate in-tab is not a gold-run path.

This run stride-sampled 1/80 → `Log_sample/extracted/data_sys_6_stride80.csv` (240,603 data rows, 36 MB, full 1352-day span, daily bins still valid). **B-F5 (GP/BattGP) stays unavailable** — do not invent Cell 8 from Vdev.

Next: optional worker/streaming ZIP “분석 포함” for sys_6; B-F5 remains a declared gap unless the paper’s GP traces are added as a separate, labelled overlay.

## 5. A-F6 Dispatch Target and time-to-report

A-F6 is still missing (no Dispatch Target column in public FPPMW). Auto entity filter `BESS` cut 29,306 → 15,670 rows / 6 entities — enough for A-F4 common-mode, but the filter must stay visible so a human can clear it.

Time-to-report is dominated by three serial CLI calls, not parse (3.1 MB parsed in <2 s after rank-2). Measuring 5–6 h → 2–3 h is premature until rank 3’s prompt/timeout path is stable.

| Rank | Outcome | Not |
|---|---|---|
| 2 | ≤20 MB CSV autostream + durable File bytes + checkbox | another figure type |
| 3 | Gold CLI finishes without 504; prompt budget for detect | GP/BattGP |
| 4 | System 6 span in-browser (stride or worker) with B-F5 unavailable | claiming Cell 8 from Vdev |
| 5 | A-F6 only if Target exists; otherwise unknownBox | treating 12:15 clock as detection start |
