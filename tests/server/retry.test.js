import test from 'node:test';
import assert from 'node:assert/strict';
import { retryOnce } from '../../server/lib/retry.js';

test('retries exactly once when shouldRetry accepts the error, then returns the success', async () => {
  let calls = 0;
  const result = await retryOnce(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('bad'), { status: 502 });
    return 'ok';
  }, (e) => e.status === 502);
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('does not retry when shouldRetry rejects the error — fails on the first attempt', async () => {
  let calls = 0;
  await assert.rejects(() => retryOnce(async () => {
    calls++;
    throw Object.assign(new Error('bad request'), { status: 400 });
  }, (e) => e.status === 502));
  assert.equal(calls, 1);
});

test('propagates the second failure if the retry also fails (no infinite loop)', async () => {
  let calls = 0;
  await assert.rejects(() => retryOnce(async () => {
    calls++;
    throw Object.assign(new Error('still bad'), { status: 502 });
  }, (e) => e.status === 502));
  assert.equal(calls, 2);
});

test('calls onRetry exactly once before the retry attempt', async () => {
  let calls = 0;
  const retriedErrors = [];
  await retryOnce(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('transient'), { status: 502 });
    return 'ok';
  }, (e) => e.status === 502, (e) => retriedErrors.push(e.message));
  assert.deepEqual(retriedErrors, ['transient']);
});
