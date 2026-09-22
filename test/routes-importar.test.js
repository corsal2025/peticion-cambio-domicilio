import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';

function env(db) {
  return { DB: db, IMPORT_SECRET: 'secreto-import' };
}

test('POST /api/import sin secreto responde 401 y no procesa nada', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filas: [{ nombreCompleto: 'Juan', rut: '18785387-7', comuna: 'Valparaiso' }] }),
  }, env(db));
  assert.equal(res.status, 401);
  const { results } = await db.prepare('SELECT * FROM peticiones').all();
  assert.equal(results.length, 0);
});

test('POST /api/import con secreto valido hace upsert', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Import-Secret': 'secreto-import' },
    body: JSON.stringify({ filas: [{ nombreCompleto: 'Juan', rut: '18785387-7', comuna: 'Valparaiso' }] }),
  }, env(db));
  assert.equal(res.status, 200);
  const resumen = await res.json();
  assert.equal(resumen.insertadas, 1);
});
