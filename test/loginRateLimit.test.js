import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { claveIntento, estaBloqueado, registrarFallo, limpiarFallos, MAX_FALLOS } from '../worker/lib/loginRateLimit.js';

test('no bloqueado antes de MAX_FALLOS', async () => {
  const db = crearD1Fake();
  const clave = claveIntento('1.2.3.4', 'jefe');
  for (let i = 0; i < MAX_FALLOS - 1; i++) await registrarFallo(db, clave);
  assert.equal(await estaBloqueado(db, clave), false);
});

test('bloqueado al llegar a MAX_FALLOS dentro de la ventana', async () => {
  const db = crearD1Fake();
  const clave = claveIntento('1.2.3.4', 'jefe');
  for (let i = 0; i < MAX_FALLOS; i++) await registrarFallo(db, clave);
  assert.equal(await estaBloqueado(db, clave), true);
});

test('limpiarFallos desbloquea inmediatamente', async () => {
  const db = crearD1Fake();
  const clave = claveIntento('1.2.3.4', 'jefe');
  for (let i = 0; i < MAX_FALLOS; i++) await registrarFallo(db, clave);
  await limpiarFallos(db, clave);
  assert.equal(await estaBloqueado(db, clave), false);
});

test('claves distintas (ip o usuario) no se afectan entre si', async () => {
  const db = crearD1Fake();
  const claveA = claveIntento('1.2.3.4', 'jefe');
  const claveB = claveIntento('1.2.3.4', 'otro');
  for (let i = 0; i < MAX_FALLOS; i++) await registrarFallo(db, claveA);
  assert.equal(await estaBloqueado(db, claveA), true);
  assert.equal(await estaBloqueado(db, claveB), false);
});
