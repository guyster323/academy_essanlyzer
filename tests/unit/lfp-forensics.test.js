import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  considerResistanceEvent, detectKnee, outlierCellByResistance, eventResistance,
  normalizeResistanceEvents, resistanceEventYearCounts, formatResistanceDropNote,
  RESISTANCE_BASELINE_KEEP, RESISTANCE_PER_BIN,
  RESISTANCE_RETENTION_POLICY
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

function feedResistanceEvents(events, times) {
  const cells = Array(8).fill(3.3);
  for (const t of times) {
    considerResistanceEvent(
      { t: t - 10, i: -4, cells, soc: 50, tMean: 20, bal: null },
      { t, i: -20, cells, soc: 50, tMean: 20, bal: null },
      events
    );
  }
  return events;
}

function largestInternalGap(events) {
  let gap = 0;
  let from = null;
  let to = null;
  for (let i = 1; i < events.length; i++) {
    const dt = events[i].t - events[i - 1].t;
    if (dt > gap) {
      gap = dt;
      from = events[i - 1].t;
      to = events[i].t;
    }
  }
  return { gap, from, to };
}

test('events under the cap stay complete, ordered, and drop nothing', () => {
  const events = [];
  const n = 120;
  feedResistanceEvents(events, Array.from({ length: n }, (_, i) => i * 1000 + 10));
  assert.equal(events.length, n);
  assert.equal(events.droppedCount || 0, 0);
  normalizeResistanceEvents(events);
  assert.equal(events.length, n);
  assert.equal(events.droppedCount || 0, 0);
  assert.equal(events[0].t, 10);
  assert.equal(events[n - 1].t, (n - 1) * 1000 + 10);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].t >= events[i - 1].t);
});

test('overflow past 4000 keeps a small early baseline, the newest event, and counts drops', () => {
  const events = [];
  const extra = 250;
  const total = MAX_RESISTANCE_EVENTS + extra;
  feedResistanceEvents(events, Array.from({ length: total }, (_, i) => i * 1000 + 10));
  normalizeResistanceEvents(events);
  assert.ok(events.length <= MAX_RESISTANCE_EVENTS);
  assert.equal(events.droppedCount, total - events.length);
  assert.equal(events[0].t, 10);
  const times = new Set(events.map(e => e.t));
  for (let i = 0; i < RESISTANCE_BASELINE_KEEP; i++) {
    assert.equal(times.has(i * 1000 + 10), true, `baseline event ${i} was dropped`);
  }
  assert.equal(events[events.length - 1].t, (total - 1) * 1000 + 10);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].t >= events[i - 1].t);
});

test('full-resolution Case B shape keeps every year and a sane max gap', () => {
  // 579,026 qualifying events over 2018-04-28..2022-01-10. The old
  // baseline+recent cap kept {2018:2000, 2022:2000} with a 1,344-day hole.
  const t0 = Date.UTC(2018, 3, 28);
  const t1 = Date.UTC(2022, 0, 10);
  const n = 579_026;
  const events = [];
  const times = new Array(n);
  const span = t1 - t0;
  for (let i = 0; i < n; i++) times[i] = t0 + Math.round((span * i) / (n - 1));
  feedResistanceEvents(events, times);
  normalizeResistanceEvents(events);

  assert.ok(events.length <= MAX_RESISTANCE_EVENTS);
  assert.ok(events.length >= RESISTANCE_BASELINE_KEEP + 8 * RESISTANCE_PER_BIN);
  assert.ok(
    events.length >= Math.floor(MAX_RESISTANCE_EVENTS * 0.9),
    `leftover cap slots should be used; kept ${events.length}`
  );
  assert.equal(events.droppedCount, n - events.length);
  assert.equal(events[0].t, t0);
  assert.equal(events[events.length - 1].t, t1);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].t >= events[i - 1].t);

  const years = events.yearCounts || resistanceEventYearCounts(events);
  for (const y of ['2018', '2019', '2020', '2021', '2022']) {
    assert.ok(years[y] > 0, `${y} retained 0 events (old cap left 2019-2021 empty)`);
  }
  const { gap } = largestInternalGap(events);
  const gapDays = gap / 86400000;
  const spanDays = span / 86400000;
  assert.ok(
    gap / span < 0.10,
    `largest gap ${gapDays.toFixed(1)} days is ${(100 * gap / span).toFixed(1)}% of ${spanDays.toFixed(1)}-day span`
  );

  assert.ok(events.yearCounts);
  assert.deepEqual(events.yearCounts, years);
  const note = formatResistanceDropNote(events.droppedCount, events.yearCounts);
  assert.equal(note.includes(RESISTANCE_RETENTION_POLICY), true);
  assert.equal(note.includes('2019:'), true);
  assert.equal(note.includes('2021:'), true);
});

test('empty time bins donate unused slots to occupied bins without dropping years', () => {
  // Two occupied clusters far apart so width-doubling leaves empty bins.
  const early = Date.UTC(2018, 3, 28);
  const late = Date.UTC(2022, 0, 6);
  const events = [];
  const times = [];
  for (let i = 0; i < 3000; i++) times.push(early + i * 60_000);
  for (let i = 0; i < 3000; i++) times.push(late + i * 60_000);
  feedResistanceEvents(events, times);
  normalizeResistanceEvents(events);
  assert.ok(events.length <= MAX_RESISTANCE_EVENTS);
  assert.ok(
    events.length > RESISTANCE_BASELINE_KEEP + 20 * RESISTANCE_PER_BIN,
    `occupied bins should keep more than the 58-per-bin floor; kept ${events.length}`
  );
  const years = events.yearCounts || resistanceEventYearCounts(events);
  assert.ok(years['2018'] > 0);
  assert.ok(years['2022'] > 0);
  assert.equal(events[0].t, times[0]);
  assert.equal(events[events.length - 1].t, times[times.length - 1]);
});
