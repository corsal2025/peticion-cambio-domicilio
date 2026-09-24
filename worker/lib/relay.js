// Motor de relay (modo MAIL_MODE=relay): el .exe .NET (`--relay`) hace polling
// autenticado sobre estos endpoints (worker/routes/relay.js) para enviar por
// EWS local sin exponer Exchange a internet.
// Transiciones: pendiente -> tomado (obtenerPendientes) -> enviado | pendiente/error (reportarResultado).
// Un `tomado` que no reporta resultado en 10 min NO se re-libera solo a
// 'pendiente' (eso arriesgaria un doble envio real por EWS si el relay SI
// alcanzo a enviar el correo antes de caerse a mitad de camino reportando el
// resultado): pasa a 'revision', visible para un admin en el dashboard, que
// debe confirmar manualmente si el correo salio (revisando el buzon de
// enviados) antes de reintentar. Un reporte tardio con el `lease_token`
// correcto para un envio en 'revision' se sigue aceptando y lo resuelve solo.
//
// Claim atomico: obtenerPendientes reclama cada fila con un UPDATE condicional
// (`WHERE estado = 'pendiente'`) que solo tiene efecto si nadie mas la tomo
// primero (protege contra dos procesos relay corriendo en paralelo), y le
// asigna un `lease_token` unico. reportarResultado exige ese mismo token y que
// el envio siga en 'tomado'/'revision' -> un reporte tardio o duplicado (envio
// ya 'enviado' o reencolado con otro lease) es un no-op idempotente, nunca un
// doble envio al municipio.
import { marcarComoEnviadas } from './peticiones.js';
import { peticionesDelEnvio } from './envioPeticiones.js';

const TOMADO_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INTENTOS = 4;
const ESTADOS_RESOLUBLES = "('tomado','revision')";

function generarLeaseToken() {
  return crypto.randomUUID();
}

/**
 * Mueve a 'revision' los envios 'tomado' hace mas de 10 minutos. NO los
 * vuelve a 'pendiente' automaticamente (eso podria disparar un segundo envio
 * real por EWS si el primero SI salio y el relay solo se cayo antes de
 * reportar); conserva el lease_token para que un reporte tardio del relay
 * original todavia pueda resolverlos.
 */
async function moverVencidosARevision(db) {
  const limite = new Date(Date.now() - TOMADO_TIMEOUT_MS).toISOString();
  await db.prepare("UPDATE envios SET estado = 'revision' WHERE estado = 'tomado' AND tomado_en < ?").bind(limite).run();
}

/**
 * Toma hasta `limite` envios pendientes (los marca 'tomado' con tomado_en=ahora
 * y un lease_token unico) y los retorna para que el relay los procese. El
 * claim de cada fila es atomico: el UPDATE solo aplica si SIGUE 'pendiente'.
 */
export async function obtenerPendientes(db, limite = 10) {
  await moverVencidosARevision(db);

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
 * siga 'tomado' o 'revision' (reporte tardio de un lease que ya vencio) y que
 * `leaseToken` coincida con el asignado en el claim; si no, es un no-op
 * idempotente (reporte tardio con token equivocado, duplicado, o de otro
 * proceso).
 * ok=true: enviado, limpia marca y setea enviada_en en las peticiones.
 * ok=false: reintenta (vuelve a pendiente) hasta MAX_INTENTOS, luego 'error'.
 */
export async function reportarResultado(db, envioId, ok, detalle, leaseToken) {
  const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(envioId).first();
  if (!envio) throw new Error(`Envio ${envioId} no existe`);

  if ((envio.estado !== 'tomado' && envio.estado !== 'revision') || envio.lease_token !== leaseToken) {
    return { ok: false, motivo: 'lease_invalido' };
  }

  if (ok) {
    const ahora = new Date().toISOString();
    const { meta } = await db
      .prepare(`UPDATE envios SET estado = 'enviado', resultado = ?, enviado_en = ?, lease_token = NULL WHERE id = ? AND estado IN ${ESTADOS_RESOLUBLES} AND lease_token = ?`)
      .bind(detalle ?? null, ahora, envioId, leaseToken)
      .run();
    if (meta.changes === 0) return { ok: false, motivo: 'lease_invalido' };
    const ids = await peticionesDelEnvio(db, envio);
    await marcarComoEnviadas(db, ids, ahora, envio.para);
    return { ok: true };
  }

  const intentos = envio.intentos + 1;
  const nuevoEstado = intentos >= MAX_INTENTOS ? 'error' : 'pendiente';
  const { meta } = await db
    .prepare(`UPDATE envios SET estado = ?, resultado = ?, intentos = ?, lease_token = NULL WHERE id = ? AND estado IN ${ESTADOS_RESOLUBLES} AND lease_token = ?`)
    .bind(nuevoEstado, detalle ?? null, intentos, envioId, leaseToken)
    .run();
  if (meta.changes === 0) return { ok: false, motivo: 'lease_invalido' };
  return { ok: false, estado: nuevoEstado };
}

/** Lista los envios actualmente en 'revision', para el panel admin. */
export async function listarEnRevision(db) {
  const { results } = await db.prepare("SELECT * FROM envios WHERE estado = 'revision' ORDER BY tomado_en ASC").all();
  return results;
}

/**
 * Accion admin: reencola desde cero un envio en 'revision' (vuelve a
 * 'pendiente', limpia lease y marca de tomado). Usar SOLO tras confirmar que
 * el correo original NO salio (revisando el buzon de enviados); si el correo
 * SI salio, usar `confirmarEnviadoManual` en su lugar para no duplicar el
 * envio real por EWS.
 */
export async function reencolarRevision(db, envioId) {
  const { meta } = await db
    .prepare("UPDATE envios SET estado = 'pendiente', lease_token = NULL, tomado_en = NULL WHERE id = ? AND estado = 'revision'")
    .bind(envioId)
    .run();
  return { ok: meta.changes > 0 };
}

/**
 * Accion admin: confirma manualmente (tras revisar el buzon de enviados) que
 * un envio en 'revision' SI salio por EWS. Marca el envio 'enviado' y sus
 * peticiones como enviadas, sin pasar de nuevo por el relay.
 */
export async function confirmarEnviadoManual(db, envioId) {
  const envio = await db.prepare('SELECT * FROM envios WHERE id = ?').bind(envioId).first();
  if (!envio) throw new Error(`Envio ${envioId} no existe`);

  const ahora = new Date().toISOString();
  const { meta } = await db
    .prepare("UPDATE envios SET estado = 'enviado', resultado = 'Confirmado manualmente por admin (revision)', enviado_en = ?, lease_token = NULL WHERE id = ? AND estado = 'revision'")
    .bind(ahora, envioId)
    .run();
  if (meta.changes === 0) return { ok: false };

  const ids = await peticionesDelEnvio(db, envio);
  await marcarComoEnviadas(db, ids, ahora, envio.para);
  return { ok: true };
}
