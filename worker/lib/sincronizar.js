// Sincronizacion manual "bajo demanda": paridad del boton "Cargar cambios de
// domicilio" del .NET viejo. Dispara el mismo flujo que ya corre cada 15 min
// por el time trigger de Apps Script (ver apps-script/Code.gs sincronizar_),
// pero invocado desde el dashboard via POST /api/sincronizar (sesion
// requerida, cualquier rol). El worker llama al web app de Apps Script
// (doPost) con el mismo IMPORT_SECRET que ya usan /api/import y
// /api/comunas/sync, asi Apps Script no necesita un secreto nuevo.
//
// Salvaguardas:
//  - Rate limit de 60s entre invocaciones (evita que alguien golpee el boton
//    y dispare corridas superpuestas ademas del LockService del lado
//    Apps Script).
//  - Timeout de 90s: si Apps Script no contesta a tiempo (el sync real puede
//    tardar varios minutos con miles de filas), se responde 202 "en curso"
//    en vez de dejar al usuario esperando indefinidamente; la corrida sigue
//    en Apps Script igual.
import { obtenerConfig, setConfig } from './config.js';

const CLAVE_ULTIMO_INTENTO_MS = 'sincronizar.ultimo_intento_ms';
const VENTANA_RATE_LIMIT_MS = 60_000;
const TIMEOUT_MS = 90_000;

const ACCIONES_VALIDAS = new Set(['cargar', 'actualizar']);

/**
 * Ejecuta (o rechaza) una sincronizacion manual.
 * @param {object} env Bindings del worker (DB, APPS_SCRIPT_URL, IMPORT_SECRET).
 * @param {typeof fetch} fetchImpl Inyectable para tests; por defecto usa el fetch global.
 * @param {'cargar'|'actualizar'} [accion] paridad con los dos botones del dashboard
 *   ("Cargar cambios de domicilio" / "Actualizar estado solicitud"): se reenvia tal
 *   cual a Apps Script (doPost), que decide que hojas/filas procesar. Si se omite u
 *   es invalido, Apps Script hace la corrida completa (cargar + actualizar), igual
 *   que el trigger de 15 minutos.
 * @returns {Promise<{status:number, body:object}>}
 */
export async function ejecutarSincronizacionManual(env, fetchImpl = fetch, accion) {
  if (!env.APPS_SCRIPT_URL) {
    return { status: 503, body: { ok: false, error: 'Sincronizacion manual no configurada (falta APPS_SCRIPT_URL)' } };
  }

  const ahora = Date.now();
  const ultimoIntento = Number(await obtenerConfig(env.DB, CLAVE_ULTIMO_INTENTO_MS)) || 0;
  if (ahora - ultimoIntento < VENTANA_RATE_LIMIT_MS) {
    return { status: 429, body: { ok: false, error: 'Espera unos segundos antes de sincronizar de nuevo.' } };
  }
  await setConfig(env.DB, CLAVE_ULTIMO_INTENTO_MS, String(ahora));

  const body = { secret: env.IMPORT_SECRET };
  if (ACCIONES_VALIDAS.has(accion)) {
    body.accion = accion;
  }

  let respuesta;
  try {
    respuesta = await fetchImpl(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return {
        status: 202,
        body: { ok: true, enCurso: true, mensaje: 'La sincronizacion sigue corriendo, refresca en 1-2 minutos' },
      };
    }
    return { status: 502, body: { ok: false, error: 'No se pudo contactar Apps Script: ' + err.message } };
  }

  const texto = await respuesta.text();
  let parsed = null;
  try {
    parsed = JSON.parse(texto);
  } catch {
    parsed = null;
  }

  if (!respuesta.ok || !parsed) {
    const detalle = texto ? texto.slice(0, 200) : '';
    return { status: 502, body: { ok: false, error: `Apps Script respondio ${respuesta.status}${detalle ? ': ' + detalle : ''}` } };
  }

  return { status: 200, body: parsed };
}

/** Fecha (texto, columna `en`) de la sincronizacion mas reciente registrada en sync_log, o null si no hay ninguna. */
export async function obtenerUltimaSincronizacion(db) {
  const fila = await db.prepare('SELECT en FROM sync_log ORDER BY en DESC, id DESC LIMIT 1').first();
  return fila ? fila.en : null;
}
