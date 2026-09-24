import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';

function env(db) {
  return { DB: db, SESSION_SECRET: 'secreto-test', MASTER_PIN: '1234' };
}

async function cookieAdmin(e) {
  const res = await app.request(
    '/api/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: 'admin', clave: '1234' }),
    },
    e,
  );
  return res.headers.get('set-cookie').split(';')[0];
}

async function insertar(db, datos) {
  await db
    .prepare(
      `INSERT INTO peticiones
        (nombre_completo, rut, rut_norm, comuna, comuna_norm, estado, enviada_en, estado_carpeta, subida_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      datos.nombreCompleto ?? 'Persona',
      datos.rut ?? '11111111-1',
      datos.rut ?? '111111111',
      datos.comuna,
      datos.comuna.toLowerCase(),
      datos.estado ?? 'Enviada',
      datos.enviadaEn ?? null,
      datos.estadoCarpeta ?? 'CAMBIO DE DOMICILIO SOLICITADO',
      datos.subidaEn ?? null,
    )
    .run();
}

test('GET /api/estadisticas responde metricas completas con paridad al modelo .NET', async () => {
  const db = crearD1Fake();
  await insertar(db, {
    comuna: 'Valparaiso',
    enviadaEn: '2026-01-05T09:00:00',
    subidaEn: '2026-01-12',
    estadoCarpeta: 'SUBIDA A CONASET',
  });
  await insertar(db, {
    comuna: 'Valparaiso',
    rut: '22222222-2',
    enviadaEn: '2026-01-06T09:00:00',
    estadoCarpeta: 'CAMBIO DE DOMICILIO SOLICITADO',
  });
  await insertar(db, { comuna: 'Vina', estado: 'Borrador', enviadaEn: null });

  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e) };
  const res = await app.request('/api/estadisticas', { headers }, e);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.totalEnviadas, 2);
  assert.equal(body.comunasConEnvios, 1);
  assert.equal(body.cerradas, 1);
  assert.equal(body.abiertas, 1);
  assert.equal(body.subioComuna, 1);
  assert.equal(body.subimosNosotros, 0);
  assert.equal(body.demoraPromedio, 5);
  assert.ok(Array.isArray(body.rankingVolumen));
  assert.ok(Array.isArray(body.porComuna));
  assert.equal(body.porComuna[0].comuna, 'Valparaiso');
});

test('GET /api/estadisticas usa <= 5 D1 calls incluso con miles de filas', async () => {
  const db = crearD1Fake();
  for (let i = 0; i < 500; i++) {
    // eslint-disable-next-line no-await-in-loop
    await insertar(db, {
      comuna: `COMUNA${i % 30}`,
      rut: `${10000000 + i}-${i % 10}`,
      enviadaEn: '2026-01-05T09:00:00',
      subidaEn: i % 2 === 0 ? '2026-01-10' : null,
      estadoCarpeta: i % 2 === 0 ? 'SUBIDA A CONASET' : 'CAMBIO DE DOMICILIO SOLICITADO',
    });
  }

  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e) };

  db.resetStats();
  const res = await app.request('/api/estadisticas', { headers }, e);
  assert.equal(res.status, 200);
  const { calls } = db.stats();
  assert.ok(calls <= 5, `esperaba <= 5 D1 calls, uso ${calls}`);
});
