import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import {
  claveIntento,
  claveUsuarioGlobal,
  estaBloqueado,
  registrarFallo,
  limpiarFallos,
  MAX_FALLOS,
  estaBloqueadoGlobal,
  MAX_FALLOS_GLOBAL,
} from '../worker/lib/loginRateLimit.js';

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

test('claveIntento y claveUsuarioGlobal normalizan el usuario (trim + lowercase)', () => {
  assert.equal(claveIntento('1.2.3.4', '  Jefe '), claveIntento('1.2.3.4', 'jefe'));
  assert.equal(claveUsuarioGlobal('  Jefe '), claveUsuarioGlobal('jefe'));
});

test('claves distintas (ip o usuario) no se afectan entre si', async () => {
  const db = crearD1Fake();
  const claveA = claveIntento('1.2.3.4', 'jefe');
  const claveB = claveIntento('1.2.3.4', 'otro');
  for (let i = 0; i < MAX_FALLOS; i++) await registrarFallo(db, claveA);
  assert.equal(await estaBloqueado(db, claveA), true);
  assert.equal(await estaBloqueado(db, claveB), false);
});

test('tope global por usuario bloquea aunque cada fallo venga de una ip distinta', async () => {
  const db = crearD1Fake();
  for (let i = 0; i < MAX_FALLOS_GLOBAL; i++) {
    await registrarFallo(db, claveIntento(`10.0.0.${i}`, 'admin'), 'admin');
  }
  assert.equal(await estaBloqueadoGlobal(db, 'admin'), true);
});

test('tope global no afecta a otro usuario', async () => {
  const db = crearD1Fake();
  for (let i = 0; i < MAX_FALLOS_GLOBAL; i++) {
    await registrarFallo(db, claveIntento(`10.0.0.${i}`, 'admin'), 'admin');
  }
  assert.equal(await estaBloqueadoGlobal(db, 'otro'), false);
});

test('tope global no se alcanza antes de MAX_FALLOS_GLOBAL', async () => {
  const db = crearD1Fake();
  for (let i = 0; i < MAX_FALLOS_GLOBAL - 1; i++) {
    await registrarFallo(db, claveIntento(`10.0.0.${i}`, 'admin'), 'admin');
  }
  assert.equal(await estaBloqueadoGlobal(db, 'admin'), false);
});

test('limpiarFallos con usuario tambien limpia el tope global', async () => {
  const db = crearD1Fake();
  for (let i = 0; i < MAX_FALLOS_GLOBAL; i++) {
    await registrarFallo(db, claveIntento(`10.0.0.${i}`, 'admin'), 'admin');
  }
  await limpiarFallos(db, claveIntento('10.0.0.0', 'admin'), 'admin');
  assert.equal(await estaBloqueadoGlobal(db, 'admin'), false);
});
