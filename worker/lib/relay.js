// Motor de relay (modo MAIL_MODE=relay): el .exe .NET (`--relay`) hace polling
// autenticado sobre estos endpoints (worker/routes/relay.js) para enviar por
// EWS local sin exponer Exchange a internet.
// Transiciones: pendiente -> tomado (obtenerPendientes) -> enviado | pendiente/error (reportarResultado).
// Un `tomado` que no reporta resultado en 10 min se re-libera (el proceso relay
// pudo haberse caido a mitad de camino).
import { marcarComoEnviada } from './peticiones.js';

const TOMADO_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INTENTOS = 4;

/** Re-libera envios 'tomado' hace mas de 10 minutos (vuelven a 'pendiente'). */
async function reliberarTomadosVencidos(db) {
  const limite = new Date(Date.now() - TOMADO_TIMEOUT_MS).toISOString();
  await db.prepare("UPDATE envios SET estado = 'pendiente' WHERE estado = 'tomado' AND tomado_en < ?").bind(limite).run();
}

/**
 * Toma hasta `limite` envios pendientes (los marca 'tomado' con tomado_en=ahora)
 * y los retorna para que el relay los procese.
 */
export async function obtenerPendientes(db, limite = 10) {
  await reliberarTomadosVencidos(db);

  const { results } = await db
    .prepare("SELECT * FROM envios WHERE estado = 'pendiente' ORDER BY id ASC LIMIT ?")
    .bind(limite)
    .all();

  const ahora = new Date().toISOString();
  for (const envio of results) {
    await db.prepare("UPDATE envios SET estado = 'tomado', tomado_en = ? WHERE id = ?").bind(ahora, envio.id).run();
    envio.estado = 'tomado';
    envio.tomado_en = ahora;
  }
  return results;
}

/** Busca todas las peticiones EnCola que comparten comuna con el representante del envio. */
async function peticionesDelEnvio(db, envio) {
  const representante = await db.prepare('SELECT comuna FROM peticiones WHERE id = ?').bind(envio.peticion_id).first();
  if (!representante) return [envio.peticion_id];
  const { results } = await db
    .prepare("SELECT id FROM peticiones WHERE comuna = ? AND estado = 'EnCola'")
    .bind(representante.comuna)
    .all();
  return results.length ? results.map((r) => r.id) : [envio.peticion_id];
}

/**
 * Reporta el resultado de un envio tomado por el relay.
 * ok=true: enviado, limpia marca y setea enviada_en en las peticiones.
 * ok=false: reintenta (vuelve a pendiente) hasta MAX_INTENTOS, luego 'error'.
 */
export async function reportarResultado(db, envioId, ok, detalle) {
  const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(envioId).first();
  if (!envio) throw new Error(`Envio ${envioId} no existe`);

  if (ok) {
    const ahora = new Date().toISOString();
    await db
      .prepare("UPDATE envios SET estado = 'enviado', resultado = ?, enviado_en = ? WHERE id = ?")
      .bind(detalle ?? null, ahora, envioId)
      .run();
    const ids = await peticionesDelEnvio(db, envio);
    for (const id of ids) {
      await marcarComoEnviada(db, id, ahora, envio.para);
    }
    return { ok: true };
  }

  const intentos = envio.intentos + 1;
  const nuevoEstado = intentos >= MAX_INTENTOS ? 'error' : 'pendiente';
  await db
    .prepare('UPDATE envios SET estado = ?, resultado = ?, intentos = ? WHERE id = ?')
    .bind(nuevoEstado, detalle ?? null, intentos, envioId)
    .run();
  return { ok: false, estado: nuevoEstado };
}
