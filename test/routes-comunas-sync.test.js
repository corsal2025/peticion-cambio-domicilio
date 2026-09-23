import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';

function env(db) {
  return { DB: db, IMPORT_SECRET: 'secreto-import' };
}

function postSync(db, body, secreto = 'secreto-import') {
  return app.request('/api/comunas/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secreto ? { 'X-Import-Secret': secreto } : {}) },
    body: JSON.stringify(body),
  }, env(db));
}

test('POST /api/comunas/sync sin secreto responde 401 y no toca la base', async () => {
  const db = crearD1Fake();
  const res = await postSync(db, { contactos: [{ comuna: 'Valparaiso', email: 'a@muni.cl' }] }, null);
  assert.equal(res.status, 401);
  const { results } = await db.prepare('SELECT * FROM comunas').all();
  assert.equal(results.length, 0);
});

test('POST /api/comunas/sync con secreto invalido responde 401', async () => {
  const db = crearD1Fake();
  const res = await postSync(db, { contactos: [] }, 'secreto-incorrecto');
  assert.equal(res.status, 401);
});

test('POST /api/comunas/sync con secreto valido hace upsert y registra en sync_log', async () => {
  const db = crearD1Fake();
  const res = await postSync(db, {
    contactos: [
      { comuna: 'Valparaiso', email: 'a@muni.cl' },
      { comuna: 'Valparaiso', email: 'b@muni.cl' },
    ],
  });
  assert.equal(res.status, 200);
  const cuerpo = await res.json();
  assert.equal(cuerpo.ok, true);
  assert.equal(cuerpo.nuevos, 2);

  const { results } = await db.prepare("SELECT * FROM sync_log WHERE fuente = 'apps-script-comunas'").all();
  assert.equal(results.length, 1);
  assert.equal(results[0].recibidas, 2);
  assert.equal(results[0].insertadas, 2);
});

test('POST /api/comunas/sync no exige sesion de usuario (autenticacion por secreto compartido)', async () => {
  const db = crearD1Fake();
  const res = await postSync(db, { contactos: [{ comuna: 'Valparaiso', email: 'a@muni.cl' }] });
  assert.notEqual(res.status, 401);
});
