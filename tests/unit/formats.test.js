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

test('AEMO seriesSignals lists deviation-based names and seriesSignalsFor omits them when columns are absent', () => {
  assert.ok(AEMO_MMS_FORMAT.seriesSignals.includes('scheduledMw'));
  assert.ok(AEMO_MMS_FORMAT.seriesSignals.includes('deviationMw'));
  assert.deepEqual(
    AEMO_MMS_FORMAT.seriesSignalsFor(['INTERVAL_DATETIME', 'MEASURED_MW', 'MW_QUALITY_FLAG']),
    ['mw', 'quality', 'deltaMw']
  );
  assert.deepEqual(
    AEMO_MMS_FORMAT.seriesSignalsFor([
      'MEASURED_MW', 'MW_QUALITY_FLAG', 'SCHEDULED_MW', 'DEVIATION_MW'
    ]),
    ['mw', 'quality', 'deltaMw', 'scheduledMw', 'deviationMw']
  );
});

test('extractSeriesSample omits scheduled/deviation when those columns are absent', () => {
  const sample = AEMO_MMS_FORMAT.extractSeriesSample({
    MEASUREMENT_DATETIME: '2025/08/16 04:00:00',
    MEASURED_MW: '12.5',
    MW_QUALITY_FLAG: '1'
  }, {}, {});
  assert.equal(sample.values.mw, 12.5);
  assert.equal(sample.values.quality, 1);
  assert.equal('scheduledMw' in sample.values, false);
  assert.equal('deviationMw' in sample.values, false);
});

test('AEMO extractSeriesSample interprets timezone-less stamps as assumed AEST', () => {
  const sample = AEMO_MMS_FORMAT.extractSeriesSample({
    MEASUREMENT_DATETIME: '2025/08/19 12:15:00',
    MEASURED_MW: '12.5',
    MW_QUALITY_FLAG: '1'
  }, {}, {});
  assert.equal(sample.t, Date.parse('2025-08-19T02:15:00.000Z'));
});

test('LFP extractSeriesSample does not apply the AEMO AEST assumption', () => {
  const row = {
    Timestamp: '2018-04-28 09:46:25',
    U_Battery: '26.4',
    I_Battery: '0',
    SOC_Battery: '50'
  };
  for (let i = 1; i <= 8; i++) row[`U_Cell_${i}`] = '3.3';
  const sample = LFP_CELL_ARRAY_FORMAT.extractSeriesSample(row);
  assert.equal(sample.t, Date.parse('2018-04-28T09:46:25.000Z'));
  assert.notEqual(sample.t, Date.parse('2018-04-27T23:46:25.000Z'));
});

test('extractSeriesSample includes scheduled/deviation when the row has finite values', () => {
  const sample = AEMO_MMS_FORMAT.extractSeriesSample({
    MEASUREMENT_DATETIME: '2025/08/16 04:00:00',
    MEASURED_MW: '12.5',
    MW_QUALITY_FLAG: '1',
    SCHEDULED_MW: '10',
    DEVIATION_MW: '2.5'
  }, {}, {});
  assert.equal(sample.values.scheduledMw, 10);
  assert.equal(sample.values.deviationMw, 2.5);
});

function aemoDerivedSequence(rows) {
  const bucket = {};
  const acc = {};
  return rows.map(row => AEMO_MMS_FORMAT.computeDerivedAlarm(row, acc, bucket));
}

test('DEVIATION_MW target-deviation rule fires on a material residual while MEASURED_MW stays flat', () => {
  const baseline = Array.from({ length: 9 }, () => ({
    MEASURED_MW: '50', SCHEDULED_MW: '50', DEVIATION_MW: '0'
  }));
  const spike = { MEASURED_MW: '50', SCHEDULED_MW: '80', DEVIATION_MW: '-30' };
  const results = aemoDerivedSequence([...baseline, spike]);
  const last = results[results.length - 1];
  assert.equal(last.alarm, true);
  assert.equal(last.reasonCode, 'DEVIATION_MW target deviation');
  assert.ok(last.reason.includes('DEVIATION_MW'));
  assert.ok(!last.reason.includes('MEASURED_MW 독립 이상'));
  assert.equal(last.categories.signal, 'DEVIATION_MW');
  assert.deepEqual(last.details.rulesFired, ['DEVIATION_MW target deviation']);
});

test('DEVIATION_MW target-deviation rule does not fire on a small residual', () => {
  const baseline = Array.from({ length: 9 }, () => ({
    MEASURED_MW: '50', SCHEDULED_MW: '50', DEVIATION_MW: '0'
  }));
  const small = { MEASURED_MW: '50', SCHEDULED_MW: '51', DEVIATION_MW: '-1' };
  const results = aemoDerivedSequence([...baseline, small]);
  const last = results[results.length - 1];
  assert.equal(last.alarm, false);
  assert.ok(!last.details.rulesFired.includes('DEVIATION_MW target deviation'));
});

test('MEASURED_MW statistical rule still fires when DEVIATION_MW stays near zero', () => {
  const baseline = Array.from({ length: 9 }, () => ({
    MEASURED_MW: '10', SCHEDULED_MW: '10', DEVIATION_MW: '0'
  }));
  const jump = { MEASURED_MW: '-60', SCHEDULED_MW: '-60', DEVIATION_MW: '0' };
  const results = aemoDerivedSequence([...baseline, jump]);
  const last = results[results.length - 1];
  assert.equal(last.alarm, true);
  assert.equal(last.reasonCode, 'MEASURED_MW statistical/ramp anomaly');
  assert.ok(last.reason.includes('MEASURED_MW'));
  assert.ok(!last.reason.includes('DEVIATION_MW 타깃 편차'));
  assert.ok(last.metrics.mwRobustZ >= 3);
});

test('computeDerivedAlarm degrades to MEASURED_MW-only when DEVIATION_MW is absent', () => {
  const baseline = Array.from({ length: 9 }, () => ({ MEASURED_MW: '10' }));
  const jump = { MEASURED_MW: '-60' };
  const results = aemoDerivedSequence([...baseline, jump]);
  const last = results[results.length - 1];
  assert.equal(last.alarm, true);
  assert.equal(last.reasonCode, 'MEASURED_MW statistical/ramp anomaly');
  assert.equal(last.metrics.deviationAbs, 0);
});

function plateauRow(deviationMw, quality = '1') {
  return {
    MEASURED_MW: '20',
    SCHEDULED_MW: '20',
    DEVIATION_MW: String(deviationMw),
    MW_QUALITY_FLAG: quality
  };
}

test('DEVIATION_MW sustained rule fires on a long material plateau and not on a brief spike', () => {
  const onTarget = Array.from({ length: 10 }, () => plateauRow(0));
  const spike = Array.from({ length: 20 }, () => plateauRow(20));
  const spikeResults = aemoDerivedSequence([...onTarget, ...spike]);
  assert.equal(spikeResults.some(r => (r.details.rulesFired || []).includes('DEVIATION_MW sustained deviation')), false);

  const plateau = Array.from({ length: 80 }, () => plateauRow(20));
  const plateauResults = aemoDerivedSequence([...onTarget, ...plateau]);
  const firstSustained = plateauResults.findIndex(r => (r.details.rulesFired || []).includes('DEVIATION_MW sustained deviation'));
  assert.ok(firstSustained >= 0, 'sustained plateau should fire');
  assert.equal(firstSustained, onTarget.length + 75 - 1);
  const last = plateauResults[plateauResults.length - 1];
  assert.equal(last.alarm, true);
  assert.ok(last.details.rulesFired.includes('DEVIATION_MW sustained deviation'));
  assert.ok(!last.details.rulesFired.includes('MEASURED_MW statistical/ramp anomaly'));
  assert.equal(last.categories.signal, 'DEVIATION_MW');
  assert.ok(last.reason.includes('DEVIATION_MW 지속 편차'));
  assert.equal(last.metrics.sustainedRunCount, 80);
});

test('DEVIATION_MW sustained rule holds across bad-quality forced-zero rows instead of resetting', () => {
  const onTarget = Array.from({ length: 5 }, () => plateauRow(0));
  const firstLeg = Array.from({ length: 40 }, () => plateauRow(20, '1'));
  const badQuality = Array.from({ length: 10 }, () => plateauRow(0, '0'));
  const secondLeg = Array.from({ length: 40 }, () => plateauRow(20, '1'));
  const results = aemoDerivedSequence([...onTarget, ...firstLeg, ...badQuality, ...secondLeg]);

  const badSlice = results.slice(onTarget.length + firstLeg.length, onTarget.length + firstLeg.length + badQuality.length);
  assert.equal(badSlice.some(r => (r.details.rulesFired || []).includes('DEVIATION_MW sustained deviation')), false);
  assert.ok(badSlice.every(r => r.metrics.sustainedRunCount === 40));

  const firstSustained = results.findIndex(r => (r.details.rulesFired || []).includes('DEVIATION_MW sustained deviation'));
  assert.ok(firstSustained >= 0, 'run should resume after quality-0 rows');
  assert.equal(firstSustained, onTarget.length + firstLeg.length + badQuality.length + (75 - 40) - 1);
  const last = results[results.length - 1];
  assert.equal(last.metrics.sustainedRunCount, 80);
  assert.ok(last.details.rulesFired.includes('DEVIATION_MW sustained deviation'));
});

test('DEVIATION_MW sustained rule does not fire when a run is interrupted by a real on-target sample', () => {
  const firstLeg = Array.from({ length: 40 }, () => plateauRow(20));
  const onTarget = [plateauRow(0, '1')];
  const secondLeg = Array.from({ length: 40 }, () => plateauRow(20));
  const results = aemoDerivedSequence([...firstLeg, ...onTarget, ...secondLeg]);
  assert.equal(results.some(r => (r.details.rulesFired || []).includes('DEVIATION_MW sustained deviation')), false);
  assert.equal(results[results.length - 1].metrics.sustainedRunCount, 40);
});

test('existing DEVIATION_MW onset reasonCode is unchanged when a brief residual trips only that rule', () => {
  const baseline = Array.from({ length: 9 }, () => plateauRow(0));
  const spike = plateauRow(30);
  const last = aemoDerivedSequence([...baseline, spike]).at(-1);
  assert.equal(last.reasonCode, 'DEVIATION_MW target deviation');
  assert.deepEqual(last.details.rulesFired, ['DEVIATION_MW target deviation']);
  assert.ok(!last.details.rulesFired.includes('DEVIATION_MW sustained deviation'));
});
