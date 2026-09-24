import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';

function env(db) {
  return { DB: db, IMPORT_SECRET: 'secreto-import' };
}

function postImport(db, body) {
  return app.request('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Import-Secret': 'secreto-import' },
    body: JSON.stringify(body),
  }, env(db));
}

function postFinalizar(db, body) {
  return app.request('/api/import/finalizar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Import-Secret': 'secreto-import' },
    body: JSON.stringify(body),
  }, env(db));
}

test('POST /api/import sin secreto responde 401 y no procesa nada', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filas: [{ nombreCompleto: 'Juan', rut: '18785387-7', comuna: 'Valparaiso', estadoCarpeta: 'CAMBIO DE DOMICILIO' }] }),
  }, env(db));
  assert.equal(res.status, 401);
  const { results } = await db.prepare('SELECT * FROM peticiones').all();
  assert.equal(results.length, 0);
});

test('POST /api/import con secreto valido hace upsert (sin syncId nunca borra por si solo)', async () => {
  const db = crearD1Fake();
  const res = await postImport(db, { filas: [{ nombreCompleto: 'Juan', rut: '18785387-7', comuna: 'Valparaiso', estadoCarpeta: 'CAMBIO DE DOMICILIO' }] });
  assert.equal(res.status, 200);
  const resumen = await res.json();
  assert.equal(resumen.insertadas, 1);
  assert.equal(resumen.eliminadas, undefined, '/api/import ya no borra: eso lo hace /api/import/finalizar');
});

test('POST /api/import/finalizar con clavesCD vacio y sin hojasLeidas no borra el Borrador existente y avisa', async () => {
  const db = crearD1Fake();
  await postImport(db, {
    filas: [{ nombreCompleto: 'Juan', rut: '18785387-7', comuna: 'Valparaiso', estadoCarpeta: 'CAMBIO DE DOMICILIO' }],
  });

  const res = await postFinalizar(db, { clavesCD: [] });
  assert.equal(res.status, 200);
  const resumen = await res.json();
  assert.equal(resumen.eliminadas, 0);
  assert.ok(Array.isArray(resumen.avisos) && resumen.avisos.length > 0);

  const { results } = await db.prepare('SELECT * FROM peticiones').all();
  assert.equal(results.length, 1, 'la peticion previa no debe borrarse por un payload vacio');
});

test('POST /api/import/finalizar con filas vacias no borra el Borrador existente y avisa', async () => {
  const db = crearD1Fake();
  await postImport(db, {
    filas: [{ nombreCompleto: 'Juan', rut: '18785387-7', comuna: 'Valparaiso', estadoCarpeta: 'CAMBIO DE DOMICILIO' }],
  });
  await postFinalizar(db, { clavesCD: ['18785387-7|VALPARAISO'.toUpperCase()] });

  await postImport(db, { filas: [] });
  const res = await postFinalizar(db, { clavesCD: [] });
  assert.equal(res.status, 200);
  const resumen = await res.json();
  assert.equal(resumen.eliminadas, 0);
  assert.ok(Array.isArray(resumen.avisos) && resumen.avisos.length > 0);

  const { results } = await db.prepare('SELECT * FROM peticiones').all();
  assert.equal(results.length, 1, 'la peticion previa no debe borrarse por un payload vacio');
});

test('sincronizacion en 2 lotes: finalizar limpia obsoletas usando el acumulado (clavesCD) de ambos, no de uno solo', async () => {
  const db = crearD1Fake();

  // Sincronizacion inicial completa (un solo lote), 4 filas vigentes.
  const inicial = await postImport(db, {
    filas: [
      { nombreCompleto: 'A', rut: '18785387-7', comuna: 'Valparaiso', oficina: 'AV. ARGENTINA', estadoCarpeta: 'CAMBIO DE DOMICILIO' },
      { nombreCompleto: 'B', rut: '7654321-6', comuna: 'Valparaiso', oficina: 'AV. ARGENTINA', estadoCarpeta: 'CAMBIO DE DOMICILIO' },
      { nombreCompleto: 'C', rut: '9876543-3', comuna: 'Valparaiso', oficina: 'AV. ARGENTINA', estadoCarpeta: 'CAMBIO DE DOMICILIO' },
      { nombreCompleto: 'D', rut: '11111111-1', comuna: 'Valparaiso', oficina: 'AV. ARGENTINA', estadoCarpeta: 'CAMBIO DE DOMICILIO' },
    ],
  });
  const claveInicial = (await inicial.json()).clavesCD;
  await postFinalizar(db, { clavesCD: claveInicial });

  // Segunda sincronizacion: las mismas 4 filas repartidas en 2 lotes de 2.
  const lote1 = await postImport(db, {
    hojasLeidas: 3,
    filas: [
      { nombreCompleto: 'A', rut: '18785387-7', comuna: 'Valparaiso', oficina: 'AV. ARGENTINA', estadoCarpeta: 'CAMBIO DE DOMICILIO' },
      { nombreCompleto: 'B', rut: '7654321-6', comuna: 'Valparaiso', oficina: 'AV. ARGENTINA', estadoCarpeta: 'CAMBIO DE DOMICILIO' },
    ],
  });
  const lote2 = await postImport(db, {
    hojasLeidas: 3,
    filas: [
      { nombreCompleto: 'C', rut: '9876543-3', comuna: 'Valparaiso', oficina: 'AV. ARGENTINA', estadoCarpeta: 'CAMBIO DE DOMICILIO' },
      { nombreCompleto: 'D', rut: '11111111-1', comuna: 'Valparaiso', oficina: 'AV. ARGENTINA', estadoCarpeta: 'CAMBIO DE DOMICILIO' },
    ],
  });
  const clavesCD = [...(await lote1.json()).clavesCD, ...(await lote2.json()).clavesCD];

  const res = await postFinalizar(db, { clavesCD, hojasLeidas: 3 });
  assert.equal(res.status, 200);
  const resumen = await res.json();
  assert.equal(resumen.eliminadas, 0, 'ninguna fila desaparecio realmente, solo estaban repartidas en 2 lotes');

  const { results } = await db.prepare('SELECT * FROM peticiones').all();
  assert.equal(results.length, 4, 'el lote 1 no debe haber borrado las filas que solo vio el lote 2');
});
