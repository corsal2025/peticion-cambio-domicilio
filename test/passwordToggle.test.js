import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alternarTipoClave, atributosToggleClave } from '../public/js/passwordToggle.js';

test('alternarTipoClave pasa de password a text y viceversa', () => {
  assert.equal(alternarTipoClave('password'), 'text');
  assert.equal(alternarTipoClave('text'), 'password');
});

test('atributosToggleClave describe el boton "Mostrar clave" cuando el input esta oculto (password)', () => {
  const attrs = atributosToggleClave('password');
  assert.equal(attrs.ariaLabel, 'Mostrar clave');
  assert.equal(attrs.ariaPressed, 'false');
  assert.equal(attrs.texto, '👁');
});

test('atributosToggleClave describe el boton "Ocultar clave" cuando el input esta visible (text)', () => {
  const attrs = atributosToggleClave('text');
  assert.equal(attrs.ariaLabel, 'Ocultar clave');
  assert.equal(attrs.ariaPressed, 'true');
  assert.equal(attrs.texto, '🙈');
});
