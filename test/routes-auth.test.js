import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';
import { crearUsuario } from '../worker/lib/usuarios.js';

function env(db) {
  return { DB: db, SESSION_SECRET: 'secreto-test', MASTER_PIN: '1234' };
}

test('GET /api/peticiones sin sesion responde 401', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/peticiones', {}, env(db));
  assert.equal(res.status, 401);
});

test('login con PIN maestro crea sesion admin y permite acceso', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'jefe', clave: '1234' }),
  }, e);
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie');
  assert.ok(cookie);

  const cookieValor = cookie.split(';')[0];
  const protegidaRes = await app.request('/api/peticiones', { headers: { Cookie: cookieValor } }, e);
  assert.equal(protegidaRes.status, 200);
});

test('login con clave incorrecta responde 401', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'jefe', clave: 'incorrecta' }),
  }, env(db));
  assert.equal(res.status, 401);
});

test('rol staff intenta configuracion (soloAdmin) responde 403', async () => {
  const db = crearD1Fake();
  const e = env(db);
  await crearUsuario(db, { usuario: 'staff1', rol: 'staff', clave: 'clave123' });

  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'staff1', clave: 'clave123' }),
  }, e);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const res = await app.request('/api/config', { headers: { Cookie: cookie } }, e);
  assert.equal(res.status, 403);
});
