import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { obtenerConfig, obtenerTodaLaConfig, setConfig } from '../worker/lib/config.js';

test('obtenerConfig lee valores seed del migration (mail.mode=relay)', async () => {
  const db = crearD1Fake();
  assert.equal(await obtenerConfig(db, 'mail.mode'), 'relay');
});

test('obtenerConfig retorna null para una clave inexistente', async () => {
  const db = crearD1Fake();
  assert.equal(await obtenerConfig(db, 'no.existe'), null);
});

test('setConfig crea o actualiza una clave', async () => {
  const db = crearD1Fake();
  await setConfig(db, 'mail.test_email', 'prueba@muni.cl');
  assert.equal(await obtenerConfig(db, 'mail.test_email'), 'prueba@muni.cl');

  await setConfig(db, 'mail.test_email', 'otro@muni.cl');
  assert.equal(await obtenerConfig(db, 'mail.test_email'), 'otro@muni.cl');
});

test('obtenerTodaLaConfig retorna un objeto clave->valor', async () => {
  const db = crearD1Fake();
  const config = await obtenerTodaLaConfig(db);
  assert.equal(config['mail.mode'], 'relay');
  assert.ok('mail.test_email' in config);
});
