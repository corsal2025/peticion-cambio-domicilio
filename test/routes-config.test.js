import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';

function env(db) {
  return { DB: db, SESSION_SECRET: 'secreto-test', MASTER_PIN: '1234' };
}

async function cookieAdmin(e) {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'jefe', clave: '1234' }),
  }, e);
  return res.headers.get('set-cookie').split(';')[0];
}

test('GET/PUT /api/config solo admin', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };

  const antes = await (await app.request('/api/config', { headers }, e)).json();
  assert.equal(antes['mail.mode'], 'relay');

  await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'mail.test_email': 'pruebas@muni.cl' }) }, e);
  const despues = await (await app.request('/api/config', { headers }, e)).json();
  assert.equal(despues['mail.test_email'], 'pruebas@muni.cl');
});

test('POST /api/mail/prueba sin test_email configurado responde 400', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const res = await app.request('/api/mail/prueba', { method: 'POST', headers }, e);
  assert.equal(res.status, 400);
});

test('GET /api/usuarios solo admin, alta de usuario', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const alta = await app.request('/api/usuarios', {
    method: 'POST', headers, body: JSON.stringify({ usuario: 'ana', rol: 'staff', clave: 'clave123' }),
  }, e);
  assert.equal(alta.status, 201);
  const lista = await (await app.request('/api/usuarios', { headers }, e)).json();
  assert.equal(lista.length, 1);
});

test('GET /api/estadisticas cuenta vencidas y en plazo', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e) };
  const res = await app.request('/api/estadisticas', { headers }, e);
  const stats = await res.json();
  assert.equal(stats.total, 0);
  assert.equal(stats.vencidas, 0);
});
