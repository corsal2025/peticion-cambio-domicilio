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

  await reportarResultado(db, tomado.id, true, 'enviado ok');

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

  await reportarResultado(db, tomado.id, false, 'timeout');

  const envioActualizado = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(tomado.id).first();
  assert.equal(envioActualizado.estado, 'pendiente');
  assert.equal(envioActualizado.intentos, 1);
});

test('reportarResultado error agota intentos y pasa a error', async () => {
  const db = crearD1Fake();
  await crearEnvioPendiente(db);

  for (let i = 0; i < 4; i++) {
    const [tomado] = await obtenerPendientes(db, 10);
    await reportarResultado(db, tomado.id, false, 'timeout');
  }

  const envio = await db.prepare('SELECT * FROM envios LIMIT 1').first();
  assert.equal(envio.estado, 'error');
  assert.equal(envio.intentos, 4);
});
