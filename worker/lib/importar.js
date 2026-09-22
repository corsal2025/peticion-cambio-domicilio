// Import (Apps Script -> /api/import): upsert idempotente por clave natural
// (rut, comuna) via peticiones.js, y limpieza de obsoletas: cualquier
// peticion de origen Excel (oficina != MANUAL) que ya no aparece en la
// sincronizacion actual se elimina. Las filas Oficina=MANUAL nunca se tocan.
import { fold } from './normalizar.js';
import { upsertPeticion } from './peticiones.js';

const MAX_FILAS = 5000;

function rutNorm(rut) {
  return String(rut ?? '')
    .toUpperCase()
    .replace(/[^0-9K]/g, '');
}

/**
 * @returns {Promise<{recibidas:number, insertadas:number, actualizadas:number, eliminadas:number}>}
 */
export async function importarFilas(db, filas) {
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

  const { results: existentes } = await db
    .prepare("SELECT id, rut_norm, comuna_norm FROM peticiones WHERE oficina IS NULL OR oficina != 'MANUAL'")
    .all();

  let eliminadas = 0;
  for (const p of existentes) {
    const clave = `${p.rut_norm}|${p.comuna_norm}`;
    if (!clavesVigentes.has(clave)) {
      await db.prepare('DELETE FROM peticiones WHERE id = ?').bind(p.id).run();
      eliminadas++;
    }
  }

  return { recibidas: filas.length, insertadas, actualizadas, eliminadas };
}
