// Import (Apps Script -> /api/import): upsert idempotente por clave natural
// (rut, comuna) via peticiones.js, y limpieza de obsoletas: cualquier
// peticion de origen Excel (oficina != MANUAL) que ya no aparece en la
// sincronizacion actual se elimina. Las filas Oficina=MANUAL nunca se tocan.
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

/**
 * @param {object} [opciones]
 * @param {number} [opciones.hojasLeidas] cantidad de hojas efectivamente leidas
 *   en el origen (Apps Script/relay). Si viene en 0, se trata igual que un
 *   payload sin filas: no hay senal confiable de que algo realmente
 *   desaparecio, asi que no se ejecuta la limpieza de obsoletas.
 * @returns {Promise<{recibidas:number, insertadas:number, actualizadas:number, eliminadas:number, avisos:string[]}>}
 */
export async function importarFilas(db, filas, opciones = {}) {
  if (filas.length > MAX_FILAS) {
    throw new Error(`El import acepta maximo ${MAX_FILAS} filas (llegaron ${filas.length})`);
  }

  let insertadas = 0;
  let actualizadas = 0;
  const clavesVigentes = new Set();

  for (const fila of filas) {
    const { creada } = await upsertPeticion(db, fila);
    creada ? insertadas++ : actualizadas++;
    clavesVigentes.add(`${rutNorm(fila.rut)}|${fold(fila.comuna)}`);
  }

  const avisos = [];
  let eliminadas = 0;

  // Nunca se borra a ciegas: la limpieza de obsoletas solo corre si el import
  // trajo filas y (cuando se informa) si efectivamente se leyeron hojas. Un
  // payload vacio no es evidencia de que todo desaparecio del Excel: suele
  // ser un fallo de extraccion/red aguas arriba (Apps Script o relay .NET).
  const sinSenalDeLectura = filas.length === 0 || opciones.hojasLeidas === 0;

  if (sinSenalDeLectura) {
    avisos.push(
      'Limpieza de obsoletas omitida: el import no trajo filas (o 0 hojas leidas). ' +
        'No se borra nada para evitar un vaciado accidental por un payload incompleto.',
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

  return { recibidas: filas.length, insertadas, actualizadas, eliminadas, avisos };
}
