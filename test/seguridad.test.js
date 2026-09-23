import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from '../worker/lib/seguridad.js';

test('timingSafeEqual: iguales -> true', () => {
  assert.equal(timingSafeEqual('abc123', 'abc123'), true);
});

test('timingSafeEqual: distintas -> false', () => {
  assert.equal(timingSafeEqual('abc123', 'abc124'), false);
});

test('timingSafeEqual: largos distintos -> false, no lanza', () => {
  assert.equal(timingSafeEqual('abc', 'abcdef'), false);
  assert.equal(timingSafeEqual('', 'x'), false);
});

test('timingSafeEqual: valores no-string -> false', () => {
  assert.equal(timingSafeEqual(null, 'x'), false);
  assert.equal(timingSafeEqual(undefined, undefined), false);
  assert.equal(timingSafeEqual(123, '123'), false);
});
