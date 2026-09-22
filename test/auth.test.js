import test from 'node:test';
import assert from 'node:assert/strict';
import { firmarSesion, verificarSesion, MAX_EDAD_MS } from '../worker/lib/auth.js';

test('firmarSesion + verificarSesion redondea el mismo payload', async () => {
  const cookie = await firmarSesion({ usuario: 'jperez', rol: 'admin' }, 'secreto-test');
  const sesion = await verificarSesion(cookie, 'secreto-test');

  assert.equal(sesion.usuario, 'jperez');
  assert.equal(sesion.rol, 'admin');
  assert.ok(sesion.exp > Date.now());
});

test('verificarSesion rechaza una cookie firmada con otro secreto', async () => {
  const cookie = await firmarSesion({ usuario: 'jperez', rol: 'admin' }, 'secreto-a');
  const sesion = await verificarSesion(cookie, 'secreto-b');
  assert.equal(sesion, null);
});

test('verificarSesion rechaza una cookie manipulada', async () => {
  const cookie = await firmarSesion({ usuario: 'jperez', rol: 'staff' }, 'secreto-test');
  const [payload, firma] = cookie.split('.');
  const firmaManipulada = firma.slice(0, -1) + (firma.at(-1) === 'A' ? 'B' : 'A');
  const sesion = await verificarSesion(`${payload}.${firmaManipulada}`, 'secreto-test');
  assert.equal(sesion, null);
});

test('verificarSesion rechaza una cookie vencida (>12h)', async () => {
  const ahora = Date.now();
  const cookie = await firmarSesion({ usuario: 'jperez', rol: 'staff' }, 'secreto-test', ahora - MAX_EDAD_MS - 1000);
  const sesion = await verificarSesion(cookie, 'secreto-test');
  assert.equal(sesion, null);
});

test('verificarSesion rechaza basura', async () => {
  assert.equal(await verificarSesion('no-es-una-cookie-valida', 'secreto-test'), null);
  assert.equal(await verificarSesion('', 'secreto-test'), null);
  assert.equal(await verificarSesion(null, 'secreto-test'), null);
});
