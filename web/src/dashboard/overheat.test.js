import assert from 'node:assert/strict';
import test from 'node:test';
import { HOT_ALARM_C, HOT_CLEAR_C, overheatOn } from './overheat.js';

const run = (temps) => {
  let on = false;
  return temps.map((t) => (on = overheatOn(on, t)));
};

test('trips at the limit, holds through null and the hysteresis band, clears below it', () => {
  assert.deepEqual(run([105, 112, null, 109, 107]), [false, true, true, true, false]);
});

test('exactly the limit trips; exactly the clear point does not clear', () => {
  assert.deepEqual(run([HOT_ALARM_C, HOT_CLEAR_C]), [true, true]);
  assert.deepEqual(run([HOT_ALARM_C - 0.01]), [false]);
});

test('the hysteresis band never trips the alarm on its own', () => {
  assert.deepEqual(run([109.9, 108, 109.5]), [false, false, false]);
});

test('a missing or garbage reading never trips or clears it', () => {
  assert.deepEqual(run([null, undefined, NaN]), [false, false, false]);
  assert.deepEqual(run([120, undefined, NaN, null]), [true, true, true, true]);
});
