import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SERIES_POINTS, parseTimestampMs, downsampleMinMaxMean,
  createSeriesBuffer, pushSample, freezeSeries, primaryRange, frozenFromPairs,
  mergeFrozenSeries
} from '../../src/series-engine.js';

test('parseTimestampMs accepts AEMO slash dates and ISO strings', () => {
  const aemo = parseTimestampMs('2025/08/19 12:15:00');
  const iso = parseTimestampMs('2025-08-19T12:15:00');
  assert.ok(Number.isFinite(aemo));
  assert.ok(Number.isFinite(iso));
  assert.equal(new Date(aemo).getMinutes(), 15);
});

test('downsampleMinMaxMean preserves a mid-series spike in some bin max', () => {
  const points = [];
  for (let i = 0; i < 5000; i++) {
    const v = i === 2500 ? 99 : 1;
    points.push({ t: i * 1000, values: { mw: v } });
  }
  const bins = downsampleMinMaxMean(points, 200);
  assert.ok(bins.length <= 200);
  assert.ok(bins.length >= 2);
  const maxMax = Math.max(...bins.map(b => b.max.mw));
  assert.equal(maxMax, 99);
});

test('adaptive buffer never exceeds MAX_SERIES_POINTS and still keeps the spike', () => {
  const buffer = createSeriesBuffer({ signals: ['mw'], maxPoints: MAX_SERIES_POINTS, binMode: 'adaptive' });
  for (let i = 0; i < 10_000; i++) {
    const mw = i === 7777 ? -80 : 10;
    pushSample(buffer, 'WDBESS1', Date.UTC(2025, 7, 19, 0, 0, i), { mw });
  }
  const frozen = freezeSeries(buffer);
  assert.ok(frozen.bins.length <= MAX_SERIES_POINTS);
  assert.ok(frozen.sampleCount === 10_000);
  assert.ok(Math.min(...frozen.bins.map(b => b.min.mw)) <= -80);
  assert.ok(primaryRange(frozen, 'mw') >= 90);
});

test('day binning collapses many rows on the same calendar day to one bin', () => {
  const buffer = createSeriesBuffer({ signals: ['vRange'], maxPoints: 2000, binMode: 'day' });
  const day0 = new Date(2020, 0, 1).getTime();
  for (let i = 0; i < 500; i++) pushSample(buffer, '_file', day0 + i * 5000, { vRange: 0.01 });
  const day1 = new Date(2020, 0, 2).getTime();
  pushSample(buffer, '_file', day1, { vRange: 0.4 });
  const frozen = freezeSeries(buffer);
  assert.equal(frozen.bins.length, 2);
  assert.equal(frozen.bins[1].max.vRange, 0.4);
});

test('frozenFromPairs round-trips a short fixture series', () => {
  const frozen = frozenFromPairs('WDBESS1', [[0, 50], [4000, 50], [8000, 5]], 'mw');
  assert.equal(frozen.entityId, 'WDBESS1');
  assert.equal(frozen.bins.length, 3);
  assert.equal(frozen.bins[2].mean.mw, 5);
});

test('mergeFrozenSeries sorts bins by time even when the later source is earlier', () => {
  const first = frozenFromPairs('U', [[5000, 5], [6000, 6]], 'mw');
  const second = frozenFromPairs('U', [[1000, 1], [2000, 2]], 'mw');
  const merged = mergeFrozenSeries(first, second);
  assert.deepEqual(merged.bins.map(b => b.t), [1000, 2000, 5000, 6000]);
  assert.equal(merged.sampleCount, 4);
});

test('mergeFrozenSeries does not insert points into a time gap', () => {
  const left = frozenFromPairs('U', [[0, 1], [1000, 2]], 'mw');
  const right = frozenFromPairs('U', [[1_000_000, 3], [1_001_000, 4]], 'mw');
  const merged = mergeFrozenSeries(left, right);
  const times = merged.bins.map(b => b.t);
  assert.deepEqual(times, [0, 1000, 1_000_000, 1_001_000]);
  assert.equal(times.some(t => t > 1000 && t < 1_000_000), false);
});

test('mergeFrozenSeries pairwise-rebins so the result stays within MAX_SERIES_POINTS and keeps a spike', () => {
  const leftPairs = [];
  const rightPairs = [];
  for (let i = 0; i < MAX_SERIES_POINTS; i++) leftPairs.push([i, 1]);
  for (let i = 0; i < MAX_SERIES_POINTS; i++) {
    const t = MAX_SERIES_POINTS + i;
    rightPairs.push([t, t === MAX_SERIES_POINTS + 10 ? 80 : 1]);
  }
  const left = frozenFromPairs('U', leftPairs, 'mw', MAX_SERIES_POINTS);
  const right = frozenFromPairs('U', rightPairs, 'mw', MAX_SERIES_POINTS);
  const merged = mergeFrozenSeries(left, right, MAX_SERIES_POINTS);
  assert.ok(merged.bins.length <= MAX_SERIES_POINTS);
  assert.ok(merged.bins.length >= 2);
  assert.equal(Math.max(...merged.bins.map(b => b.max.mw)), 80);
  const times = merged.bins.map(b => b.t);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);
});
