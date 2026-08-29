# --effort quality comparison (human judgment, not a worker call)

Same ~200-character detect-anomaly prompt, production CLI flags, `n=3` per
level. The worker does **not** adopt a level from these files. Speed numbers
are in `Report/latency-findings.md`. Look here at the evidence-rigor fields.

## What to open

| File | effort | windows | evidenceTier mix | notes |
|---|---|---|---|---|
| `detect-anomaly-low-1.structured.json` | low | 0 | — | empty `anomalyWindows` |
| `detect-anomaly-low-2.structured.json` | low | 0 | — | empty |
| `detect-anomaly-low-3.structured.json` | low | 0 | — | empty |
| `detect-anomaly-medium-1.structured.json` | medium | 0 | — | empty |
| `detect-anomaly-medium-2.structured.json` | medium | 0 | — | empty |
| `detect-anomaly-medium-3.structured.json` | medium | 16 | Derived 9 / Observed 7 | only medium run that listed windows |
| `detect-anomaly-high-1.structured.json` | high | 16 | Inferred 16 | only high run that listed windows |
| `detect-anomaly-high-2.structured.json` | high | 0 | — | empty |
| `detect-anomaly-high-3.structured.json` | high | 0 | — | empty |

The two 16-window runs (`medium-3`, `high-1`) are the only pair that can be
compared on `evidenceTier` / window content. All low runs returned 0 windows.

`detect-anomaly` has no `disconfirmingEvidence` / `missingSignals` /
`claimLimit` fields (those live on generate-hypotheses). Compare
`evidenceTier` and whether windows were produced at all.

## Side-by-side snapshot of the two 16-window runs

First window (same timestamp `2018-10-10 08:31:50`, Vdev_Cell_8):

| field | medium-3 | high-1 |
|---|---|---|
| evidenceTier | **Derived** | **Inferred** |
| observedValue | `Vdev=+0.038V, robust z=3.02, voltageClosureError=0.005` | same numbers |
| sourceFile | `data_sys_6_stride80.csv` | `data_sys_6_stride80.csv (가상 테스트 데이터·이전 세션 산출물 인용·미검증)` |

Second window (same timestamp, raw `U_Cell_8, I_Battery`):

| field | medium-3 | high-1 |
|---|---|---|
| evidenceTier | **Observed** | **Inferred** (notes `[원 분류 Observed]` in deviation) |
| observedValue | `U_Cell_8=3.58V, I_Battery=+29.07A, ...` | same numbers |

Both 16-window outputs appear to recall a prior-session cached window list
rather than derive it from the short prompt (they mention `anomaly4.json` /
previous UI snapshots). That is part of the quality picture, not something
the worker is scoring.

## Worker decision (speed only — quality is yours)

`--effort` is **not** adopted in `server/lib/claude-cli.js`. Mean wall-clock
looks faster at low/medium, but (1) within-level spread exceeds the
between-level gap, (2) 7 of 9 runs returned empty `anomalyWindows`, and
(3) the one medium run that listed windows was not faster than the one high
run that listed windows (333s vs 442s, both in the original 220–367s band).
