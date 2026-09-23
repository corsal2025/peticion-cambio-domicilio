import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';
import { importarFilas } from '../worker/lib/importar.js';
import { marcarPeticion } from '../worker/lib/peticiones.js';
import { encolarEnvios } from '../worker/lib/mail.js';

function env(db) {
  return { DB: db, RELAY_SECRET: 'secreto-relay' };
}

async function conEnvioPendiente(db) {
  await importarFilas(db, [{ nombreCompleto: 'Juan', rut: '18785387-7', comuna: 'Valparaiso' }]);
  const peticion = await db.prepare('SELECT * FROM peticiones LIMIT 1').first();
  await marcarPeticion(db, peticion.id, true);
  await encolarEnvios(db, [{ para: 'valpo@muni.cl', asunto: 'S', cuerpo: 'C', peticionIds: [peticion.id] }]);
}

test('GET /api/relay/pendientes sin secreto responde 401', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/relay/pendientes', {}, env(db));
  assert.equal(res.status, 401);
});

test('GET /api/relay/pendientes con secreto valido retorna y marca tomado', async () => {
  const db = crearD1Fake();
  await conEnvioPendiente(db);
  const res = await app.request('/api/relay/pendientes', { headers: { 'X-Relay-Secret': 'secreto-relay' } }, env(db));
  const pendientes = await res.json();
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0].estado, 'tomado');
});

test('POST /api/relay/resultado ok limpia marca y setea enviada_en', async () => {
  const db = crearD1Fake();
  await conEnvioPendiente(db);
  const e = env(db);
  const pendientesRes = await app.request('/api/relay/pendientes', { headers: { 'X-Relay-Secret': 'secreto-relay' } }, e);
  const [tomado] = await pendientesRes.json();

  const resultadoRes = await app.request('/api/relay/resultado', {
    method: 'POST',
    headers: { 'X-Relay-Secret': 'secreto-relay', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tomado.id, ok: true, detalle: 'enviado', leaseToken: tomado.lease_token }),
  }, e);
  assert.equal(resultadoRes.status, 200);

  const peticion = await db.prepare('SELECT * FROM peticiones LIMIT 1').first();
  assert.equal(peticion.estado, 'Enviada');
  assert.equal(peticion.marcada, 0);
});

test('POST /api/relay/resultado con leaseToken invalido no marca la peticion', async () => {
  const db = crearD1Fake();
  await conEnvioPendiente(db);
  const e = env(db);
  const pendientesRes = await app.request('/api/relay/pendientes', { headers: { 'X-Relay-Secret': 'secreto-relay' } }, e);
  const [tomado] = await pendientesRes.json();

  const resultadoRes = await app.request('/api/relay/resultado', {
    method: 'POST',
    headers: { 'X-Relay-Secret': 'secreto-relay', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tomado.id, ok: true, detalle: 'enviado', leaseToken: 'no-es-el-lease' }),
  }, e);
  assert.equal(resultadoRes.status, 200);
  const cuerpo = await resultadoRes.json();
  assert.equal(cuerpo.ok, false);

  const peticion = await db.prepare('SELECT * FROM peticiones LIMIT 1').first();
  assert.equal(peticion.estado, 'EnCola');
});
