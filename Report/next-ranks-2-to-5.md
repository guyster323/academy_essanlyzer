# Remaining ranks 2–5 (re-established 2026-08-27 gold run)

Gold Case A/B live run superseded the previous 2–5 list (FPPMW day inventory is done; System 6 is on disk). Rank 1 remains: finish this PR’s evidence-figure / 3-box report path.

## 2. Small-file autostream and upload I/O (blocks every gold CSV)

Live Case A (`WDBESS1_peers_20250819.csv`, 3.10 MB) stayed at **스캔 중 0%** in Chrome, Orca, and Playwright.

- `makeSourceShell` started as `processing`, then `startSourceProcessing()` returned immediately because that status means “already in flight”. Files ≤20 MB never streamed. Files >20 MB worked only because they stay `cataloged` until “분석 포함”.
- After `render()` replaces `<input type=file>`, a second `File.slice().arrayBuffer()` can hang. Persist bytes in a WeakMap before the first re-render.
- The privacy checkbox had no `checked` binding, so any `render()` cleared it and `submitIntake()` no-oped.

Ship: keep autostream + persist-bytes + checkbox binding; add an e2e that uploads a real ≤20 MB CSV and asserts `행` not `스캔 중 0%`.

## 3. Claude CLI wall-clock vs gold prompts

`/api/detect-anomaly` 504 at 240 s on this day’s FPPMW window. Raised default to 600 s (`CLAUDE_CLI_TIMEOUT_MS`). Gold still waits 3–10 minutes **per gate** (detect → hypotheses → draft → compare) with no streaming progress from `claude -p`.

Next: keep the 10 min cap, surface 504 as a recoverable retry in the UI, and shrink the detect prompt (entity-filtered stats + figure catalog only — not 2500 alarm rows). Do not drop the five human gates.

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
