# Streaming Log Analysis Generalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing five-step ESS analysis pipeline so AEMO telemetry and LFP cell-array field CSVs produce bounded, format-aware derived anomaly evidence without weakening human review or prompt-size limits.

**Architecture:** Format adapters will identify AEMO, LFP cell-array, or generic rows and expose an optional `computeDerivedAlarm(rowObj, acc, bucket)` hook. The streaming engine will keep only fixed-size rolling state and bounded summaries/contexts; prompt rendering will carry the derived evidence and source profiles under the existing character budget. Server prompts and strict schemas will select the relevant AEMO or cell-degradation hypothesis set, require evidence tiers and explicit disconfirmation/missing-signal fields, and reject unsupported physical-root-cause claims for cell-array input.

**Tech Stack:** Vanilla JavaScript, Node.js built-in test runner, Vite, Express, JSZip, Zod.

**Spec:** `tmp/CODEX_TASK.md`, `Log_sample/ESS_Public_Log_Analysis_Strategy_WDBESS1_LFP.md`

## Global Constraints

- Keep raw log files client-side and preserve bounded streaming memory; no full-file buffering.
- Keep `src/log-engine.js` and `server/lib/validation.js` `MAX_LOG_TEXT_CHARS` numerically synchronized at `300000`.
- AEMO entity grouping must prefer `FPP_UNITID` over `PARTICIPANTID`.
- Case A detection must use independent `MEASURED_MW` rolling statistics/ramp evidence, not a known incident timestamp or quality flag alone.
- Case B detection must derive cross-cell evidence from the row and must not hard-code Cell 8.
- Preserve `selectedHypId`/`finalSeverity` human-review gating in `src/pipeline.js`.
- Do not modify AI provider connection files unless required by the schema interface.
- Do not add or commit `Log_sample/` data; run `npm run test:unit` and `npm run build` before completion.
- Create root `DONE.md` with file-level changes, limitations, and follow-up work, then make one local commit without pushing.

---

### Task 1: Pin new format and derived-analysis contracts with tests

**Files:**
- Modify: `tests/unit/formats.test.js`
- Modify: `tests/unit/log-engine.test.js`
- Modify: `tests/unit/prompt-budget.test.js`
- Modify: `tests/server/validation.test.js`
- Create: `tests/unit/zip.test.js`

**Interfaces:**
- Consumes: current adapter, accumulator, prompt, validation, and ZIP helper APIs.
- Produces: executable expectations for LFP detection, FPP entity priority, AEMO robust statistics, cell Vdev/z-score output, schema evidence fields, and per-entry ZIP error formatting.

- [x] **Step 1: Add a failing LFP adapter test**

```js
test('detectFormat recognizes an LFP cell-array header without an entity column', () => {
  const header = 'Timestamp,U_Battery,I_Battery,SOC_Battery,U_Cell_1,U_Cell_2,U_Cell_3,U_Cell_4,U_Cell_5,U_Cell_6,U_Cell_7,U_Cell_8';
  const format = detectFormat([header]);
  assert.equal(format.id, 'lfp-cell-array');
  assert.equal(format.entityColumnGuess(format.parseHeaderRow(header).columns), null);
});
```

- [x] **Step 2: Add failing derived-alarm tests**

```js
test('AEMO derived detection flags an MEASURED_MW jump even when MW_QUALITY_FLAG is normal', () => {
  const rows = Array.from({ length: 9 }, (_, i) => `D,FPP,UNIT_MW,1,"2025/08/16 04:00:${String(i).padStart(2, '0')}","2025/08/16 04:00:${String(i).padStart(2, '0')}",WDBESS1,1,10,1,10,0,WDBESS1`);
  rows.push('D,FPP,UNIT_MW,1,"2025/08/16 04:01:00","2025/08/16 04:01:00",WDBESS1,1,-60,1,10,-70,WDBESS1');
  const acc = accumulate([AEMO_HEADER, ...rows].join('\n'), AEMO_MMS_FORMAT);
  assert.ok(acc.derived.alarmCount >= 1);
  assert.ok(acc.derived.metricStats.mwRobustZ.max >= 3);
});

test('LFP cell-array detection identifies the largest data-driven Vdev cell', () => {
  const rows = [
    '2025-01-01T00:00:00Z,26.4,0,50,3.3,3.3,3.3,3.3,3.3,3.3,3.3,3.3',
    '2025-01-01T00:00:05Z,26.4,0,50,3.3,3.3,3.3,3.3,3.3,3.3,3.3,3.8'
  ];
  const acc = accumulate([LFP_HEADER, ...rows].join('\n'));
  assert.equal(acc.derived.alarmCount, 1);
  assert.equal(acc.derived.categoryCounts.outlierCell['Cell 8'], 1);
  assert.ok(acc.derived.metricStats.maxAbsVdev.max > 0.4);
});
```

- [x] **Step 3: Run the focused tests and confirm the failures are caused by missing contracts**

Run: `node --test tests/unit/formats.test.js tests/unit/log-engine.test.js tests/server/validation.test.js tests/unit/zip.test.js`

Expected: FAIL because `lfp-cell-array`, derived accumulator summaries, new schema fields, and ZIP error helper are not implemented yet.

### Task 2: Implement format adapters and bounded derived alarms

**Files:**
- Modify: `src/formats.js`
- Modify: `src/log-engine.js`
- Modify: `tests/unit/formats.test.js`
- Modify: `tests/unit/log-engine.test.js`

**Interfaces:**
- Produces: `LFP_CELL_ARRAY_FORMAT`, `detectFormat()` support, `AEMO_MMS_FORMAT.computeDerivedAlarm()`, `LFP_CELL_ARRAY_FORMAT.computeDerivedAlarm()`, bounded `bucket.derived`, and aligned alarm annotations.

- [x] **Step 1: Implement header detection and FPP entity priority**
- [x] **Step 2: Implement rolling MEASURED_MW robust z-score/ramp state with a fixed window**
- [x] **Step 3: Implement leave-one-out cell Vdev, robust z-score, and optional voltage closure checks**
- [x] **Step 4: Record only capped contexts, metric stats, reasons, and category counts; run focused tests green**

### Task 3: Carry format profiles and derived evidence through the prompt budget

**Files:**
- Modify: `src/state.js`
- Modify: `src/pipeline.js`
- Modify: `src/render.js`
- Modify: `tests/unit/prompt-budget.test.js`

**Interfaces:**
- Produces: `sourceProfiles` from `blocksToPromptText()`, derived summaries/annotations in prompt blocks, and state propagation to every analysis stage while retaining the fixed `MAX_LOG_TEXT_CHARS` cap.

- [x] **Step 1: Add a failing prompt assertion for derived evidence and source profiles**
- [x] **Step 2: Include derived summaries and annotations in flat/grouped blocks**
- [x] **Step 3: Pass profiles into anomaly, hypothesis, and report API payloads and keep truncation explicit**
- [x] **Step 4: Display the detected format and derived alarm count without changing the human gate; run prompt tests green**

### Task 4: Make hypothesis prompts and schemas domain-aware and evidence-tiered

**Files:**
- Modify: `server/lib/prompts.js`
- Modify: `server/lib/schemas.js`
- Modify: `server/lib/validation.js`
- Modify: `server/routes/analysis.js`
- Modify: `src/pipeline.js`
- Modify: `src/render.js`
- Modify: `tests/server/validation.test.js`

**Interfaces:**
- Produces: expanded domain enums, required `evidenceTier`, `disconfirmingEvidence`, `missingSignals`, and `claimLimit` fields; contextual cell-array validation; domain-specific prompt sections.

- [x] **Step 1: Add failing schema tests for missing evidence fields and unsupported cell physical claims**
- [x] **Step 2: Add source-profile schemas and strict tool fields**
- [x] **Step 3: Implement AEMO/grid, cell-array, and generic prompt branches with explicit counter-evidence requirements**
- [x] **Step 4: Preserve report input compatibility and human review state while carrying the new fields; run server tests green**

### Task 5: Isolate ZIP entry failures

**Files:**
- Modify: `src/zip.js`
- Modify: `src/render.js`
- Create: `tests/unit/zip.test.js`

**Interfaces:**
- Produces: normalized per-entry error messages, probe/stream failure isolation, cleanup of early probe iterators, and visible error-level skip notes so a JSZip size mismatch does not abort sibling entries.

- [x] **Step 1: Add failing helper/iterator cleanup tests**
- [x] **Step 2: Normalize `uncompressed data size mismatch` as an entry-level error and keep catalog traversal going**
- [x] **Step 3: Mark corrupt log entries as `error`, corrupt nested archives as error-level skip notes, and render them distinctly**
- [x] **Step 4: Run ZIP-focused tests and the complete unit suite**

### Task 6: Documentation, verification, and handoff

**Files:**
- Modify: `README.md`
- Modify: `HANDOFF_TO_CLAUDE_CODE.md`
- Create: `DONE.md`

**Interfaces:**
- Produces: documented AEMO/LFP format behavior, evidence-tier/root-cause limitations, fixed prompt budget, and an exact file-level completion record.

- [x] **Step 1: Document the two adapter paths, independent anomaly rules, and no-Cell-8-hard-code behavior**
- [x] **Step 2: Document JSZip per-entry failure handling and intentionally unimplemented strategy phases**
- [x] **Step 3: Run `npm run test:unit` and `npm run build`; inspect `git diff --check`, status, and ignored `Log_sample/` files**
- [x] **Step 4: Create `DONE.md` from verified results, stage only intended files, and commit once locally**
