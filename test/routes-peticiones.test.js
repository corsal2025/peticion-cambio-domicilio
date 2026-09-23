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

test('alta manual + buscador + marcar + enviar (sin comuna configurada)', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const cookie = await cookieAdmin(e);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

  const alta = await app.request('/api/peticiones', {
    method: 'POST',
    headers,
    body: JSON.stringify({ nombre: 'Juan Perez', rut: '18785387-7', comuna: 'Valparaiso' }),
  }, e);
  assert.equal(alta.status, 201);
  const { id, rutInvalido } = await alta.json();
  assert.equal(rutInvalido, false);

  const buscar = await app.request('/api/peticiones?busqueda=Juan', { headers }, e);
  const filas = await buscar.json();
  assert.equal(filas.length, 1);
  assert.equal(filas[0].plazo.diasRestantes, 15);

  const marcar = await app.request(`/api/peticiones/${id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ marcada: true }),
  }, e);
  assert.equal((await marcar.json()).marcada, 1);

  const enviar = await app.request('/api/peticiones/enviar', { method: 'POST', headers }, e);
  const resumen = await enviar.json();
  assert.equal(resumen.sinCorreo, 1); // no hay comuna registrada con correo -> SinCorreoComuna
});

test('enviar en modo direct usa mail.send_as de la config, no EWS_SEND_AS del env', async () => {
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
  const cookie = await cookieAdmin(e);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

  await db
    .prepare('INSERT INTO comunas (nombre, nombre_norm, correos) VALUES (?, ?, ?)')
    .bind('Valparaiso', 'valparaiso', 'destino-comuna@muni.cl')
    .run();

  await app.request('/api/config', {
    method: 'PUT', headers,
    body: JSON.stringify({ 'mail.mode': 'direct', 'mail.send_as': 'alias-config@muni.cl' }),
  }, e);

  const alta = await app.request('/api/peticiones', {
    method: 'POST', headers,
    body: JSON.stringify({ nombre: 'Juan Perez', rut: '18785387-7', comuna: 'Valparaiso' }),
  }, e);
  const { id } = await alta.json();
  await app.request(`/api/peticiones/${id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ marcada: true }),
  }, e);

  const solicitudesFetch = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    solicitudesFetch.push({ url, body: opts.body });
    return new Response('<Envelope/>', { status: 200 });
  };
  try {
    const enviar = await app.request('/api/peticiones/enviar', { method: 'POST', headers }, e);
    assert.equal(enviar.status, 200);
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  assert.equal(solicitudesFetch.length, 1);
  assert.match(solicitudesFetch[0].body, /alias-config@muni\.cl/);
  assert.doesNotMatch(solicitudesFetch[0].body, /fallback-env@muni\.cl/);
});

test('alta manual con RUT invalido se guarda igual', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const cookie = await cookieAdmin(e);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

  const alta = await app.request('/api/peticiones', {
    method: 'POST',
    headers,
    body: JSON.stringify({ nombre: 'Ana Soto', rut: '11111111-9', comuna: 'Valparaiso' }),
  }, e);
  assert.equal(alta.status, 201);
  assert.equal((await alta.json()).rutInvalido, true);
});
