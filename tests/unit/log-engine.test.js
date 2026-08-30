import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAccumulator, feedLine, applyAccumulatorToSource, streamIntoSource, LINES_PER_YIELD } from '../../src/log-engine.js';
import { MAX_SERIES_POINTS, MAX_RESISTANCE_EVENTS } from '../../src/series-engine.js';
import { detectFormat, GENERIC_FORMAT, AEMO_MMS_FORMAT } from '../../src/formats.js';

const AEMO_HEADER = 'I,FPP,UNIT_MW,1,INTERVAL_DATETIME,MEASUREMENT_DATETIME,FPP_UNITID,VERSIONNO,MEASURED_MW,MW_QUALITY_FLAG,SCHEDULED_MW,DEVIATION_MW,PARTICIPANTID';
const LFP_HEADER = 'Timestamp,U_Battery,I_Battery,SOC_Battery,U_Cell_1,U_Cell_2,U_Cell_3,U_Cell_4,U_Cell_5,U_Cell_6,U_Cell_7,U_Cell_8';

function accumulate(text, format) {
  const fmt = format || detectFormat(text.split(/\r?\n/).filter(l => l.trim()));
  const acc = makeAccumulator(fmt);
  text.split(/\r?\n/).forEach(line => { if (line.trim()) feedLine(acc, line); });
  return acc;
}

test('a status column with a normal value produces zero alarms', () => {
  const acc = accumulate('timestamp,status\n2026-08-26 10:00:00,Charging', GENERIC_FORMAT);
  assert.equal(acc.alarmCount, 0);
});

test('a status column with a non-normal value produces one alarm', () => {
  const acc = accumulate('timestamp,status\n2026-08-26 10:00:00,Fault', GENERIC_FORMAT);
  assert.equal(acc.alarmCount, 1);
});

test('a line with a quoted comma and an escaped quote parses into the correct number of columns', () => {
  const acc = accumulate('timestamp,note,alarm_code\n2026-08-26 10:00:00,"hello, world",0', GENERIC_FORMAT);
  assert.equal(acc.malformedRowCount, 0);
  assert.equal(acc.headSample[0].note, 'hello, world');
  assert.equal(acc.alarmCount, 0);
});

test('an unterminated quoted field is counted as malformed, not silently misparsed', () => {
  const acc = accumulate('timestamp,note,alarm_code\n2026-08-26 10:00:00,"unterminated,0', GENERIC_FORMAT);
  assert.equal(acc.malformedRowCount, 1);
  assert.equal(acc.rowCount, 0);
});

test('regression: OV001 alarm code sample from the original prototype still triggers an alarm', () => {
  const acc = accumulate(
    'timestamp,voltage_V,current_A,temp_C,soc_pct,alarm_code\n' +
    '2024-06-03 10:32:11,3.91,15.2,31.7,87,OV001',
    GENERIC_FORMAT
  );
  assert.equal(acc.alarmCount, 1);
  assert.equal(acc.alarmColumn, 'alarm_code');
});

test('regression: AEMO MW_QUALITY_FLAG != 1 still triggers an alarm and stats stay bounded to real columns', () => {
  const comment = 'C,SETP.WORLD,NEXT_DAY_FPPMW,AEMO,PUBLIC,2025/08/17,07:00:12,1,NEXT_DAY_FPP_MW,1';
  const row1 = 'D,FPP,UNIT_MW,1,"2025/08/16 04:05:00","2025/08/16 04:00:04",BALB1,1,0.00000000,1,0.00000,0.00000,BALBESS';
  const row2 = 'D,FPP,UNIT_MW,1,"2025/08/16 04:05:00","2025/08/16 04:00:08",BALB1,1,0.00000000,2,0.00000,0.00000,BALBESS';
  const acc = accumulate([comment, AEMO_HEADER, row1, row2].join('\n'), AEMO_MMS_FORMAT);
  assert.equal(acc.alarmCount, 1);
  assert.ok(acc.groups.BALB1);
  assert.equal(acc.groups.BALBESS, undefined);
  assert.ok(!('INTERVAL_DATETIME' in (acc.groups.BALB1.stats)));
  assert.ok(!('MEASUREMENT_DATETIME' in (acc.groups.BALB1.stats)));
  assert.ok('MEASURED_MW' in acc.groups.BALB1.stats);
});

test('AEMO derived detection flags an MEASURED_MW jump even when MW_QUALITY_FLAG is normal', () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    `D,FPP,UNIT_MW,1,"2025/08/16 04:00:${String(i).padStart(2, '0')}","2025/08/16 04:00:${String(i).padStart(2, '0')}",WDBESS1,1,10,1,10,0,WDBESS1`
  );
  rows.push('D,FPP,UNIT_MW,1,"2025/08/16 04:01:00","2025/08/16 04:01:00",WDBESS1,1,-60,1,10,-70,WDBESS1');
  const acc = accumulate([AEMO_HEADER, ...rows].join('\n'), AEMO_MMS_FORMAT);
  const derived = acc.groups.WDBESS1.derived;
  assert.ok(derived.alarmCount >= 1);
  assert.ok(derived.metricStats.mwRobustZ.max >= 3);
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

test('LFP cell-array leaves normal peer-cell rows unalarmed', () => {
  const row = '2025-01-01T00:00:00Z,26.4,0,50,3.30,3.31,3.30,3.30,3.31,3.30,3.30,3.31';
  const acc = accumulate([LFP_HEADER, row].join('\n'));
  assert.equal(acc.alarmCount, 0);
  assert.equal(acc.derived.alarmCount, 0);
});

test('generic 10k-row stream keeps series bins within MAX_SERIES_POINTS and preserves the voltage spike', () => {
  const lines = ['timestamp,voltage_V,alarm_code'];
  for (let i = 0; i < 10_000; i++) {
    const v = i === 5000 ? 4.2 : 3.5;
    const alarm = i === 5000 ? 'OV001' : '0';
    const ts = new Date(Date.UTC(2024, 5, 3, 0, 0, i)).toISOString();
    lines.push(`${ts},${v},${alarm}`);
  }
  const acc = accumulate(lines.join('\n'), GENERIC_FORMAT);
  const src = { name: 'paste.csv', encoding: 'utf-8', format: GENERIC_FORMAT };
  applyAccumulatorToSource(src, acc);
  const frozen = Object.values(src.seriesByEntity)[0];
  assert.ok(frozen);
  assert.ok(frozen.bins.length <= MAX_SERIES_POINTS);
  assert.ok(Math.max(...frozen.bins.map(b => b.max.value)) >= 4.2);
});

test('AEMO grouped stream freezes per-entity MW series', () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    `D,FPP,UNIT_MW,1,"2025/08/19 11:00:${String(i).padStart(2, '0')}","2025/08/19 11:00:${String(i).padStart(2, '0')}",WDBESS1,1,${i === 11 ? -40 : 10},1,10,0,WDBESS1`
  );
  const acc = accumulate([AEMO_HEADER, ...rows].join('\n'), AEMO_MMS_FORMAT);
  const src = { name: 'aemo.csv', encoding: 'utf-8', format: AEMO_MMS_FORMAT };
  applyAccumulatorToSource(src, acc);
  assert.ok(src.seriesByEntity.WDBESS1);
  assert.ok(src.seriesByEntity.WDBESS1.bins.length >= 2);
  assert.ok(src.seriesByEntity.WDBESS1.signals.includes('mw'));
});

test('LFP stream past MAX_RESISTANCE_EVENTS keeps recent events and reports the drop count', () => {
  const extra = 80;
  const rows = MAX_RESISTANCE_EVENTS + extra + 1;
  const lines = [LFP_HEADER];
  const t0 = Date.UTC(2017, 0, 1);
  for (let i = 0; i < rows; i++) {
    const amp = i % 2 === 0 ? -4 : -20;
    const ts = new Date(t0 + i * 86400000).toISOString();
    lines.push(`${ts},26.4,${amp},50,3.30,3.30,3.30,3.30,3.30,3.30,3.30,3.30`);
  }
  const acc = accumulate(lines.join('\n'));
  const src = { name: 'data_sys_6.csv', encoding: 'utf-8', format: acc.format };
  applyAccumulatorToSource(src, acc);
  const events = Object.values(src.resistanceEventsByEntity)[0];
  assert.ok(events);
  assert.equal(events.length, MAX_RESISTANCE_EVENTS);
  assert.equal(src.droppedResistanceEvents, extra);
  const lastT = events[events.length - 1].t;
  const expectedLast = t0 + (rows - 1) * 86400000;
  assert.equal(lastT, expectedLast);
  const firstT = events[0].t;
  assert.equal(firstT, t0 + 1 * 86400000); // first qualifying event is curr of row 1
});

test('streamIntoSource profile records per-phase timings without changing row counts', async () => {
  const lines = ['timestamp,voltage_V,alarm_code'];
  for (let i = 0; i < 5000; i++) {
    lines.push(`2024-06-03T00:00:00.${String(i).padStart(3, '0')}Z,3.50,0`);
  }
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
  async function* chunks() {
    const size = 2048;
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
    }
  }
  const src = { name: 'profile.csv', encoding: 'utf-8', format: GENERIC_FORMAT };
  const profile = {};
  await streamIntoSource(src, chunks(), () => {}, { profile });
  assert.equal(src.rowCount, 5000);
  assert.ok(profile.chunkCount > 1);
  assert.ok(profile.yieldCount > 1);
  assert.ok(profile.feedLineMs >= 0);
  assert.ok(profile.feedParseMs >= 0);
  assert.ok(profile.feedDerivedMs >= 0);
  assert.ok(profile.feedSeriesMs >= 0);
  assert.ok(profile.feedForensicsMs >= 0);
  assert.ok(profile.feedStatsMs >= 0);
  const feedParts = profile.feedParseMs + profile.feedDerivedMs + profile.feedSeriesMs
    + profile.feedForensicsMs + profile.feedStatsMs;
  assert.ok(feedParts <= profile.feedLineMs + 5, `feed subphases ${feedParts} vs feedLineMs ${profile.feedLineMs}`);
  assert.ok(profile.decodeMs >= 0);
  assert.ok(profile.splitMs >= 0);
  assert.ok(profile.yieldWaitMs >= 0);
  assert.ok(profile.inflateOrReadMs >= 0);
  assert.equal(profile.nonemptyLineCount, 5001); // header + 5000 data rows
});

test('streamIntoSource yields every LINES_PER_YIELD lines, not once per byte chunk', async () => {
  const dataRows = LINES_PER_YIELD * 2 + 100;
  const lines = ['timestamp,voltage_V,alarm_code'];
  for (let i = 0; i < dataRows; i++) {
    lines.push(`2024-06-03T00:00:00.${String(i).padStart(3, '0')}Z,3.50,0`);
  }
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
  async function* tinyChunks() {
    const size = 64;
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
    }
  }
  const src = { name: 'yield.csv', encoding: 'utf-8', format: GENERIC_FORMAT };
  const profile = {};
  await streamIntoSource(src, tinyChunks(), () => {}, { profile });
  assert.equal(src.rowCount, dataRows);
  assert.ok(profile.chunkCount > 50, `expected many chunks, got ${profile.chunkCount}`);
  assert.equal(profile.yieldCount, 2);
  assert.ok(profile.chunkCount > profile.yieldCount);
});
