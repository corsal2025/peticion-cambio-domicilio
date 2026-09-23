// Cloudflare Workers FREE plan: 50 subrequests por invocacion, y D1 cuenta
// tanto cada .run()/.first()/.all() como cada .batch() como UN subrequest,
// pero ADEMAS limita a 50 el numero de statements por invocacion (cada
// statement dentro de un .batch() cuenta contra ese limite tambien). Estos
// tests fijan un presupuesto conservador (bien por debajo de 50 en ambos
// ejes) para que un lote/sincronizacion nunca dispare
// "Too many API requests by single Worker invocation".
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';
import { importarFilas } from '../worker/lib/importar.js';

const MAX_CALLS = 5;
const MAX_STATEMENTS = 45;

function env(db) {
  return { DB: db, IMPORT_SECRET: 'secreto-import' };
}

function fila(i, overrides = {}) {
  return {
    nombreCompleto: `Persona ${i}`,
    rut: `${10000000 + i}-${i % 10}`,
    comuna: `COMUNA${i % 20}`,
    clases: 'B',
    fechaSolicitud: '2026-01-05',
    oficina: 'AV. ARGENTINA',
    origen: `Hoja1!${i}`,
    ordenImportacion: i,
    estadoCarpeta: 'CAMBIO DE DOMICILIO',
    ...overrides,
  };
}

function postImport(db, body) {
  return app.request(
    '/api/import',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Import-Secret': 'secreto-import' },
      body: JSON.stringify(body),
    },
    env(db),
  );
}

function postFinalizar(db, body) {
  return app.request(
    '/api/import/finalizar',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Import-Secret': 'secreto-import' },
      body: JSON.stringify(body),
    },
    env(db),
  );
}

function postComunasSync(db, body) {
  return app.request(
    '/api/comunas/sync',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Import-Secret': 'secreto-import' },
      body: JSON.stringify(body),
    },
    env(db),
  );
}

test('POST /api/import con un lote de 200 filas usa pocos D1 calls/statements', async () => {
  const db = crearD1Fake();
  const filas = Array.from({ length: 200 }, (_, i) => fila(i));

  db.resetStats();
  const res = await postImport(db, { filas, syncId: 'lote-200', lote: 1, totalLotes: 1 });
  assert.equal(res.status, 200);

  const { calls, statements } = db.stats();
  assert.ok(calls <= MAX_CALLS, `esperaba <= ${MAX_CALLS} D1 calls, uso ${calls}`);
  assert.ok(statements <= MAX_STATEMENTS, `esperaba <= ${MAX_STATEMENTS} statements, uso ${statements}`);
});

test('POST /api/import/finalizar con miles de filas ya existentes usa pocos D1 calls/statements', async () => {
  const db = crearD1Fake();

  // Primera sincronizacion completa: deja ~3000 peticiones Borrador vigentes.
  const filasIniciales = Array.from({ length: 3000 }, (_, i) => fila(i));
  for (let offset = 0; offset < filasIniciales.length; offset += 500) {
    const lote = filasIniciales.slice(offset, offset + 500);
    await postImport(db, { filas: lote, syncId: 'inicial', lote: offset / 500 + 1, totalLotes: 6 });
  }
  await postFinalizar(db, { syncId: 'inicial' });

  // Segunda sincronizacion: mismas filas, un solo lote (para medir SOLO el
  // costo de finalizar con miles de filas ya en la tabla).
  await postImport(db, { filas: filasIniciales, syncId: 'segunda', lote: 1, totalLotes: 1 });

  db.resetStats();
  const res = await postFinalizar(db, { syncId: 'segunda' });
  assert.equal(res.status, 200);

  const { calls, statements } = db.stats();
  assert.ok(calls <= MAX_CALLS, `esperaba <= ${MAX_CALLS} D1 calls, uso ${calls}`);
  assert.ok(statements <= MAX_STATEMENTS, `esperaba <= ${MAX_STATEMENTS} statements, uso ${statements}`);
});

test('POST /api/comunas/sync con 300 contactos usa pocos D1 calls/statements', async () => {
  const db = crearD1Fake();
  const contactos = Array.from({ length: 300 }, (_, i) => ({
    comuna: `COMUNA${i}`,
    email: `contacto${i}@muni.cl`,
  }));

  db.resetStats();
  const res = await postComunasSync(db, { contactos });
  assert.equal(res.status, 200);

  const { calls, statements } = db.stats();
  assert.ok(calls <= MAX_CALLS, `esperaba <= ${MAX_CALLS} D1 calls, uso ${calls}`);
  assert.ok(statements <= MAX_STATEMENTS, `esperaba <= ${MAX_STATEMENTS} statements, uso ${statements}`);
});

test('importarFilas con un lote grande (JSON > 90KB) sigue usando pocos D1 calls', async () => {
  const db = crearD1Fake();
  // Filas "pesadas" para forzar que el JSON del lote supere holgadamente 90KB
  // y dispare el chunking interno por tamano.
  const filas = Array.from({ length: 2000 }, (_, i) =>
    fila(i, { nombreCompleto: `Persona con nombre bastante largo numero ${i} `.repeat(3) }),
  );

  db.resetStats();
  const r = await importarFilas(db, filas, { syncId: 'pesado', lote: 1, totalLotes: 1 });
  assert.equal(r.recibidas, 2000);

  const { calls, statements } = db.stats();
  assert.ok(calls <= MAX_CALLS + 3, `chunking por tamano no deberia disparar demasiadas llamadas extra, uso ${calls}`);
  assert.ok(statements <= MAX_STATEMENTS, `esperaba <= ${MAX_STATEMENTS} statements, uso ${statements}`);
});
