// Orquesta el envio de correo de "peticiones marcadas": arma un correo por
// comuna (worker/lib/plantilla.js), respeta el modo de prueba (test_email
// reemplaza TODO destinatario) y soporta los dos modos de MAIL_MODE:
//   - relay (default): encola en `envios` (pendiente) para que el .exe --relay
//     lo procese via worker/routes/relay.js.
//   - direct: el propio Worker llama a EWS (worker/lib/ews.js).
import { agruparPorComuna, construirCorreo } from './plantilla.js';
import { enviarEws } from './ews.js';
import { marcarComoEnviada } from './peticiones.js';

/**
 * Arma los correos a enviar (uno por comuna) a partir de las peticiones
 * marcadas y pendientes (ya filtradas por el llamador). No toca la base.
 * @param {Array} peticionesPendientes filas de la tabla `peticiones`
 * @param {{correoDestino?: (comuna:string)=>string|null, correosPorComuna?: Record<string,string>, testEmail?: string}} opciones
 */
export function prepararEnvios(peticionesPendientes, opciones = {}) {
  const grupos = agruparPorComuna(
    peticionesPendientes.map((p) => ({
      id: p.id,
      nombreCompleto: p.nombre_completo,
      rut: p.rut,
      comuna: p.comuna,
      clases: p.clases,
    })),
  );

  const testEmail = opciones.testEmail && opciones.testEmail.trim() !== '' ? opciones.testEmail.trim() : null;

  return grupos.map(({ comuna, peticiones }) => {
    const { asunto, cuerpo } = construirCorreo(peticiones, opciones.firmaCorreo ?? '');
    let para = opciones.correoDestino ?? (opciones.correosPorComuna ? opciones.correosPorComuna[comuna] : null);
    if (testEmail) {
      para = testEmail;
    }
    return { comuna, para, asunto, cuerpo, peticionIds: peticiones.map((p) => p.id) };
  });
}

/**
 * Inserta un envio 'pendiente' por grupo y pasa las peticiones involucradas a
 * estado 'EnCola' con marcada=0 (ya no aparecen como pendientes de marcar).
 */
export async function encolarEnvios(db, envios) {
  for (const envio of envios) {
    const result = await db
      .prepare('INSERT INTO envios (peticion_id, para, asunto, cuerpo_html) VALUES (?, ?, ?, ?)')
      .bind(envio.peticionIds[0], envio.para, envio.asunto, envio.cuerpo)
      .run();

    for (const id of envio.peticionIds) {
      await db.prepare("UPDATE peticiones SET estado = 'EnCola', marcada = 0 WHERE id = ?").bind(id).run();
    }

    envio.envioId = result.meta.last_row_id;
  }
  return envios;
}

/** Busca las peticiones que quedaron encoladas para un mismo envio (mismo para/asunto/cuerpo, EnCola). */
async function peticionesDelEnvio(db, envio) {
  // El envio guarda solo peticion_id (representante) por simplicidad de esquema;
  // como el cuerpo agrupa varias peticiones por comuna, se resuelven todas las
  // que compartan comuna y esten EnCola en el momento del envio.
  const representante = await db.prepare('SELECT comuna FROM peticiones WHERE id = ?').bind(envio.peticion_id).first();
  if (!representante) return [envio.peticion_id];
  const { results } = await db
    .prepare("SELECT id FROM peticiones WHERE comuna = ? AND estado = 'EnCola'")
    .bind(representante.comuna)
    .all();
  return results.length ? results.map((r) => r.id) : [envio.peticion_id];
}

/** Envia un `envio` (fila de la tabla) por EWS directo y refleja el resultado en D1. */
export async function enviarDirecto(db, envio, ewsOpciones, deps = {}) {
  const ids = await peticionesDelEnvio(db, envio);
  try {
    await enviarEws(ewsOpciones, { to: envio.para, subject: envio.asunto, body: envio.cuerpo_html }, deps);
    const ahora = new Date().toISOString();
    await db
      .prepare("UPDATE envios SET estado = 'enviado', resultado = 'ok', enviado_en = ? WHERE id = ?")
      .bind(ahora, envio.id)
      .run();
    for (const id of ids) {
      await marcarComoEnviada(db, id, ahora, envio.para);
    }
    return { ok: true };
  } catch (err) {
    await db
      .prepare("UPDATE envios SET estado = 'error', resultado = ?, intentos = intentos + 1 WHERE id = ?")
      .bind(err.message, envio.id)
      .run();
    return { ok: false, error: err.message };
  }
}
