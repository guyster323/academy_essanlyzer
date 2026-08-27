import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAccumulator, feedLine } from '../../src/log-engine.js';
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
