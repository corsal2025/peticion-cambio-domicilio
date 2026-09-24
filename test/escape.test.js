import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../public/js/escape.js';

test('esc escapa caracteres peligrosos de HTML', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc(`" onmouseover="alert(1)`), '&quot; onmouseover=&quot;alert(1)');
  assert.equal(esc("O'Higgins & Cía"), 'O&#39;Higgins &amp; Cía');
});

test('esc maneja null/undefined/numeros sin lanzar', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});
