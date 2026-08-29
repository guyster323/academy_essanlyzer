import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  considerResistanceEvent, detectKnee, outlierCellByResistance, eventResistance,
  normalizeResistanceEvents, RESISTANCE_BASELINE_KEEP
} from '../../src/forensics/lfp.js';
import { MAX_RESISTANCE_EVENTS } from '../../src/series-engine.js';

const fixture = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/case-b-resistance-knee.json'),
  'utf8'
));

function cellVoltages(rByCell, iAmp) {
  // V = 3.3 - I*R  with I negative on discharge → voltage drop = |I|*R
  return rByCell.map(r => 3.30 - iAmp * r);
}

function buildEvents() {
  const events = [];
  const t0 = Date.UTC(2017, 0, 1);
  for (let day = 0; day < fixture.days; day += 7) {
    const age = day;
    const r = Array.from({ length: 8 }, (_, i) => {
      const cell = i + 1;
      let val = fixture.nominalR;
      if (cell === fixture.resistanceCell) {
        val += fixture.preKneeSlope * age;
        if (age >= fixture.kneeDay) val += fixture.postKneeSlope * (age - fixture.kneeDay);
      }
      return val;
    });
    const i0 = 4;
    const i1 = Math.abs(fixture.currentA);
    const prev = { t: t0 + day * 86400000, i: i0, cells: cellVoltages(r, i0), soc: 70, tMean: 25, bal: null };
    const curr = { t: prev.t + 5000, i: i1, cells: cellVoltages(r, i1), soc: 70, tMean: 25, bal: null };
    considerResistanceEvent(prev, curr, events);
  }
  return events;
}

test('eventResistance is -dV/dI', () => {
  // Voltage drop with a positive ΔI (strategy: R ≈ -ΔV/ΔI).
  const r = eventResistance([3.3, 3.3], [3.2, 3.25], 10);
  assert.ok(Math.abs(r[0] - 0.01) < 1e-9);
  assert.ok(Math.abs(r[1] - 0.005) < 1e-9);
});

test('knee fixture attributes resistance divergence to Cell 8, not the Vdev spike cell', () => {
  const events = buildEvents();
  assert.ok(events.length > 20);
  const out = outlierCellByResistance(events);
  assert.equal(out.cell, fixture.resistanceCell);
  const cell8 = events.map(e => ({ t: e.t, r: e.r[fixture.resistanceCell - 1] }));
  const knee = detectKnee(cell8);
  assert.equal(knee.available, true);
  const kneeDay = (knee.t - Date.UTC(2017, 0, 1)) / 86400000;
  assert.ok(Math.abs(kneeDay - fixture.kneeDay) < 250, `kneeDay=${kneeDay}`);
});

test('a 1000 A inrush is kept and flagged, not deleted', () => {
  const events = [];
  const cells = [3.3, 3.3, 3.3, 3.3, 3.3, 3.3, 3.3, 3.3];
  const prev = { t: 0, i: -10, cells, soc: 50, tMean: 20, bal: null };
  const curr = { t: 5000, i: -1200, cells: cells.map(v => v - 0.05), soc: 50, tMean: 20, bal: null };
  const ev = considerResistanceEvent(prev, curr, events);
  assert.ok(ev);
  assert.equal(ev.highCurrent, true);
  assert.equal(events.length, 1);
});

test('resistance event list stays within the cap', () => {
  const events = [];
  const cells = Array(8).fill(3.3);
  for (let i = 0; i < MAX_RESISTANCE_EVENTS + 50; i++) {
    considerResistanceEvent(
      { t: i * 1000, i: -4, cells, soc: 50, tMean: 20, bal: null },
      { t: i * 1000 + 10, i: -20, cells, soc: 50, tMean: 20, bal: null },
      events
    );
  }
  assert.ok(events.length <= MAX_RESISTANCE_EVENTS);
});

test('overflow past 4000 keeps the early baseline and the most recent events, and counts drops', () => {
  const events = [];
  const cells = Array(8).fill(3.3);
  const extra = 250;
  const total = MAX_RESISTANCE_EVENTS + extra;
  for (let i = 0; i < total; i++) {
    considerResistanceEvent(
      { t: i * 1000, i: -4, cells, soc: 50, tMean: 20, bal: null },
      { t: i * 1000 + 10, i: -20, cells, soc: 50, tMean: 20, bal: null },
      events
    );
  }
  normalizeResistanceEvents(events);
  assert.equal(events.length, MAX_RESISTANCE_EVENTS);
  assert.equal(events.droppedCount, extra);
  // Early baseline (first half) is preserved.
  assert.equal(events[0].t, 10);
  assert.equal(events[RESISTANCE_BASELINE_KEEP - 1].t, (RESISTANCE_BASELINE_KEEP - 1) * 1000 + 10);
  // Most recent events survive — this is the late-stage knee window.
  const last = events[events.length - 1];
  assert.equal(last.t, (total - 1) * 1000 + 10);
  const times = new Set(events.map(e => e.t));
  assert.equal(times.has((total - 1) * 1000 + 10), true);
  assert.equal(times.has((total - extra) * 1000 + 10), true);
  // The first overflow victim (oldest of the original recent half) is gone.
  assert.equal(times.has(RESISTANCE_BASELINE_KEEP * 1000 + 10), false);
});
