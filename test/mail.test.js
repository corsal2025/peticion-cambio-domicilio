import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { upsertPeticion, listarPeticiones, marcarPeticion } from '../worker/lib/peticiones.js';
import { prepararEnvios, encolarEnvios, enviarDirecto } from '../worker/lib/mail.js';
import { fold } from '../worker/lib/normalizar.js';

async function crearPeticionMarcada(db, datos) {
  const { id } = await upsertPeticion(db, datos);
  await marcarPeticion(db, id, true);
  return id;
}

test('prepararEnvios agrupa por comuna y arma asunto/cuerpo', async () => {
  const db = crearD1Fake();
  await crearPeticionMarcada(db, { nombreCompleto: 'Juan Perez', rut: '11.111.111-1', comuna: 'Concepcion' });
  await crearPeticionMarcada(db, { nombreCompleto: 'Ana Soto', rut: '22.222.222-2', comuna: 'Concepcion' });
  const pendientes = (await listarPeticiones(db)).filter((p) => p.marcada && !p.enviada_en);

  const envios = prepararEnvios(pendientes, { correoDestino: 'concepcion@muni.cl', testEmail: '' });

  assert.equal(envios.length, 1);
  assert.equal(envios[0].para, 'concepcion@muni.cl');
  assert.match(envios[0].cuerpo, /Juan Perez/);
  assert.match(envios[0].cuerpo, /Ana Soto/);
  assert.deepEqual(envios[0].peticionIds.sort(), [1, 2]);
});

test('prepararEnvios matchea la comuna via correosPorComuna normalizado (fold), no exacto', async () => {
  const db = crearD1Fake();
  await crearPeticionMarcada(db, { nombreCompleto: 'Juan Perez', rut: '11.111.111-1', comuna: 'Viña del Mar' });
  const pendientes = (await listarPeticiones(db)).filter((p) => p.marcada && !p.enviada_en);

  // correosPorComuna llega con clave normalizada (fold), como la construye el
  // caller (worker/routes/peticiones.js) a partir de comunas.lib fold(nombre).
  const envios = prepararEnvios(pendientes, {
    correosPorComuna: { [fold('VINA DEL MAR')]: 'vina@muni.cl' },
    testEmail: '',
  });

  assert.equal(envios.length, 1);
  assert.equal(envios[0].para, 'vina@muni.cl');
});

test('prepararEnvios reemplaza destinatario cuando hay testEmail configurado', async () => {
  const db = crearD1Fake();
  await crearPeticionMarcada(db, { nombreCompleto: 'Juan Perez', rut: '11.111.111-1', comuna: 'Concepcion' });
  const pendientes = await listarPeticiones(db);

  const envios = prepararEnvios(pendientes, { correoDestino: 'concepcion@muni.cl', testEmail: 'pruebas@muni.cl' });

  assert.equal(envios[0].para, 'pruebas@muni.cl');
});

test('encolarEnvios inserta en envios pendiente y pasa peticiones a EnCola sin marca', async () => {
  const db = crearD1Fake();
  const id = await crearPeticionMarcada(db, { nombreCompleto: 'Juan Perez', rut: '11.111.111-1', comuna: 'Concepcion' });
  const envios = [{ para: 'concepcion@muni.cl', asunto: 'Solicitud de cambio de domicilio', cuerpo: 'texto', peticionIds: [id] }];

  await encolarEnvios(db, envios);

  const fila = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(id).first();
  assert.equal(fila.estado, 'EnCola');
  assert.equal(fila.marcada, 0);
  const { results } = await db.prepare('SELECT * FROM envios').all();
  assert.equal(results.length, 1);
  assert.equal(results[0].estado, 'pendiente');
  assert.equal(results[0].para, 'concepcion@muni.cl');
});

test('enviarDirecto exitoso marca envio enviado y peticion Enviada', async () => {
  const db = crearD1Fake();
  const id = await crearPeticionMarcada(db, { nombreCompleto: 'Juan Perez', rut: '11.111.111-1', comuna: 'Concepcion' });
  await encolarEnvios(db, [{ para: 'concepcion@muni.cl', asunto: 'S', cuerpo: 'C', peticionIds: [id] }]);
  const envio = await db.prepare('SELECT * FROM envios LIMIT 1').first();

  const fetchImpl = async () => ({ status: 200, text: async () => '<Envelope/>' });
  await enviarDirecto(db, envio, { url: 'https://ews.local', usuario: 'u', clave: 'p' }, { fetchImpl, sleep: async () => {} });

  const envioActualizado = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(envio.id).first();
  assert.equal(envioActualizado.estado, 'enviado');
  const peticion = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(id).first();
  assert.equal(peticion.estado, 'Enviada');
  assert.ok(peticion.enviada_en);
});

test('enviarDirecto con falla marca envio error', async () => {
  const db = crearD1Fake();
  const id = await crearPeticionMarcada(db, { nombreCompleto: 'Juan Perez', rut: '11.111.111-1', comuna: 'Concepcion' });
  await encolarEnvios(db, [{ para: 'concepcion@muni.cl', asunto: 'S', cuerpo: 'C', peticionIds: [id] }]);
  const envio = await db.prepare('SELECT * FROM envios LIMIT 1').first();

  const fetchImpl = async () => ({ status: 401, text: async () => '' });
  await enviarDirecto(db, envio, { url: 'https://ews.local', usuario: 'u', clave: 'p' }, { fetchImpl, sleep: async () => {} });

  const envioActualizado = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(envio.id).first();
  assert.equal(envioActualizado.estado, 'error');
});
