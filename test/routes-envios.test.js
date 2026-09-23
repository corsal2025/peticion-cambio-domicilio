import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';
import { upsertPeticion, marcarPeticion } from '../worker/lib/peticiones.js';
import { encolarEnvios } from '../worker/lib/mail.js';

function env(db) {
  return { DB: db, SESSION_SECRET: 'secreto-test', MASTER_PIN: '1234' };
}

async function loginAdmin(e) {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', clave: '1234' }),
  }, e);
  return res.headers.get('set-cookie').split(';')[0];
}

async function crearEnvioEnRevision(db) {
  const { id: peticionId } = await upsertPeticion(db, { nombreCompleto: 'Juan Perez', rut: '11.111.111-1', comuna: 'Concepcion' });
  await marcarPeticion(db, peticionId, true);
  await encolarEnvios(db, [{ para: 'concepcion@muni.cl', asunto: 'S', cuerpo: 'C', peticionIds: [peticionId] }]);
  const envio = await db.prepare('SELECT * FROM envios LIMIT 1').first();
  const hace11min = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await db
    .prepare("UPDATE envios SET estado = 'tomado', tomado_en = ?, lease_token = 'lt-x' WHERE id = ?")
    .bind(hace11min, envio.id)
    .run();
  const { obtenerPendientes } = await import('../worker/lib/relay.js');
  await obtenerPendientes(db, 10); // pasa a revision
  return { peticionId, envioId: envio.id };
}

test('GET /api/envios/revision sin sesion admin responde 401/403', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/envios/revision', {}, env(db));
  assert.equal(res.status, 401);
});

test('GET /api/envios/revision con admin lista los envios en revision', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const { envioId } = await crearEnvioEnRevision(db);
  const cookie = await loginAdmin(e);

  const res = await app.request('/api/envios/revision', { headers: { Cookie: cookie } }, e);
  assert.equal(res.status, 200);
  const cuerpo = await res.json();
  assert.equal(cuerpo.length, 1);
  assert.equal(cuerpo[0].id, envioId);
});

test('POST /api/envios/:id/reencolar vuelve el envio a pendiente', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const { envioId } = await crearEnvioEnRevision(db);
  const cookie = await loginAdmin(e);

  const res = await app.request(`/api/envios/${envioId}/reencolar`, { method: 'POST', headers: { Cookie: cookie } }, e);
  assert.equal(res.status, 200);
  const fila = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(envioId).first();
  assert.equal(fila.estado, 'pendiente');
});

test('POST /api/envios/:id/confirmar marca enviado el envio y su peticion', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const { peticionId, envioId } = await crearEnvioEnRevision(db);
  const cookie = await loginAdmin(e);

  const res = await app.request(`/api/envios/${envioId}/confirmar`, { method: 'POST', headers: { Cookie: cookie } }, e);
  assert.equal(res.status, 200);
  const fila = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(envioId).first();
  assert.equal(fila.estado, 'enviado');
  const peticion = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(peticionId).first();
  assert.equal(peticion.estado, 'Enviada');
});
