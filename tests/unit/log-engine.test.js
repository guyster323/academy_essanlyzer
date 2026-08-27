import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAccumulator, feedLine } from '../../src/log-engine.js';
import { detectFormat, GENERIC_FORMAT, AEMO_MMS_FORMAT } from '../../src/formats.js';

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
  const header = 'I,FPP,UNIT_MW,1,INTERVAL_DATETIME,MEASUREMENT_DATETIME,FPP_UNITID,VERSIONNO,MEASURED_MW,MW_QUALITY_FLAG,SCHEDULED_MW,DEVIATION_MW,PARTICIPANTID';
  const comment = 'C,SETP.WORLD,NEXT_DAY_FPPMW,AEMO,PUBLIC,2025/08/17,07:00:12,1,NEXT_DAY_FPP_MW,1';
  const row1 = 'D,FPP,UNIT_MW,1,"2025/08/16 04:05:00","2025/08/16 04:00:04",BALB1,1,0.00000000,1,0.00000,0.00000,BALBESS';
  const row2 = 'D,FPP,UNIT_MW,1,"2025/08/16 04:05:00","2025/08/16 04:00:08",BALB1,1,0.00000000,2,0.00000,0.00000,BALBESS';
  const acc = accumulate([comment, header, row1, row2].join('\n'), AEMO_MMS_FORMAT);
  assert.equal(acc.alarmCount, 1);
  assert.ok(!('INTERVAL_DATETIME' in (acc.groups.BALBESS.stats)));
  assert.ok(!('MEASUREMENT_DATETIME' in (acc.groups.BALBESS.stats)));
  assert.ok('MEASURED_MW' in acc.groups.BALBESS.stats);
});
