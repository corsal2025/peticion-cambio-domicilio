// Import (Apps Script -> /api/import): upsert idempotente por clave natural
// (rut, comuna) via peticiones.js, y limpieza de obsoletas: cualquier
// peticion de origen Excel (oficina != MANUAL) que ya no aparece en la
// sincronizacion actual se elimina. Las filas Oficina=MANUAL nunca se tocan.
//
// El libro real tiene ~4400 filas relevantes, por lo que Apps Script SIEMPRE
// reparte el envio en varios lotes (POST /api/import, ver MAX_FILAS_POR_LOTE
// en apps-script/Code.gs). La limpieza de obsoletas NO puede correr dentro de
// cada lote: un lote individual solo conoce SUS filas, y trataria como
// "desaparecidas" a las de los demas lotes de la misma sincronizacion.
//
// Contrato de dos fases:
//   1) importarFilas(db, filas, {syncId, lote, totalLotes, hojasLeidas}) por
//      cada lote: solo upsert. Acumula las claves vistas de ese syncId en la
//      tabla import_vistos y el progreso de lotes en import_lotes. Nunca
//      borra nada.
//   2) finalizarImport(db, {syncId, hojasLeidas}) una vez que llegaron TODOS
//      los lotes anunciados: recien ahi calcula el set completo de claves
//      vigentes (acumuladas de todos los lotes) y ejecuta la limpieza de
//      obsoletas, con las mismas guardas de seguridad (payload vacio / 0
//      hojas leidas / mas del 50% de las Borrador existentes). Si no
//      llegaron todos los lotes, rechaza sin borrar nada. Limpia el tracking
//      de ese syncId al terminar (haya borrado o no).
import { fold } from './normalizar.js';
import { upsertPeticion } from './peticiones.js';

const MAX_FILAS = 5000;
// Si la limpieza de obsoletas borraria mas de este porcentaje de las peticiones
// Borrador no-manuales existentes, se omite: casi siempre es sintoma de un
// payload de import incompleto (hoja no leida, error de red, etc.), no de que
// realmente hayan desaparecido tantas filas del Excel de una sola vez.
const UMBRAL_BORRADO_MASIVO = 0.5;

function rutNorm(rut) {
  return String(rut ?? '')
    .toUpperCase()
    .replace(/[^0-9K]/g, '');
}

function claveDeFila(fila) {
  return `${rutNorm(fila.rut)}|${fold(fila.comuna)}`;
}

/**
 * Procesa UN lote del import: upsert idempotente de sus filas. No ejecuta
 * limpieza de obsoletas (eso queda para finalizarImport, una vez que se
 * recibieron todos los lotes de la sincronizacion).
 *
 * @param {object} [opciones]
 * @param {string} [opciones.syncId] identificador compartido por todos los
 *   lotes de una misma sincronizacion. Si se omite, el lote se procesa (solo
 *   upsert) sin quedar registrado para ningun finalizarImport posterior —
 *   uso pensado para pruebas/scripts puntuales, no para el flujo real de
 *   Apps Script.
 * @param {number} [opciones.lote] numero de lote (informativo).
 * @param {number} [opciones.totalLotes] cantidad total de lotes anunciados
 *   para este syncId; finalizarImport rechaza si no llegaron todos.
 * @param {number} [opciones.hojasLeidas] hojas leidas en el origen; se
 *   recuerda para el finalizarImport que no lo especifique explicitamente.
 * @returns {Promise<{recibidas:number, insertadas:number, actualizadas:number}>}
 */
export async function importarFilas(db, filas, opciones = {}) {
  if (filas.length > MAX_FILAS) {
    throw new Error(`El import acepta maximo ${MAX_FILAS} filas (llegaron ${filas.length})`);
  }

  let insertadas = 0;
  let actualizadas = 0;
  const clavesVistas = new Set();

  for (const fila of filas) {
    const { creada } = await upsertPeticion(db, fila);
    creada ? insertadas++ : actualizadas++;
    clavesVistas.add(claveDeFila(fila));
  }

  const { syncId } = opciones;
  if (syncId) {
    for (const clave of clavesVistas) {
      await db
        .prepare('INSERT OR IGNORE INTO import_vistos (sync_id, clave) VALUES (?, ?)')
        .bind(syncId, clave)
        .run();
    }

    const progreso = await db.prepare('SELECT sync_id FROM import_lotes WHERE sync_id = ?').bind(syncId).first();
    if (progreso) {
      await db
        .prepare(
          'UPDATE import_lotes SET lotes_vistos = lotes_vistos + 1, ' +
            'total_lotes = COALESCE(?, total_lotes), ' +
            'hojas_leidas = COALESCE(?, hojas_leidas), ' +
            "actualizado_en = datetime('now') WHERE sync_id = ?",
        )
        .bind(opciones.totalLotes ?? null, opciones.hojasLeidas ?? null, syncId)
        .run();
    } else {
      await db
        .prepare(
          'INSERT INTO import_lotes (sync_id, total_lotes, lotes_vistos, hojas_leidas) VALUES (?, ?, 1, ?)',
        )
        .bind(syncId, opciones.totalLotes ?? null, opciones.hojasLeidas ?? null)
        .run();
    }
  }

  return { recibidas: filas.length, insertadas, actualizadas };
}

/**
 * Cierra una sincronizacion identificada por syncId: exige que hayan llegado
 * todos los lotes anunciados y recien ahi ejecuta la limpieza de obsoletas
 * usando el acumulado de claves vistas en TODOS esos lotes. Nunca borra a
 * ciegas: mismas guardas que antes (payload/hojas en 0, o mas del 50% de las
 * Borrador existentes) aplicadas sobre el total acumulado.
 *
 * @param {object} opciones
 * @param {string} opciones.syncId
 * @param {number} [opciones.hojasLeidas] si se omite, usa el ultimo valor
 *   informado por algun lote de este syncId.
 * @returns {Promise<{eliminadas:number, avisos:string[]}>}
 */
export async function finalizarImport(db, opciones = {}) {
  const { syncId } = opciones;
  if (!syncId) {
    throw new Error('finalizarImport requiere syncId');
  }

  const progreso = await db.prepare('SELECT * FROM import_lotes WHERE sync_id = ?').bind(syncId).first();
  if (!progreso) {
    throw new Error(`syncId "${syncId}" desconocido: no se registro ningun lote para finalizar`);
  }

  if (progreso.total_lotes == null || progreso.lotes_vistos < progreso.total_lotes) {
    throw new Error(
      `finalizar rechazado para syncId "${syncId}": llegaron ${progreso.lotes_vistos} de ` +
        `${progreso.total_lotes ?? 'un total desconocido de'} lotes anunciados. No se borra nada.`,
    );
  }

  const hojasLeidas = opciones.hojasLeidas ?? progreso.hojas_leidas ?? undefined;

  const { results: vistosRows } = await db
    .prepare('SELECT DISTINCT clave FROM import_vistos WHERE sync_id = ?')
    .bind(syncId)
    .all();
  const clavesVigentes = new Set(vistosRows.map((r) => r.clave));

  const avisos = [];
  let eliminadas = 0;

  // Nunca se borra a ciegas: la limpieza de obsoletas solo corre si el
  // acumulado de todos los lotes trajo al menos una clave y (cuando se
  // informa) si efectivamente se leyeron hojas. Un total vacio no es
  // evidencia de que todo desaparecio del Excel: suele ser un fallo de
  // extraccion/red aguas arriba (Apps Script o relay .NET).
  const sinSenalDeLectura = clavesVigentes.size === 0 || hojasLeidas === 0;

  if (sinSenalDeLectura) {
    avisos.push(
      'Limpieza de obsoletas omitida: el import no acumulo filas (o 0 hojas leidas). ' +
        'No se borra nada para evitar un vaciado accidental por una sincronizacion incompleta.',
    );
  } else {
    const { results: existentes } = await db
      .prepare("SELECT id, rut_norm, comuna_norm FROM peticiones WHERE oficina IS NULL OR oficina != 'MANUAL'")
      .all();

    const candidatas = existentes.filter((p) => !clavesVigentes.has(`${p.rut_norm}|${p.comuna_norm}`));
    const ratio = existentes.length > 0 ? candidatas.length / existentes.length : 0;

    if (existentes.length > 0 && ratio > UMBRAL_BORRADO_MASIVO) {
      avisos.push(
        `Limpieza de obsoletas omitida: se hubiera borrado ${candidatas.length} de ${existentes.length} ` +
          `peticiones (${Math.round(ratio * 100)}%), por encima del umbral de seguridad ` +
          `(${Math.round(UMBRAL_BORRADO_MASIVO * 100)}%). Revisar el origen del import antes de reintentar.`,
      );
    } else {
      for (const p of candidatas) {
        await db.prepare('DELETE FROM peticiones WHERE id = ?').bind(p.id).run();
        eliminadas++;
      }
    }
  }

  await db.prepare('DELETE FROM import_vistos WHERE sync_id = ?').bind(syncId).run();
  await db.prepare('DELETE FROM import_lotes WHERE sync_id = ?').bind(syncId).run();

  return { eliminadas, avisos };
}
