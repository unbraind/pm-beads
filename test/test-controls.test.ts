import assert from 'node:assert/strict';
import test from 'node:test';
import { testDepth } from './support/depth.ts';
import { testTime } from './support/time.ts';

test('depth defaults to full and quick keeps a bounded deterministic prefix', () => {
  const saved = process.env.PM_TEST_DEPTH;
  try {
    delete process.env.PM_TEST_DEPTH;
    assert.equal(testDepth(512), 512);
    process.env.PM_TEST_DEPTH = 'quick';
    assert.equal(testDepth(512), 52);
    assert.equal(testDepth(64), 25);
    assert.equal(testDepth(16), 16);
  } finally {
    if (saved === undefined) delete process.env.PM_TEST_DEPTH;
    else process.env.PM_TEST_DEPTH = saved;
  }
});

test('harness scale rejects invalid budgets before spawn and rounds up milliseconds', () => {
  const saved = process.env.PM_TEST_TIME_SCALE;
  try {
    delete process.env.PM_TEST_TIME_SCALE;
    assert.equal(testTime(3), 3);
    process.env.PM_TEST_TIME_SCALE = '1.1';
    assert.equal(testTime(3), 4);
    for (const invalid of ['0', '-1', 'NaN', 'Infinity', '']) {
      process.env.PM_TEST_TIME_SCALE = invalid;
      assert.throws(() => testTime(3), /PM_TEST_TIME_SCALE/);
    }
  } finally {
    if (saved === undefined) delete process.env.PM_TEST_TIME_SCALE;
    else process.env.PM_TEST_TIME_SCALE = saved;
  }
});
