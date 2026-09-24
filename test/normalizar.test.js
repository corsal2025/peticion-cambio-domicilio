import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, coincide } from '../worker/lib/normalizar.js';

test('fold quita tildes, pasa a minusculas y colapsa espacios', () => {
  assert.equal(fold('  José María  '), 'jose maria');
  assert.equal(fold('CONCEPCIÓN'), 'concepcion');
  assert.equal(fold('Ñuñoa'), 'nunoa');
});

test('fold de valores vacios o nulos retorna cadena vacia', () => {
  assert.equal(fold(null), '');
  assert.equal(fold(undefined), '');
  assert.equal(fold('   '), '');
});

test('coincide busca fragmento case-insensitive y sin tildes', () => {
  assert.equal(coincide('José Pérez', 'perez'), true);
  assert.equal(coincide('José Pérez', 'PEREZ'), true);
  assert.equal(coincide('José Pérez', 'gomez'), false);
});

test('coincide sobre rut ignora puntos y guion', () => {
  assert.equal(coincide('18.785.387-7', '187853877'), true);
  assert.equal(coincide('18.785.387-7', '18785387'), true);
});
