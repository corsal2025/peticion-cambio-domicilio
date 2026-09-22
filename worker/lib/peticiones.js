// Persistencia de peticiones sobre D1. Clave natural de deduplicacion:
// (rut_norm, comuna_norm), igual que Peticion.cs (AddIfNew): si ya existe,
// refresca nombre_completo, clases, fecha_solicitud, oficina, origen,
// orden_importacion y rut_invalido; NUNCA sobrescribe marcada, estado,
// detalle_estado, enviada_en ni destinatarios_correo. estado_carpeta solo
// avanza (nunca retrocede), segun el rango de worker/lib/estadoCarpeta.js.
import { fold, coincide } from './normalizar.js';
import { normalizar as normalizarEstado, rango } from './estadoCarpeta.js';

function rutNorm(rut) {
  return String(rut ?? '')
    .toUpperCase()
    .replace(/[^0-9K]/g, '');
}

function comunaNorm(comuna) {
  return fold(comuna);
}

/**
 * Inserta una peticion nueva o refresca una existente por (rut_norm, comuna_norm).
 * @returns {Promise<{id: number, creada: boolean}>}
 */
export async function upsertPeticion(db, datos) {
  const rn = rutNorm(datos.rut);
  const cn = comunaNorm(datos.comuna);
  const estadoCarpetaEntrante = normalizarEstado(datos.estadoCarpeta);

  const existente = await db
    .prepare('SELECT id, estado_carpeta FROM peticiones WHERE rut_norm = ? AND comuna_norm = ?')
    .bind(rn, cn)
    .first();

  if (!existente) {
    const result = await db
      .prepare(
        `INSERT INTO peticiones
          (nombre_completo, rut, rut_norm, comuna, comuna_norm, clases, fecha_solicitud,
           oficina, origen, orden_importacion, rut_invalido, estado_carpeta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        datos.nombreCompleto,
        datos.rut,
        rn,
        datos.comuna,
        cn,
        datos.clases ?? null,
        datos.fechaSolicitud ?? null,
        datos.oficina ?? null,
        datos.origen ?? null,
        datos.ordenImportacion ?? 0,
        datos.rutInvalido ? 1 : 0,
        estadoCarpetaEntrante,
      )
      .run();
    return { id: result.meta.last_row_id, creada: true };
  }

  const estadoCarpetaFinal = rango(estadoCarpetaEntrante) > rango(existente.estado_carpeta)
    ? estadoCarpetaEntrante
    : existente.estado_carpeta;

  await db
    .prepare(
      `UPDATE peticiones SET
         nombre_completo = ?, clases = ?, fecha_solicitud = ?, oficina = ?, origen = ?,
         orden_importacion = ?, rut_invalido = ?, estado_carpeta = ?
       WHERE id = ?`,
    )
    .bind(
      datos.nombreCompleto,
      datos.clases ?? null,
      datos.fechaSolicitud ?? null,
      datos.oficina ?? null,
      datos.origen ?? null,
      datos.ordenImportacion ?? 0,
      datos.rutInvalido ? 1 : 0,
      estadoCarpetaFinal,
      existente.id,
    )
    .run();

  return { id: existente.id, creada: false };
}

/** Lista peticiones, opcionalmente filtradas por rut/nombre (buscador). */
export async function listarPeticiones(db, { busqueda } = {}) {
  const { results } = await db.prepare('SELECT * FROM peticiones ORDER BY orden_importacion ASC, id ASC').all();
  if (!busqueda) {
    return results;
  }
  return results.filter((p) => coincide(p.rut, busqueda) || coincide(p.nombre_completo, busqueda));
}

export async function marcarPeticion(db, id, marcada) {
  await db.prepare('UPDATE peticiones SET marcada = ? WHERE id = ?').bind(marcada ? 1 : 0, id).run();
}

export async function marcarTodas(db, ids, marcada) {
  for (const id of ids) {
    await marcarPeticion(db, id, marcada);
  }
}

/** Limpia la marca y setea enviada_en tras un envio exitoso. */
export async function marcarComoEnviada(db, id, enviadaEn, destinatarios) {
  await db
    .prepare(
      "UPDATE peticiones SET marcada = 0, estado = 'Enviada', enviada_en = ?, destinatarios_correo = ? WHERE id = ?",
    )
    .bind(enviadaEn, destinatarios ?? null, id)
    .run();
}
