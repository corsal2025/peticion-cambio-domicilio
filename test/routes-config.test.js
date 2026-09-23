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
    body: JSON.stringify({ usuario: 'admin', clave: '1234' }),
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

test('POST /api/mail/prueba en modo direct usa mail.send_as de la config, no EWS_SEND_AS del env', async () => {
  const db = crearD1Fake();
  const e = {
    DB: db,
    SESSION_SECRET: 'secreto-test',
    MASTER_PIN: '1234',
    EWS_URL: 'https://ews.local/ews',
    EWS_USER: 'usuario-ews',
    EWS_PASS: 'clave-ews',
    EWS_SEND_AS: 'fallback-env@muni.cl',
  };
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };

  await app.request('/api/config', {
    method: 'PUT', headers,
    body: JSON.stringify({ 'mail.mode': 'direct', 'mail.test_email': 'pruebas@muni.cl', 'mail.send_as': 'alias-config@muni.cl' }),
  }, e);

  const solicitudesFetch = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    solicitudesFetch.push({ url, body: opts.body });
    return new Response('<Envelope/>', { status: 200 });
  };
  try {
    const res = await app.request('/api/mail/prueba', { method: 'POST', headers }, e);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  assert.equal(solicitudesFetch.length, 1);
  assert.match(solicitudesFetch[0].body, /alias-config@muni\.cl/);
  assert.doesNotMatch(solicitudesFetch[0].body, /fallback-env@muni\.cl/);
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

test('GET /api/estadisticas sin peticiones enviadas responde todo en cero', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e) };
  const res = await app.request('/api/estadisticas', { headers }, e);
  const stats = await res.json();
  assert.equal(stats.totalEnviadas, 0);
  assert.equal(stats.abiertas, 0);
  assert.deepEqual(stats.porComuna, []);
});
