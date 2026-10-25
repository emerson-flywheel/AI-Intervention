import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROWS_PER_NOTCH, notches, touchScroll } from '../rootfs/opt/addon-agent/touchscroll.mjs';

const step = 20 * ROWS_PER_NOTCH;

test('a drag becomes one wheel notch per three rows of travel, the rest kept for the next move', () => {
  assert.deepEqual(notches(0, 20), { notches: 0, rest: 0 });
  assert.deepEqual(notches(step - 1, 20), { notches: 0, rest: step - 1 });
  assert.deepEqual(notches(2 * step + 5, 20), { notches: 2, rest: 5 });
  // Finger moving up: forward, toward the bottom.
  assert.deepEqual(notches(-(step + 7), 20), { notches: -1, rest: -7 });
});

test('a drag with no row height to read still scrolls (a default row)', () => {
  assert.ok(notches(1000, 0).notches > 0);
  assert.ok(notches(1000, Number.NaN).notches > 0);
});

test('touchScroll with no frame window, or none loaded yet, does nothing', () => {
  assert.doesNotThrow(() => touchScroll(null));
  assert.doesNotThrow(() => touchScroll({}));
});
