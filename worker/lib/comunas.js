// Directorio de comunas: CRUD + import CSV. Paridad con ComunaDirectory.cs
// (~498 filas nombre/correo). El nombre_norm (fold) es la clave de
// deduplicacion al importar: no se crean comunas repetidas por variaciones
// de mayusculas/tildes/espacios.
import { fold } from './normalizar.js';
import { chunkPorTamano } from './jsonChunk.js';
import { batch } from './db.js';

export async function crearComuna(db, datos) {
  const result = await db
    .prepare('INSERT INTO comunas (nombre, nombre_norm, correos, contacto, telefono) VALUES (?, ?, ?, ?, ?)')
    .bind(datos.nombre, fold(datos.nombre), datos.correos ?? null, datos.contacto ?? null, datos.telefono ?? null)
    .run();
  return { id: result.meta.last_row_id };
}

export async function listarComunas(db) {
  const { results } = await db.prepare('SELECT * FROM comunas ORDER BY nombre ASC').all();
  return results;
}

export async function actualizarComuna(db, id, datos) {
  const actual = await db.prepare('SELECT * FROM comunas WHERE id = ?').bind(id).first();
  if (!actual) {
    throw new Error(`Comuna ${id} no existe`);
  }
  const nombre = datos.nombre ?? actual.nombre;
  await db
    .prepare(
      "UPDATE comunas SET nombre = ?, nombre_norm = ?, correos = ?, contacto = ?, telefono = ?, actualizado_en = datetime('now') WHERE id = ?",
    )
    .bind(nombre, fold(nombre), datos.correos ?? actual.correos, datos.contacto ?? actual.contacto, datos.telefono ?? actual.telefono, id)
    .run();
}

export async function eliminarComuna(db, id) {
  await db.prepare('DELETE FROM comunas WHERE id = ?').bind(id).run();
}

/**
 * Parsea un CSV con columnas nombre/correo y hace upsert por nombre_norm:
 * si ya existe una comuna con ese nombre normalizado, actualiza su correo;
 * si no existe, la crea.
 */
export async function importarCsv(db, csvTexto) {
  const filas = parseCsv(csvTexto);
  let insertadas = 0;
  let actualizadas = 0;

  for (const fila of filas) {
    const nombre = fila.nombre?.trim();
    if (!nombre) continue;
    const norm = fold(nombre);

    const existente = await db.prepare('SELECT id FROM comunas WHERE nombre_norm = ?').bind(norm).first();
    if (existente) {
      await db
        .prepare("UPDATE comunas SET correos = ?, actualizado_en = datetime('now') WHERE id = ?")
        .bind(fila.correo ?? null, existente.id)
        .run();
      actualizadas++;
    } else {
      await db
        .prepare('INSERT INTO comunas (nombre, nombre_norm, correos) VALUES (?, ?, ?)')
        .bind(nombre, norm, fila.correo ?? null)
        .run();
      insertadas++;
    }
  }

  return { insertadas, actualizadas };
}

/**
 * Sincroniza contactos municipales (comuna, correo) recibidos desde Apps
 * Script (hoja "CORREOS CAMBIO DE DOMICLIO" del libro, ver
 * apps-script/Code.gs y src/PeticionCambioDomicilio/Comunas/ComunaDirectory.cs
 * ImportFromWorkbook, del que este es el port). Paridad de semantica con
 * ComunaDirectory.AddOrUpdate: upsert por (comuna normalizada, correo
 * exacto, case-insensitive) — si el par ya existe se cuenta como
 * "actualizado" sin tocar nada; si no existe se agrega (creando la comuna si
 * hace falta, o sumando el correo a la lista separada por comas de una
 * comuna ya existente). NUNCA borra: si un correo desaparece de la hoja en
 * una sincronizacion futura, sigue quedando en D1 hasta que un admin lo
 * elimine a mano desde /comunas.html.
 */
// IMPORTANTE (Cloudflare Workers FREE plan): igual que importar.js, nunca se
// hace una consulta D1 por contacto. Los ~300-500 contactos de una
// sincronizacion viajan en memoria (JS puro, sin costo de subrequests) y solo
// se hacen un puñado de statements: 1 (o varios chunks por tamano) para leer
// las comunas existentes que hagan falta, y hasta 2 mas para escribir
// (insertar comunas nuevas / actualizar correos de las existentes).
export async function sincronizarContactos(db, contactos) {
  const entradas = [];
  for (const contacto of contactos || []) {
    const comuna = String(contacto?.comuna ?? '').trim();
    const email = String(contacto?.email ?? '').trim();
    if (!comuna || !email || !email.includes('@')) continue;
    entradas.push({ comuna, email, norm: fold(comuna) });
  }

  const leidos = entradas.length;
  let nuevos = 0;
  let actualizados = 0;

  if (leidos === 0) {
    return { leidos: 0, nuevos: 0, actualizados: 0 };
  }

  const normsUnicos = [...new Set(entradas.map((e) => e.norm))];
  const existentesPorNorm = new Map();
  for (const chunk of chunkPorTamano(normsUnicos)) {
    const { results } = await db
      .prepare('SELECT id, nombre_norm, correos FROM comunas WHERE nombre_norm IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(chunk))
      .all();
    for (const row of results) existentesPorNorm.set(row.nombre_norm, row);
  }

  // Estado en memoria por comuna (norm): arranca desde lo que ya habia en D1
  // (si existia) y se va actualizando en JS a medida que se procesan las
  // entradas, exactamente igual que el loop secuencial original — la unica
  // diferencia es que la lectura/escritura a D1 es UNA vez al principio/final,
  // no una por contacto.
  const estado = new Map();
  for (const [norm, row] of existentesPorNorm) {
    estado.set(norm, {
      id: row.id,
      correosLista: (row.correos || '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean),
      cambiado: false,
    });
  }

  for (const { comuna, email, norm } of entradas) {
    let entry = estado.get(norm);
    if (!entry) {
      entry = { id: null, nombre: comuna.toUpperCase(), correosLista: [], cambiado: false };
      estado.set(norm, entry);
    }

    const yaExiste = entry.correosLista.some((e) => e.toLowerCase() === email.toLowerCase());
    if (yaExiste) {
      actualizados++;
      continue;
    }

    entry.correosLista.push(email);
    entry.cambiado = true;
    nuevos++;
  }

  const nuevasComunas = [];
  const comunasAActualizar = [];
  for (const [norm, entry] of estado) {
    if (entry.id == null) {
      nuevasComunas.push({ nombre: entry.nombre, nombre_norm: norm, correos: entry.correosLista.join(',') });
    } else if (entry.cambiado) {
      comunasAActualizar.push({ id: entry.id, correos: entry.correosLista.join(',') });
    }
  }

  if (nuevasComunas.length > 0) {
    await batch(
      db,
      chunkPorTamano(nuevasComunas).map((chunk) =>
        db
          .prepare(
            `INSERT INTO comunas (nombre, nombre_norm, correos)
             SELECT value ->> 'nombre', value ->> 'nombre_norm', value ->> 'correos'
             FROM json_each(?) WHERE 1 = 1`,
          )
          .bind(JSON.stringify(chunk)),
      ),
    );
  }

  if (comunasAActualizar.length > 0) {
    await batch(
      db,
      chunkPorTamano(comunasAActualizar).map((chunk) =>
        db
          .prepare(
            `UPDATE comunas SET correos = j.value ->> 'correos', actualizado_en = datetime('now')
             FROM json_each(?) AS j
             WHERE comunas.id = j.value ->> 'id'`,
          )
          .bind(JSON.stringify(chunk)),
      ),
    );
  }

  return { leidos, nuevos, actualizados };
}

function parseCsv(texto) {
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lineas.length === 0) return [];
  const cabecera = lineas[0].split(',').map((h) => h.trim().toLowerCase());
  const idxNombre = cabecera.indexOf('nombre');
  const idxCorreo = cabecera.indexOf('correo');

  return lineas.slice(1).map((linea) => {
    const cols = linea.split(',');
    return {
      nombre: idxNombre >= 0 ? cols[idxNombre]?.trim() : undefined,
      correo: idxCorreo >= 0 ? cols[idxCorreo]?.trim() : undefined,
    };
  });
}
