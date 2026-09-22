import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAndValidate } from '../worker/lib/rut.js';

test('rut valido con puntos y guion se normaliza igual', () => {
  assert.equal(normalizeAndValidate('18.785.387-7'), '18.785.387-7');
  assert.equal(normalizeAndValidate('187853877'), '18.785.387-7');
});

test('rut valido con K minuscula se normaliza a mayuscula', () => {
  assert.equal(normalizeAndValidate('15000005k'), '15.000.005-K');
});

test('rut con digito verificador incorrecto retorna null', () => {
  assert.equal(normalizeAndValidate('18785387-8'), null);
});

test('rut con largo invalido retorna null', () => {
  assert.equal(normalizeAndValidate('123-4'), null);
  assert.equal(normalizeAndValidate('123456789-0'), null);
});

test('entrada nula o vacia retorna null', () => {
  assert.equal(normalizeAndValidate(null), null);
  assert.equal(normalizeAndValidate(undefined), null);
  assert.equal(normalizeAndValidate(''), null);
});

test('rut de 7 digitos se rellena con cero a la izquierda', () => {
  // 1234567 no es valido, probamos con un rut real de 7 digitos + dv
  assert.equal(normalizeAndValidate('1719692-8'), '01.719.692-8');
});
