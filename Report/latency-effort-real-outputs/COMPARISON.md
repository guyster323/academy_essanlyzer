# `--effort` remeasure with the real detect prompt (2026-08-30)

This replaces `Report/latency-effort-outputs/` as the **timing** comparison.
The previous suite cannot be trusted: 7 of 9 runs returned empty
`anomalyWindows` (the model said the raw log was not attached) and the two
16-window runs appear to have recalled a prior session. That compared
"declined to work" against "did work".

This run used the actual `blocksToPromptText` + `buildDetectAnomalyPrompt`
output for `Log_sample/extracted/data_sys_6_stride80.csv`:

- prompt: 54,738 chars (`detect-anomaly-real-prompt.txt`)
- rows: 240,603
- derived alarms: 9,366
- interleaved `low / medium / high` × 3
- production CLI flags from `server/lib/claude-cli.js`
- a result is **valid** only if `structured_output` exists, `anomalyWindows.length > 0`,
  and the payload does not claim the raw log was missing

**Quality is not judged here. No effort level is adopted.**

## Validity filter

| | n |
|---|---|
| attempted | 9 |
| valid (used for timing) | **4** |
| excluded | **5** |

The five excluded runs (`medium-2`, `high-2`, `low-3`, `medium-3`, `high-3`)
all returned in 2.9–4.6 s with `api_error_status: 429`, `duration_api_ms: 0`,
`output_tokens: 0`, no `structured_output`. Envelope result:

> You've hit your individual spend limit · run /usage-credits to ask your
> admin for a higher limit · your session limit resets 1:30pm (Asia/Seoul)

They are recorded, not timed, and not retried.

## Valid detect-anomaly runs

| label | effort | wall s | output tokens | thinking tokens | thinking % | windows |
|---|---|---|---|---|---|---|
| real-detect-low-1 | low | 732.7 | 71,003 | 61,639 | 87% | 16 |
| real-detect-medium-1 | medium | 707.8 | 69,633 | 61,600 | 88% | 16 |
| real-detect-high-1 | high | 820.7 | 81,046 | 71,658 | 88% | 15 |
| real-detect-low-2 | low | 1139.8 | 110,257 | 103,274 | 94% | 16 |

By effort, **valid only**:

| effort | valid / attempted | wall s | mean s |
|---|---|---|---|
| low | 2 / 3 | 732.7, 1139.8 | 936.3 |
| medium | 1 / 3 | 707.8 | 707.8 |
| high | 1 / 3 | 820.7 | 820.7 |

Within-level spread on low (407 s) already exceeds the gap between the
single medium (707.8 s) and the single high (820.7 s). That is not enough
to pick a level even if someone wanted to. Thinking is 87–94% of output
tokens on every valid run.

## generate-hypotheses

One chained call from `real-detect-high-1` (`real-generate-hypotheses-1`):
2.7 s, `api_error_status: 429`, no `structured_output`. Same spend limit.
Not retried.

## Files

Structured outputs for the four valid detects are in this directory.
Raw envelopes (including 429 bodies) are under `tmp/latency-runs/real-detect-*.envelope.json`.
The prompt text is `detect-anomaly-real-prompt.txt`.
