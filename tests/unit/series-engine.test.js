import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_SERIES_POINTS, parseTimestampMs, parseTimestamp, hasExplicitTimezone,
  formatTimestampAssumptionNote, downsampleMinMaxMean,
  createSeriesBuffer, pushSample, freezeSeries, primaryRange, frozenFromPairs,
  mergeFrozenSeries
} from '../../src/series-engine.js';
import { TIMESTAMP_ASSUMPTIONS } from '../../src/formats.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AEMO_TZ = TIMESTAMP_ASSUMPTIONS['aemo-mms'];
const LFP_TZ = TIMESTAMP_ASSUMPTIONS['lfp-cell-array'];
const GENERIC_TZ = TIMESTAMP_ASSUMPTIONS.generic;

test('parseTimestampMs treats timezone-less AEMO stamps as assumed AEST, not the machine zone', () => {
  const aemo = parseTimestampMs('2025/08/19 12:15:00', AEMO_TZ);
  const isoNaive = parseTimestampMs('2025-08-19T12:15:00', AEMO_TZ);
  assert.equal(aemo, Date.parse('2025-08-19T02:15:00.000Z'));
  assert.equal(isoNaive, Date.parse('2025-08-19T02:15:00.000Z'));
  assert.equal(parseTimestamp('2025/08/19 12:15:00', AEMO_TZ).kind, 'naive');
  assert.equal(hasExplicitTimezone('2025/08/19 12:15:00'), false);
});

test('parseTimestampMs does not reuse the AEMO assumption for LFP or generic CSV', () => {
  const wall = '2025/08/19 12:15:00';
  const aemo = parseTimestampMs(wall, AEMO_TZ);
  const lfp = parseTimestampMs(wall, LFP_TZ);
  const generic = parseTimestampMs(wall, GENERIC_TZ);
  assert.equal(aemo, Date.parse('2025-08-19T02:15:00.000Z'));
  assert.equal(lfp, Date.parse('2025-08-19T12:15:00.000Z'));
  assert.equal(generic, Date.parse('2025-08-19T12:15:00.000Z'));
  assert.notEqual(aemo, lfp);
});

test('parseTimestampMs with an explicit zone is unchanged by the format assumption', () => {
  const z = parseTimestampMs('2025-08-19T12:15:00Z', AEMO_TZ);
  const offset = parseTimestampMs('2025-08-19T12:15:00+10:00', LFP_TZ);
  const slashZ = parseTimestampMs('2025/08/19 12:15:00Z', GENERIC_TZ);
  assert.equal(z, Date.parse('2025-08-19T12:15:00.000Z'));
  assert.equal(offset, Date.parse('2025-08-19T02:15:00.000Z'));
  assert.equal(slashZ, Date.parse('2025-08-19T12:15:00.000Z'));
  assert.equal(parseTimestamp('2025-08-19T12:15:00Z', AEMO_TZ).explicitZone, true);
  assert.equal(hasExplicitTimezone('2025-08-19T12:15:00+10:00'), true);
});

test('parseTimestampMs numeric epoch input is unchanged', () => {
  assert.equal(parseTimestampMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(parseTimestampMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseTimestampMs(1_700_000_000, AEMO_TZ), 1_700_000_000_000);
  assert.equal(parseTimestamp('1700000000', AEMO_TZ), null);
});

test('timezone-less parseTimestampMs is stable across TZ environments', () => {
  const expr = `
    import { parseTimestampMs } from './src/series-engine.js';
    import { TIMESTAMP_ASSUMPTIONS } from './src/formats.js';
    const a = TIMESTAMP_ASSUMPTIONS['aemo-mms'];
    const l = TIMESTAMP_ASSUMPTIONS['lfp-cell-array'];
    console.log(JSON.stringify({
      aemo: parseTimestampMs('2025/08/19 12:15:00', a),
      lfp: parseTimestampMs('2018-04-28 09:46:25', l),
      zoned: parseTimestampMs('2025-08-19T12:15:00Z', a),
      epoch: parseTimestampMs(1700000000000)
    }));
  `;
  const run = (tz) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', expr], {
      cwd: ROOT,
      env: { ...process.env, TZ: tz },
      encoding: 'utf8'
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout.trim());
  };
  const utc = run('UTC');
  const seoul = run('Asia/Seoul');
  const ny = run('America/New_York');
  assert.deepEqual(utc, seoul);
  assert.deepEqual(utc, ny);
  assert.equal(utc.aemo, Date.parse('2025-08-19T02:15:00.000Z'));
  assert.equal(utc.lfp, Date.parse('2018-04-28T09:46:25.000Z'));
  assert.equal(utc.zoned, Date.parse('2025-08-19T12:15:00.000Z'));
  assert.equal(utc.epoch, 1700000000000);
});

test('formatTimestampAssumptionNote states the assumption instead of hiding it', () => {
  const note = formatTimestampAssumptionNote({
    ...AEMO_TZ,
    naiveCount: 12,
    zonedCount: 0
  });
  assert.match(note, /AEST/);
  assert.match(note, /CSV는 시간대를 적지 않음/);
  assert.match(note, /무표기 12행/);
  const zonedOnly = formatTimestampAssumptionNote({ naiveCount: 0, zonedCount: 4 });
  assert.match(zonedOnly, /명시된 시간대/);
  assert.equal(formatTimestampAssumptionNote({ naiveCount: 0, zonedCount: 0 }), '');
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
