import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { ejecutarSincronizacionManual, obtenerUltimaSincronizacion } from '../worker/lib/sincronizar.js';

// Paridad funcional del boton "Cargar cambios de domicilio" del .NET viejo:
// dispara la sincronizacion Apps Script -> worker bajo demanda, en vez de
// esperar los 15 minutos del time trigger. Ver apps-script/Code.gs doPost().

function envBase(db, overrides = {}) {
  return { DB: db, APPS_SCRIPT_URL: 'https://script.google.com/macros/s/xxx/exec', IMPORT_SECRET: 'shh', ...overrides };
}

test('ejecutarSincronizacionManual responde 503 si falta APPS_SCRIPT_URL', async () => {
  const db = crearD1Fake();
  const resultado = await ejecutarSincronizacionManual(envBase(db, { APPS_SCRIPT_URL: undefined }));
  assert.equal(resultado.status, 503);
  assert.equal(resultado.body.ok, false);
});

test('ejecutarSincronizacionManual reenvia el secreto y devuelve el JSON de Apps Script', async () => {
  const db = crearD1Fake();
  const llamadas = [];
  const fetchFalso = async (url, opciones) => {
    llamadas.push({ url, opciones });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, hojasLeidas: 3, filas: [1, 2] }),
    };
  };

  const resultado = await ejecutarSincronizacionManual(envBase(db), fetchFalso);

  assert.equal(resultado.status, 200);
  assert.equal(resultado.body.ok, true);
  assert.equal(resultado.body.hojasLeidas, 3);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, 'https://script.google.com/macros/s/xxx/exec');
  const payload = JSON.parse(llamadas[0].opciones.body);
  assert.equal(payload.secret, 'shh');
});

test('ejecutarSincronizacionManual rechaza con 429 si se llama de nuevo antes de 60s', async () => {
  const db = crearD1Fake();
  const fetchFalso = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });

  const primero = await ejecutarSincronizacionManual(envBase(db), fetchFalso);
  assert.equal(primero.status, 200);

  const segundo = await ejecutarSincronizacionManual(envBase(db), fetchFalso);
  assert.equal(segundo.status, 429);
  assert.equal(segundo.body.ok, false);
});

test('ejecutarSincronizacionManual responde 202 enCurso si Apps Script no contesta a tiempo', async () => {
  const db = crearD1Fake();
  const fetchFalso = async (url, opciones) => {
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    throw err;
  };

  const resultado = await ejecutarSincronizacionManual(envBase(db), fetchFalso);
  assert.equal(resultado.status, 202);
  assert.equal(resultado.body.ok, true);
  assert.equal(resultado.body.enCurso, true);
});

test('ejecutarSincronizacionManual responde 502 si Apps Script contesta con error', async () => {
  const db = crearD1Fake();
  const fetchFalso = async () => ({ ok: false, status: 500, text: async () => 'boom' });

  const resultado = await ejecutarSincronizacionManual(envBase(db), fetchFalso);
  assert.equal(resultado.status, 502);
  assert.equal(resultado.body.ok, false);
});

test('ejecutarSincronizacionManual reenvia accion=cargar/actualizar a Apps Script cuando se especifica', async () => {
  const db = crearD1Fake();
  const llamadas = [];
  const fetchFalso = async (url, opciones) => {
    llamadas.push(JSON.parse(opciones.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  await ejecutarSincronizacionManual(envBase(db), fetchFalso, 'cargar');
  assert.equal(llamadas[0].accion, 'cargar');
});

test('ejecutarSincronizacionManual no manda accion invalida/omitida (Apps Script hace la corrida completa)', async () => {
  const db = crearD1Fake();
  const llamadas = [];
  const fetchFalso = async (url, opciones) => {
    llamadas.push(JSON.parse(opciones.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  await ejecutarSincronizacionManual(envBase(db), fetchFalso, 'algo-invalido');
  assert.equal(llamadas[0].accion, undefined);
});

test('obtenerUltimaSincronizacion retorna null sin filas en sync_log', async () => {
  const db = crearD1Fake();
  assert.equal(await obtenerUltimaSincronizacion(db), null);
});

test('obtenerUltimaSincronizacion retorna la fecha mas reciente de sync_log', async () => {
  const db = crearD1Fake();
  await db.prepare('INSERT INTO sync_log (fuente, recibidas, insertadas, actualizadas, errores) VALUES (?, ?, ?, ?, ?)')
    .bind('apps-script', 1, 1, 0, 0)
    .run();

  const ultima = await obtenerUltimaSincronizacion(db);
  assert.ok(ultima);
});
