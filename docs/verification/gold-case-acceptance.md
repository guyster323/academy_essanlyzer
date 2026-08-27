# Gold-case acceptance — WDBESS1 & LFP System 6

CI does not run these. Local ZIP files stay uncommitted (`*.zip` gitignore).

## Preconditions

- `npm test` already green on synthetic fixtures.
- Optional: `Log_sample/case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip`
- Optional: `Log_sample/case_b_field_data.zip` (System 6 = `field_data/data_sys_6.csv`)

## Case A — fail the run if

- A-F1/A-F2/A-F4 canvases are missing after WDBESS1 (or equivalent DUID) is streamed.
- A-F4 is missing and the confirmed hypothesis is Local Hardware `Confirmed`.
- The report headline asserts a PCS/BMS trip as fact.
- Provider software internals appear in `provenBox`.
- Published comparison overwrites independent findings.

Expected direction (hide nothing if data disagrees):

| Item | Independent | Published AEMO | RAW sufficient? |
|---|---|---|---|
| MW excursion | Derived from MEASURED_MW | Frequency/dispatch event 19 Aug 2025 | yes (MW only) |
| Cross-asset sync | A-F4 | 34 generators, common provider | partial |
| Local hardware | Unlikely/Unobservable if A-F4 common-mode | Not a plant fault | yes to reject, no to confirm |
| Self-forecast 0 MW | Unknown | Root cause | no |
| CompMon PFR false nonconformance | Possible if 12:15 window + recovery | Finding 4 | partial |

Inventory the archive for **2025-08-19** first. If only the 17th is present, record that as `unknownBox` / archive limit — do not pretend the event day was analysed.

## Case B — fail the run if

- B-F1 is missing and the report claims electrochemical degradation of Cell 8.
- Vdev Cell 5/7 is treated as a contradiction of the paper's Cell 8 resistance result (they are different metrics).
- Physical root cause (connector vs corrosion vs electrode) is marked Confirmed.
- GP/BattGP (B-F5) is silently omitted instead of `unavailable`.

Expected direction:

| Item | Independent | Paper | RAW sufficient? |
|---|---|---|---|
| Abnormal cell (resistance) | data-driven | Cell 8 | if B-F1 exists |
| Knee | two-method detect | ~3 years | if B-F4 available |
| Fault probability | Unknown (unimplemented) | ~500 d / p>0.5 ~800 d | no |
| Physical RC | unresolved | unresolved | no |
| Vdev vs R | both Observed/Derived, not merged | paper uses R(t) | yes |

## Commands

```powershell
npm run test:unit
# optional live ZIP, not committed:
# node tmp/verify-gold-cases.mjs --case a --zip Log_sample\case_a_PUBLIC_NEXT_DAY_FPPMW_20250817.zip
```

Record outcomes in `docs/verification/YYYY-MM-DD-gold-cases.md` (no API keys, no customer names).
