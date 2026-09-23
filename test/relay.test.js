import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { upsertPeticion, marcarPeticion } from '../worker/lib/peticiones.js';
import { encolarEnvios } from '../worker/lib/mail.js';
import { obtenerPendientes, reportarResultado } from '../worker/lib/relay.js';

async function crearEnvioPendiente(db) {
  const { id } = await upsertPeticion(db, { nombreCompleto: 'Juan Perez', rut: '11.111.111-1', comuna: 'Concepcion' });
  await marcarPeticion(db, id, true);
  await encolarEnvios(db, [{ para: 'concepcion@muni.cl', asunto: 'S', cuerpo: 'C', peticionIds: [id] }]);
  const envio = await db.prepare('SELECT * FROM envios LIMIT 1').first();
  return { peticionId: id, envio };
}

test('obtenerPendientes marca como tomado y no repite hasta liberarse', async () => {
  const db = crearD1Fake();
  await crearEnvioPendiente(db);

  const primera = await obtenerPendientes(db, 10);
  assert.equal(primera.length, 1);
  assert.equal(primera[0].estado, 'tomado');

  const segunda = await obtenerPendientes(db, 10);
  assert.equal(segunda.length, 0);
});

test('obtenerPendientes re-libera tomados hace mas de 10 minutos', async () => {
  const db = crearD1Fake();
  const { envio } = await crearEnvioPendiente(db);
  const hace11min = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await db.prepare("UPDATE envios SET estado = 'tomado', tomado_en = ? WHERE id = ?").bind(hace11min, envio.id).run();

  const pendientes = await obtenerPendientes(db, 10);
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0].id, envio.id);
});

test('reportarResultado ok limpia marca y setea enviada_en de la peticion', async () => {
  const db = crearD1Fake();
  const { peticionId } = await crearEnvioPendiente(db);
  const [tomado] = await obtenerPendientes(db, 10);

  await reportarResultado(db, tomado.id, true, 'enviado ok', tomado.lease_token);

  const envioActualizado = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(tomado.id).first();
  assert.equal(envioActualizado.estado, 'enviado');
  const peticion = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(peticionId).first();
  assert.equal(peticion.marcada, 0);
  assert.equal(peticion.estado, 'Enviada');
  assert.ok(peticion.enviada_en);
});

test('reportarResultado error reintentable vuelve a pendiente', async () => {
  const db = crearD1Fake();
  await crearEnvioPendiente(db);
  const [tomado] = await obtenerPendientes(db, 10);

  await reportarResultado(db, tomado.id, false, 'timeout', tomado.lease_token);

  const envioActualizado = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(tomado.id).first();
  assert.equal(envioActualizado.estado, 'pendiente');
  assert.equal(envioActualizado.intentos, 1);
});

test('obtenerPendientes asigna un lease_token unico por claim', async () => {
  const db = crearD1Fake();
  await crearEnvioPendiente(db);
  const [tomado] = await obtenerPendientes(db, 10);
  assert.ok(tomado.lease_token);
});

test('reportarResultado con lease_token equivocado es no-op idempotente (no marca la peticion)', async () => {
  const db = crearD1Fake();
  const { peticionId } = await crearEnvioPendiente(db);
  const [tomado] = await obtenerPendientes(db, 10);

  const resultado = await reportarResultado(db, tomado.id, true, 'ok', 'lease-invalido');
  assert.equal(resultado.ok, false);
  assert.equal(resultado.motivo, 'lease_invalido');

  const peticion = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(peticionId).first();
  assert.equal(peticion.estado, 'EnCola');
});

test('reportarResultado tardio sobre un envio ya en enviado es idempotente (no re-marca ni error)', async () => {
  const db = crearD1Fake();
  await crearEnvioPendiente(db);
  const [tomado] = await obtenerPendientes(db, 10);
  await reportarResultado(db, tomado.id, true, 'ok', tomado.lease_token);

  // reporte tardio/duplicado con el mismo lease, envio ya no esta 'tomado'
  const segundo = await reportarResultado(db, tomado.id, true, 'ok-tardio', tomado.lease_token);
  assert.equal(segundo.ok, false);
  assert.equal(segundo.motivo, 'lease_invalido');

  const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(tomado.id).first();
  assert.equal(envio.estado, 'enviado');
});

test('dos envios en cola para la misma comuna: reportar el primero no marca las peticiones del segundo', async () => {
  const db = crearD1Fake();
  const { id: id1 } = await upsertPeticion(db, { nombreCompleto: 'Juan Perez', rut: '11.111.111-1', comuna: 'Concepcion' });
  await marcarPeticion(db, id1, true);
  const { id: id2 } = await upsertPeticion(db, { nombreCompleto: 'Ana Soto', rut: '22.222.222-2', comuna: 'Concepcion' });
  await marcarPeticion(db, id2, true);

  await encolarEnvios(db, [{ para: 'concepcion@muni.cl', asunto: 'S1', cuerpo: 'C1', peticionIds: [id1] }]);
  await encolarEnvios(db, [{ para: 'concepcion@muni.cl', asunto: 'S2', cuerpo: 'C2', peticionIds: [id2] }]);

  const pendientes = await obtenerPendientes(db, 10);
  assert.equal(pendientes.length, 2);
  const primero = pendientes[0];
  await reportarResultado(db, primero.id, true, 'ok', primero.lease_token);

  const p1 = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(id1).first();
  const p2 = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(id2).first();
  assert.equal(p1.estado, 'Enviada');
  assert.equal(p2.estado, 'EnCola');
});

test('reportarResultado error agota intentos y pasa a error', async () => {
  const db = crearD1Fake();
  await crearEnvioPendiente(db);

  for (let i = 0; i < 4; i++) {
    const [tomado] = await obtenerPendientes(db, 10);
    await reportarResultado(db, tomado.id, false, 'timeout', tomado.lease_token);
  }

  const envio = await db.prepare('SELECT * FROM envios LIMIT 1').first();
  assert.equal(envio.estado, 'error');
  assert.equal(envio.intentos, 4);
});
