import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDelimitedLine, GENERIC_FORMAT, AEMO_MMS_FORMAT, LFP_CELL_ARRAY_FORMAT,
  detectFormat
} from '../../src/formats.js';

test('parseDelimitedLine handles a quoted delimiter and an escaped quote', () => {
  assert.deepEqual(parseDelimitedLine('a,"hello,world","x""y"', ','), ['a', 'hello,world', 'x"y']);
});

test('parseDelimitedLine returns null for an unterminated quoted field (malformed)', () => {
  assert.equal(parseDelimitedLine('a,"unterminated,b', ','), null);
});

test('parseDelimitedLine trims unquoted cells but preserves quoted content verbatim', () => {
  assert.deepEqual(parseDelimitedLine(' a ,"  b  "', ','), ['a', '  b  ']);
});

test('GENERIC_FORMAT: status column with normal operational values is not flagged as an alarm', () => {
  const col = 'status';
  assert.equal(GENERIC_FORMAT.isAlarmValue('Charging', col), false);
  assert.equal(GENERIC_FORMAT.isAlarmValue('Discharging', col), false);
  assert.equal(GENERIC_FORMAT.isAlarmValue('Idle', col), false);
  assert.equal(GENERIC_FORMAT.isAlarmValue('0', col), false);
});

test('GENERIC_FORMAT: status column with a non-normal value is flagged as an alarm', () => {
  assert.equal(GENERIC_FORMAT.isAlarmValue('Fault', 'status'), true);
});

test('GENERIC_FORMAT: an explicit alarm/fault code column keeps the strict non-zero rule', () => {
  assert.equal(GENERIC_FORMAT.isAlarmValue('OV001', 'alarm_code'), true);
  assert.equal(GENERIC_FORMAT.isAlarmValue('0', 'alarm_code'), false);
});

test('GENERIC_FORMAT: alarmColumnGuess prefers an alarm/fault column over a status column', () => {
  assert.equal(GENERIC_FORMAT.alarmColumnGuess(['timestamp', 'status', 'alarm_code']), 'alarm_code');
  assert.equal(GENERIC_FORMAT.alarmColumnGuess(['timestamp', 'status']), 'status');
});

test('AEMO_MMS_FORMAT quality flag alarm rule is unaffected by the status allowlist change', () => {
  assert.equal(AEMO_MMS_FORMAT.isAlarmValue('1'), false);
  assert.equal(AEMO_MMS_FORMAT.isAlarmValue('2'), true);
  assert.equal(AEMO_MMS_FORMAT.isAlarmValue('0'), true);
});

test('detectFormat still recognizes the AEMO MMS C/I/D header shape', () => {
  const lines = ['C,SETP.WORLD,NEXT_DAY_FPPMW,AEMO,PUBLIC,2025/08/17', 'I,FPP,UNIT_MW,1,INTERVAL_DATETIME,MEASUREMENT_DATETIME'];
  assert.equal(detectFormat(lines), AEMO_MMS_FORMAT);
});

test('detectFormat recognizes an LFP cell-array header without an entity column', () => {
  const header = 'Timestamp,U_Battery,I_Battery,SOC_Battery,U_Cell_1,U_Cell_2,U_Cell_3,U_Cell_4,U_Cell_5,U_Cell_6,U_Cell_7,U_Cell_8';
  const format = detectFormat([header]);
  assert.equal(format, LFP_CELL_ARRAY_FORMAT);
  assert.equal(format.entityColumnGuess(format.parseHeaderRow(header).columns), null);
  assert.equal(format.alarmColumnGuess(format.parseHeaderRow(header).columns), null);
});

test('AEMO entity guessing prefers the physical FPP unit over the market participant', () => {
  assert.equal(
    AEMO_MMS_FORMAT.entityColumnGuess(['FPP_UNITID', 'PARTICIPANTID', 'MEASURED_MW']),
    'FPP_UNITID'
  );
});
