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
//
// IMPORTANTE (Cloudflare Workers FREE plan): 50 subrequests por invocacion, y
// D1 cuenta cada .run()/.first()/.all()/.batch() como un subrequest Y limita
// a 50 statements por invocacion (los statements dentro de un .batch()
// tambien cuentan). Un lote puede traer cientos de filas, asi que NUNCA se
// hace una consulta D1 por fila: todo el lote viaja como UN parametro JSON y
// se procesa dentro de SQLite via json_each() en un puñado de statements
// (partidos en varios chunks solo si el JSON supera ~90KB, el limite de
// tamano de un parametro bindeado en D1). Ver worker/lib/jsonChunk.js.
import { fold } from './normalizar.js';
import { normalizar as normalizarEstado, rango, rangoSql, CAMBIO_DE_DOMICILIO } from './estadoCarpeta.js';
import { chunkPorTamano } from './jsonChunk.js';
import { batch } from './db.js';

const MAX_FILAS = 5000;
// Si la limpieza de obsoletas borraria mas de este porcentaje de las peticiones
// Borrador no-manuales existentes, se omite: casi siempre es sintoma de un
// payload de import incompleto (hoja no leida, error de red, etc.), no de que
// realmente hayan desaparecido tantas filas del Excel de una sola vez.
const UMBRAL_BORRADO_MASIVO = 0.5;

// Guardia de seguridad: un sync legitimo trae, a lo sumo, un punado de altas
// nuevas por dia (personas que recien entran al flujo de cambio de domicilio).
// Si UN solo lote insertaria mas que esto, casi seguro es un bug de
// clasificacion aguas arriba (ver incidente 2026-09: 17234 Borrador creadas de
// un sync que debia crear ~5) y se rechaza entero, sin insertar nada, para
// que el operador revise antes de reintentar.
const MAX_ALTAS_POR_LOTE = 200;

const RANGO_ACTUAL_SQL = rangoSql('peticiones.estado_carpeta');

function rutNorm(rut) {
  return String(rut ?? '')
    .toUpperCase()
    .replace(/[^0-9K]/g, '');
}

function claveDeFila(fila) {
  return `${rutNorm(fila.rut)}|${fold(fila.comuna)}`;
}

/**
 * Rango del estado crudo SIN el fallback de `normalizar('') === 'CAMBIO DE
 * DOMICILIO'` (ese fallback existe para otros usos del catalogo, pero aqui
 * una celda vacia debe valer rango 0, nunca 1 — ver incidente 2026-09).
 */
function rangoDesdeCrudo(estadoCrudo) {
  if (fold(estadoCrudo) === '') return 0;
  return rango(estadoCrudo);
}

/**
 * Prepara una fila cruda del Excel/Apps Script para viajar dentro del JSON
 * del upsert masivo. NUNCA confia en flags que pudiera mandar el cliente
 * (Apps Script): `es_cd` y `rango` se recalculan aqui desde el estado crudo,
 * en paridad con ExcelPeticionImporter.cs ImportCore (esCambioDomicilio =
 * fold exacto contra "CAMBIO DE DOMICILIO"; vacio NO cuenta).
 */
function prepararFila(fila) {
  const rn = rutNorm(fila.rut);
  const cn = fold(fila.comuna);
  const estadoCrudo = fila.estadoCarpeta;
  const esCambioDomicilio = fold(estadoCrudo) === fold(CAMBIO_DE_DOMICILIO);
  return {
    rut_norm: rn,
    comuna_norm: cn,
    clave: `${rn}|${cn}`,
    nombre_completo: fila.nombreCompleto,
    rut: fila.rut,
    comuna: fila.comuna,
    clases: fila.clases ?? null,
    fecha_solicitud: fila.fechaSolicitud ?? null,
    oficina: fila.oficina ?? null,
    origen: fila.origen ?? null,
    orden_importacion: fila.ordenImportacion ?? 0,
    rut_invalido: fila.rutInvalido ? 1 : 0,
    estado_carpeta: normalizarEstado(estadoCrudo),
    fecha_subida_carpeta: fila.fechaSubidaCarpeta ?? null,
    es_cd: esCambioDomicilio ? 1 : 0,
    rango: esCambioDomicilio ? 1 : rangoDesdeCrudo(estadoCrudo),
  };
}

const UPSERT_SQL = `
  INSERT INTO peticiones
    (nombre_completo, rut, rut_norm, comuna, comuna_norm, clases, fecha_solicitud,
     oficina, origen, orden_importacion, rut_invalido, estado_carpeta)
  SELECT
    json_each.value ->> 'nombre_completo',
    json_each.value ->> 'rut',
    json_each.value ->> 'rut_norm',
    json_each.value ->> 'comuna',
    json_each.value ->> 'comuna_norm',
    json_each.value ->> 'clases',
    json_each.value ->> 'fecha_solicitud',
    json_each.value ->> 'oficina',
    json_each.value ->> 'origen',
    json_each.value ->> 'orden_importacion',
    json_each.value ->> 'rut_invalido',
    json_each.value ->> 'estado_carpeta'
  FROM json_each(?)
  -- El "WHERE 1=1" es necesario: sin el, la gramatica de SQLite confunde el
  -- "ON CONFLICT" de un INSERT...SELECT...FROM con una clausula ON de JOIN y
  -- tira "syntax error near DO" (verificado con node:sqlite 3.51 y es un
  -- comportamiento de la gramatica base de SQLite, no algo especifico de D1).
  WHERE 1 = 1
  ON CONFLICT (rut_norm, comuna_norm) DO UPDATE SET
    nombre_completo = excluded.nombre_completo,
    clases = excluded.clases,
    fecha_solicitud = excluded.fecha_solicitud,
    oficina = excluded.oficina,
    origen = excluded.origen,
    orden_importacion = excluded.orden_importacion,
    rut_invalido = excluded.rut_invalido,
    estado_carpeta = CASE
      WHEN ${rangoSql('excluded.estado_carpeta')} > ${RANGO_ACTUAL_SQL}
      THEN excluded.estado_carpeta ELSE peticiones.estado_carpeta END
`;

// Filas que NO son "CAMBIO DE DOMICILIO" exacto (es_cd = 0) pero traen rango
// >= 2 (ya solicitadas a la comuna o subidas a CONASET/F8/oficio/correo):
// paridad con ExcelPeticionImporter.cs ImportCore, estas filas SOLO pueden
// avanzar el estado_carpeta (y setear subida_en al llegar a rango 3) de una
// peticion YA EXISTENTE con la misma clave (rut_norm, comuna_norm). Nunca
// insertan: si no hay match, el UPDATE simplemente no toca ninguna fila.
const UPDATE_AVANCE_SQL = `
  UPDATE peticiones SET
    estado_carpeta = CASE
      WHEN ${rangoSql('t.estado_carpeta')} > ${RANGO_ACTUAL_SQL}
      THEN t.estado_carpeta ELSE peticiones.estado_carpeta END,
    subida_en = CASE
      WHEN ${rangoSql('t.estado_carpeta')} >= 3 AND ${rangoSql('t.estado_carpeta')} > ${RANGO_ACTUAL_SQL}
      THEN COALESCE(peticiones.subida_en, COALESCE(t.fecha_subida_carpeta, date('now')))
      ELSE peticiones.subida_en END
  FROM (
    SELECT
      json_each.value ->> 'rut_norm' AS rut_norm,
      json_each.value ->> 'comuna_norm' AS comuna_norm,
      json_each.value ->> 'estado_carpeta' AS estado_carpeta,
      json_each.value ->> 'fecha_subida_carpeta' AS fecha_subida_carpeta
    FROM json_each(?)
  ) AS t
  WHERE peticiones.rut_norm = t.rut_norm AND peticiones.comuna_norm = t.comuna_norm
`;

/**
 * Procesa UN lote del import: upsert idempotente de sus filas, set-based
 * (una consulta por chunk de tamano, nunca una consulta por fila). No
 * ejecuta limpieza de obsoletas (eso queda para finalizarImport, una vez que
 * se recibieron todos los lotes de la sincronizacion).
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

  const preparadas = filas.map(prepararFila);
  // Si la misma clave se repite dentro de un lote, se queda con la ultima
  // version (paridad con el comportamiento anterior: upserts secuenciales,
  // "el ultimo que escribe gana").
  const porClave = new Map();
  for (const p of preparadas) porClave.set(p.clave, p);

  // Paridad con ExcelPeticionImporter.cs ImportCore:
  //  - es_cd = 1 (estado crudo EXACTAMENTE "CAMBIO DE DOMICILIO"): upsert
  //    libre (crea o refresca), via UPSERT_SQL.
  //  - es_cd = 0 && rango >= 2: SOLO puede avanzar una peticion YA EXISTENTE
  //    con la misma clave; nunca crea. Via UPDATE_AVANCE_SQL.
  //  - es_cd = 0 && rango < 2: fuera del flujo, se descarta sin tocar nada
  //    (ni upsert, ni update, ni vistas).
  const filasCD = [];
  const filasAvance = [];
  for (const p of porClave.values()) {
    if (p.es_cd) {
      filasCD.push(p);
    } else if (p.rango >= 2) {
      filasAvance.push(p);
    }
  }

  // Claves que cuentan como "vigentes" para la limpieza de obsoletas de
  // finalizarImport: las CD (pueden crear) y las de avance (aunque solo
  // actualicen una existente). Registrar tambien las de avance es la opcion
  // mas simple y segura: como mucho evita un borrado de una peticion que
  // sigue viva en el Excel bajo otro estado, nunca causa un borrado indebido.
  const clavesVistas = [...new Set([...filasCD.map((p) => p.clave), ...filasAvance.map((p) => p.clave)])];

  let insertadas = 0;
  let actualizadas = 0;

  if (filasCD.length > 0) {
    const clavesCD = filasCD.map((p) => p.clave);
    const chunksClaves = chunkPorTamano(clavesCD);
    const existentes = new Set();
    for (const chunk of chunksClaves) {
      const { results } = await db
        .prepare(
          `SELECT rut_norm || '|' || comuna_norm AS clave FROM peticiones
           WHERE (rut_norm || '|' || comuna_norm) IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(chunk))
        .all();
      for (const r of results) existentes.add(r.clave);
    }

    const nuevasClaves = clavesCD.filter((c) => !existentes.has(c)).length;

    if (nuevasClaves > MAX_ALTAS_POR_LOTE) {
      throw new Error(
        `Lote rechazado: insertaria ${nuevasClaves} peticiones nuevas, por encima del limite de ` +
          `seguridad (${MAX_ALTAS_POR_LOTE}/lote). Un sync legitimo trae, a lo sumo, un punado de ` +
          `altas nuevas; revisar el origen del import antes de reintentar.`,
      );
    }

    insertadas = nuevasClaves;
    actualizadas += filasCD.length - insertadas;

    const chunksFilas = chunkPorTamano(filasCD);
    await batch(
      db,
      chunksFilas.map((chunk) => db.prepare(UPSERT_SQL).bind(JSON.stringify(chunk))),
    );
  }

  if (filasAvance.length > 0) {
    const chunksAvance = chunkPorTamano(filasAvance);
    const resultados = await batch(
      db,
      chunksAvance.map((chunk) => db.prepare(UPDATE_AVANCE_SQL).bind(JSON.stringify(chunk))),
    );
    for (const r of resultados) actualizadas += r.meta?.changes ?? 0;
  }

  const { syncId } = opciones;
  if (syncId) {
    if (clavesVistas.length > 0) {
      const chunksVistos = chunkPorTamano(clavesVistas);
      await batch(
        db,
        chunksVistos.map((chunk) =>
          db
            .prepare("INSERT OR IGNORE INTO import_vistos (sync_id, clave) SELECT ?, value FROM json_each(?)")
            .bind(syncId, JSON.stringify(chunk)),
        ),
      );
    }

    await db
      .prepare(
        `INSERT INTO import_lotes (sync_id, total_lotes, lotes_vistos, hojas_leidas)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (sync_id) DO UPDATE SET
           lotes_vistos = import_lotes.lotes_vistos + 1,
           total_lotes = COALESCE(excluded.total_lotes, import_lotes.total_lotes),
           hojas_leidas = COALESCE(excluded.hojas_leidas, import_lotes.hojas_leidas),
           actualizado_en = datetime('now')`,
      )
      .bind(syncId, opciones.totalLotes ?? null, opciones.hojasLeidas ?? null)
      .run();
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
 * Set-based: el conteo de "cuantas se borrarian" (para el umbral) y el borrado
 * en si se calculan con un puñado de statements, nunca cargando ni iterando
 * fila por fila en JS aunque existan miles de peticiones.
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

  // Un solo statement calcula, de una: cuantas claves vigentes se acumularon
  // para este syncId, cuantas peticiones Borrador-limpias no-manuales existen
  // (denominador del umbral) y cuantas de ellas son candidatas a borrado
  // (numerador). Evita cargar todas las filas a JS para poder contarlas.
  const conteo = await db
    .prepare(
      `SELECT
         (SELECT COUNT(DISTINCT clave) FROM import_vistos WHERE sync_id = ?) AS vigentes_n,
         COUNT(*) AS existentes_n,
         SUM(CASE WHEN (rut_norm || '|' || comuna_norm) NOT IN
           (SELECT clave FROM import_vistos WHERE sync_id = ?) THEN 1 ELSE 0 END) AS candidatas_n
       FROM peticiones
       WHERE (oficina IS NULL OR oficina != 'MANUAL') AND estado = 'Borrador' AND marcada = 0`,
    )
    .bind(syncId, syncId)
    .first();

  const vigentesN = conteo.vigentes_n ?? 0;
  const existentesN = conteo.existentes_n ?? 0;
  const candidatasN = conteo.candidatas_n ?? 0;

  const avisos = [];
  let eliminadas = 0;

  // Nunca se borra a ciegas: la limpieza de obsoletas solo corre si el
  // acumulado de todos los lotes trajo al menos una clave y (cuando se
  // informa) si efectivamente se leyeron hojas. Un total vacio no es
  // evidencia de que todo desaparecio del Excel: suele ser un fallo de
  // extraccion/red aguas arriba (Apps Script o relay .NET).
  const sinSenalDeLectura = vigentesN === 0 || hojasLeidas === 0;

  if (sinSenalDeLectura) {
    avisos.push(
      'Limpieza de obsoletas omitida: el import no acumulo filas (o 0 hojas leidas). ' +
        'No se borra nada para evitar un vaciado accidental por una sincronizacion incompleta.',
    );
  } else {
    // Paridad con ExcelPeticionImporter.cs (esBorradorLimpio): solo se
    // considera para borrado (y para el denominador del umbral) una peticion
    // Borrador, NO marcada y NO manual. Enviada/SinCorreoComuna/Error o
    // cualquier fila marcada nunca se tocan, aunque desaparezcan del Excel:
    // perderian su tracking de plazo legal o una accion pendiente del usuario.
    const ratio = existentesN > 0 ? candidatasN / existentesN : 0;

    if (existentesN > 0 && ratio > UMBRAL_BORRADO_MASIVO) {
      avisos.push(
        `Limpieza de obsoletas omitida: se hubiera borrado ${candidatasN} de ${existentesN} ` +
          `peticiones (${Math.round(ratio * 100)}%), por encima del umbral de seguridad ` +
          `(${Math.round(UMBRAL_BORRADO_MASIVO * 100)}%). Revisar el origen del import antes de reintentar.`,
      );
    } else if (candidatasN > 0) {
      const { meta } = await db
        .prepare(
          `DELETE FROM peticiones
           WHERE (oficina IS NULL OR oficina != 'MANUAL') AND estado = 'Borrador' AND marcada = 0
             AND (rut_norm || '|' || comuna_norm) NOT IN (SELECT clave FROM import_vistos WHERE sync_id = ?)`,
        )
        .bind(syncId)
        .run();
      eliminadas = meta.changes ?? 0;
    }
  }

  await batch(db, [
    db.prepare('DELETE FROM import_vistos WHERE sync_id = ?').bind(syncId),
    db.prepare('DELETE FROM import_lotes WHERE sync_id = ?').bind(syncId),
  ]);

  return { eliminadas, avisos };
}
