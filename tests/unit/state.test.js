import test from 'node:test';
import assert from 'node:assert/strict';
import { describeLoadingProgress } from '../../src/state.js';

test('describeLoadingProgress stays silent for the first 15s (base label is enough)', () => {
  assert.equal(describeLoadingProgress(0), null);
  assert.equal(describeLoadingProgress(14), null);
});

test('describeLoadingProgress escalates through calibrated stages as a real CLI call runs long', () => {
  assert.match(describeLoadingProgress(15), /응답 대기/);
  assert.match(describeLoadingProgress(59), /응답 대기/);
  assert.match(describeLoadingProgress(60), /1~3분/);
  assert.match(describeLoadingProgress(149), /1~3분/);
  assert.match(describeLoadingProgress(150), /지연/);
});
