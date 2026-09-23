// Motor de relay (modo MAIL_MODE=relay): el .exe .NET (`--relay`) hace polling
// autenticado sobre estos endpoints (worker/routes/relay.js) para enviar por
// EWS local sin exponer Exchange a internet.
// Transiciones: pendiente -> tomado (obtenerPendientes) -> enviado | pendiente/error (reportarResultado).
// Un `tomado` que no reporta resultado en 10 min se re-libera (el proceso relay
// pudo haberse caido a mitad de camino).
//
// Claim atomico: obtenerPendientes reclama cada fila con un UPDATE condicional
// (`WHERE estado = 'pendiente'`) que solo tiene efecto si nadie mas la tomo
// primero (protege contra dos procesos relay corriendo en paralelo), y le
// asigna un `lease_token` unico. reportarResultado exige ese mismo token y que
// el envio siga en 'tomado' -> un reporte tardio o duplicado (envio ya
// 'enviado'/re-liberado con otro lease) es un no-op idempotente, nunca un
// doble envio al municipio.
import { marcarComoEnviada } from './peticiones.js';
import { peticionesDelEnvio } from './envioPeticiones.js';

const TOMADO_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INTENTOS = 4;

function generarLeaseToken() {
  return crypto.randomUUID();
}

/** Re-libera envios 'tomado' hace mas de 10 minutos (vuelven a 'pendiente'). */
async function reliberarTomadosVencidos(db) {
  const limite = new Date(Date.now() - TOMADO_TIMEOUT_MS).toISOString();
  await db.prepare("UPDATE envios SET estado = 'pendiente', lease_token = NULL WHERE estado = 'tomado' AND tomado_en < ?").bind(limite).run();
}

/**
 * Toma hasta `limite` envios pendientes (los marca 'tomado' con tomado_en=ahora
 * y un lease_token unico) y los retorna para que el relay los procese. El
 * claim de cada fila es atomico: el UPDATE solo aplica si SIGUE 'pendiente'.
 */
export async function obtenerPendientes(db, limite = 10) {
  await reliberarTomadosVencidos(db);

  const { results } = await db
    .prepare("SELECT * FROM envios WHERE estado = 'pendiente' ORDER BY id ASC LIMIT ?")
    .bind(limite)
    .all();

  const tomados = [];
  const ahora = new Date().toISOString();
  for (const envio of results) {
    const leaseToken = generarLeaseToken();
    const { meta } = await db
      .prepare("UPDATE envios SET estado = 'tomado', tomado_en = ?, lease_token = ? WHERE id = ? AND estado = 'pendiente'")
      .bind(ahora, leaseToken, envio.id)
      .run();
    if (meta.changes === 0) continue; // otro proceso lo reclamo primero
    envio.estado = 'tomado';
    envio.tomado_en = ahora;
    envio.lease_token = leaseToken;
    tomados.push(envio);
  }
  return tomados;
}

/**
 * Reporta el resultado de un envio tomado por el relay. Exige que el envio
 * siga 'tomado' y que `leaseToken` coincida con el asignado en el claim; si
 * no, es un no-op idempotente (reporte tardio, duplicado, o de otro proceso).
 * ok=true: enviado, limpia marca y setea enviada_en en las peticiones.
 * ok=false: reintenta (vuelve a pendiente) hasta MAX_INTENTOS, luego 'error'.
 */
export async function reportarResultado(db, envioId, ok, detalle, leaseToken) {
  const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(envioId).first();
  if (!envio) throw new Error(`Envio ${envioId} no existe`);

  if (envio.estado !== 'tomado' || envio.lease_token !== leaseToken) {
    return { ok: false, motivo: 'lease_invalido' };
  }

  if (ok) {
    const ahora = new Date().toISOString();
    const { meta } = await db
      .prepare("UPDATE envios SET estado = 'enviado', resultado = ?, enviado_en = ?, lease_token = NULL WHERE id = ? AND estado = 'tomado' AND lease_token = ?")
      .bind(detalle ?? null, ahora, envioId, leaseToken)
      .run();
    if (meta.changes === 0) return { ok: false, motivo: 'lease_invalido' };
    const ids = await peticionesDelEnvio(db, envio);
    for (const id of ids) {
      await marcarComoEnviada(db, id, ahora, envio.para);
    }
    return { ok: true };
  }

  const intentos = envio.intentos + 1;
  const nuevoEstado = intentos >= MAX_INTENTOS ? 'error' : 'pendiente';
  const { meta } = await db
    .prepare("UPDATE envios SET estado = ?, resultado = ?, intentos = ?, lease_token = NULL WHERE id = ? AND estado = 'tomado' AND lease_token = ?")
    .bind(nuevoEstado, detalle ?? null, intentos, envioId, leaseToken)
    .run();
  if (meta.changes === 0) return { ok: false, motivo: 'lease_invalido' };
  return { ok: false, estado: nuevoEstado };
}
