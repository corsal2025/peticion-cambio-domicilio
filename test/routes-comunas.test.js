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

test('CRUD de comunas', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };

  const alta = await app.request('/api/comunas', {
    method: 'POST', headers, body: JSON.stringify({ nombre: 'Valparaiso', correos: 'valpo@muni.cl' }),
  }, e);
  assert.equal(alta.status, 201);
  const { id } = await alta.json();

  const listar = await app.request('/api/comunas', { headers }, e);
  assert.equal((await listar.json()).length, 1);

  await app.request(`/api/comunas/${id}`, { method: 'PUT', headers, body: JSON.stringify({ correos: 'nuevo@muni.cl' }) }, e);
  const tras = await (await app.request('/api/comunas', { headers }, e)).json();
  assert.equal(tras[0].correos, 'nuevo@muni.cl');

  await app.request(`/api/comunas/${id}`, { method: 'DELETE', headers }, e);
  const final = await (await app.request('/api/comunas', { headers }, e)).json();
  assert.equal(final.length, 0);
});

test('import CSV de comunas no duplica por nombre normalizado', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const csv = 'nombre,correo\nConcepcion,concepcion@muni.cl\nConcepcion,otro@muni.cl';

  const res = await app.request('/api/comunas/import', { method: 'POST', headers, body: JSON.stringify({ csv }) }, e);
  const resumen = await res.json();
  assert.equal(resumen.insertadas, 1);
  assert.equal(resumen.actualizadas, 1);
});
