/**
 * Sincronizacion Drive -> Worker Cloudflare.
 *
 * Script STANDALONE (no bound a ninguna planilla). El archivo real,
 * "DETALLE CARPETAS DEPTO. LICENCIAS DE CONDUCIR 2026.xlsx", es un .xlsx
 * (no un Google Sheet nativo) que vive en una carpeta de Drive compartido, y
 * SpreadsheetApp no puede abrir un .xlsx directamente. Por eso cada
 * sincronizacion: (1) usa el servicio avanzado de Drive (v3) para copiar el
 * .xlsx convirtiendolo a Google Sheet nativo (application/vnd.google-apps.
 * spreadsheet) en el Drive del dueno del script, (2) abre esa copia con
 * SpreadsheetApp.openById, (3) recorre cada hoja de agenda mensual, se queda
 * con las filas cuyo estado de carpeta es "CAMBIO DE DOMICILIO" o una etapa
 * posterior del mismo flujo (SOLICITADO / SUBIDA...) y las envia por POST a
 * /api/import del worker, autenticado con el header X-Import-Secret, y (4)
 * SIEMPRE borra (trashea) la copia temporal en un bloque finally, se haya
 * o no completado el envio.
 *
 * Es un port 1:1 (en lo que aplica) de
 * PeticionCambioDomicilio.Excel.ExcelPeticionImporter (ver ese archivo para
 * el detalle de las reglas de negocio).
 *
 * Configuracion via Project Settings > Script properties (o correr
 * `configurar()` una vez si existe apps-script/Config.gs, ver
 * Config.example.gs):
 *   WORKER_URL     -> ej. https://peticion-cambio-domicilio.pages.dev
 *   IMPORT_SECRET  -> mismo valor que el secret IMPORT_SECRET del worker
 *   XLSX_FILE_ID   -> id del archivo .xlsx en Drive (ver DEPLOY-CLOUDFLARE.md
 *                     seccion 6 para como obtenerlo)
 *   SPREADSHEET_ID -> opcional; alternativa a XLSX_FILE_ID si el usuario ya
 *                     convirtio el libro a Google Sheet nativo a mano. Si
 *                     esta seteada, tiene prioridad sobre XLSX_FILE_ID y NO
 *                     pasa por el paso de copiar/trashear.
 *
 * Requiere el servicio avanzado "Drive" (v3) habilitado en appsscript.json
 * (dependencies.enabledAdvancedServices) para poder copiar/trashear el
 * .xlsx.
 */

var CONFIG = {
  HOJAS_IGNORADAS: [
    'plantilla',
    'hoja estadisticas',
    'correos cambio de domiclio',
    'correos cambio de domicilio',
  ],
  ESTADO_CAMBIO_DOMICILIO: 'CAMBIO DE DOMICILIO',
  COLUMNAS: {
    nombreCompleto: 'NOMBRE COMPLETO',
    rut: 'RUT',
    estadoCarpeta: 'ESTADO DE LA CARPETA',
    comunaOrigen: 'FECHA ULTIMA CARPETA',
    fechaSolicitud: 'FECHA DE LA CITACION',
    fechaSubidaCarpeta: 'FECHA CUANDO SE SUBIO LA CARPETA',
    clases: 'CLASES',
  },
  // Cloudflare Workers FREE plan: 50 subrequests por invocacion. El worker
  // procesa cada lote set-based (pocos D1 calls, no uno por fila), pero un
  // lote mas chico reduce igual el tamaño del payload/JSON bindeado por
  // statement y el tiempo de una sola invocacion. Bajado de 500 a 200.
  MAX_FILAS_POR_LOTE: 200,
  MAX_CONTACTOS_POR_LOTE: 200,
  FILAS_MAX_ENCABEZADO: 8,
};

// --------------------------------------------------------------------------
// Configuracion / trigger
// --------------------------------------------------------------------------
//
// Nota: este es un script STANDALONE (no bound a una planilla), asi que NO
// tiene onOpen()/menu de UI: no hay una planilla que lo abra. Se opera desde
// el propio editor de Apps Script (ver DEPLOY-CLOUDFLARE.md seccion 6):
// correr configurar() (si hay Config.gs) o cargar las Script Properties a
// mano, despues installTrigger() una vez, y sincronizarAhora() para forzar
// una corrida manual.

/**
 * Escribe WORKER_URL / IMPORT_SECRET / XLSX_FILE_ID en Script Properties a
 * partir de CONFIG_() (definida en el archivo gitignorado apps-script/Config.gs;
 * copiar desde Config.example.gs). Permite que `clasp push` entregue secrets
 * sin comitearlos. Correr una vez a mano desde el editor despues de cada push
 * (o cada vez que cambien los valores).
 */
function configurar() {
  if (typeof CONFIG_ !== 'function') {
    throw new Error('Falta apps-script/Config.gs (copiar desde Config.example.gs y completar los valores, despues clasp push).');
  }
  var valores = CONFIG_();
  var props = PropertiesService.getScriptProperties();
  var escritas = [];
  ['WORKER_URL', 'IMPORT_SECRET', 'XLSX_FILE_ID'].forEach(function (clave) {
    if (valores[clave]) {
      props.setProperty(clave, valores[clave]);
      escritas.push(clave);
    }
  });
  Logger.log('OK: Script properties actualizadas (' + escritas.join(', ') + ').');
}

/** Instala el time trigger de sincronizacion automatica (correr una vez a mano). */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sincronizarProgramada'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('sincronizarProgramada')
    .timeBased()
    .everyMinutes(15)
    .create();
}

/**
 * Entry point manual (correr a mano desde el editor de Apps Script). Siempre
 * fuerza la sincronizacion completa, aunque el .xlsx no haya cambiado desde
 * la ultima corrida (asi sirve para probar cambios recien hechos en el
 * Excel o en la configuracion sin esperar al proximo modifiedTime).
 */
function sincronizarAhora() {
  var resultado = sincronizar_(true);
  var ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    ui = null; // script standalone: no hay UI de planilla disponible
  }
  if (ui) {
    ui.alert(
      'Sincronizacion completa',
      'Hojas leidas: ' + resultado.hojasLeidas + '\n' +
        'Filas enviadas: ' + resultado.filas.length + '\n' +
        'Correos de comunas nuevos/actualizados: ' + resultado.comunasNuevos + '/' + resultado.comunasActualizados + '\n' +
        'Avisos: ' + resultado.avisos.length,
      ui.ButtonSet.OK,
    );
  }
  return resultado;
}

/**
 * Entry point del trigger de tiempo (ver installTrigger). NO fuerza: si el
 * .xlsx no cambio desde la ultima sincronizacion exitosa, se omite para
 * ahorrar cuota de Drive/UrlFetch. Usa el mismo LockService que doPost para
 * que una corrida disparada a mano desde el dashboard ("Sincronizar ahora")
 * nunca se superponga con el trigger de 15 minutos.
 */
function sincronizarProgramada() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('sincronizarProgramada: ya hay una sincronizacion en curso, se omite esta corrida.');
    return { omitido: true, avisos: ['Ya habia una sincronizacion en curso.'] };
  }
  try {
    return sincronizar_(false);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Web app (deploy > Implementar > Aplicacion web). Entry point HTTP que usa
 * el worker (POST /api/sincronizar, boton "Sincronizar ahora" del dashboard)
 * para forzar una sincronizacion bajo demanda sin esperar el trigger de 15
 * minutos. Autenticado por el mismo IMPORT_SECRET que ya usan /api/import y
 * /api/comunas/sync (Script Properties), NO por sesion/OAuth de usuario.
 * Usa el mismo LockService que sincronizarProgramada para no correr en
 * paralelo con el trigger de tiempo.
 */
function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var secretoEsperado = props.getProperty('IMPORT_SECRET');

  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOutput_({ ok: false, error: 'JSON invalido' });
  }

  var secretoRecibido = String((body && body.secret) || '');
  if (!secretoEsperado || !secretosIguales_(secretoRecibido, secretoEsperado)) {
    return jsonOutput_({ ok: false, error: 'no autorizado' });
  }

  // accion: paridad con los dos botones del dashboard ("Cargar cambios de
  // domicilio" -> 'cargar', "Actualizar estado solicitud" -> 'actualizar').
  // Cualquier otro valor (u omitido, ej. el trigger de tiempo llamando esto
  // via sincronizarProgramada) hace la corrida completa de siempre.
  var accion = (body && body.accion) === 'cargar' || (body && body.accion) === 'actualizar' ? body.accion : undefined;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    return jsonOutput_({ ok: false, error: 'ya hay una sincronizacion en curso' });
  }

  try {
    var resultado = sincronizar_(true, accion);
    return jsonOutput_({ ok: true, resumen: resultado });
  } catch (err) {
    return jsonOutput_({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput_(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}

/** Comparacion de secretos "tiempo casi constante": recorre el largo mayor sin cortar antes por longitud distinta. */
function secretosIguales_(a, b) {
  var largo = Math.max(a.length, b.length);
  var dif = a.length === b.length ? 0 : 1;
  for (var i = 0; i < largo; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    dif |= ca ^ cb;
  }
  return dif === 0;
}

// --------------------------------------------------------------------------
// Nucleo
// --------------------------------------------------------------------------

/**
 * Resuelve la fuente (xlsx a copiar/trashear, o Google Sheet ya nativo via
 * SPREADSHEET_ID), aplica el chequeo de "sin cambios" cuando corresponde y
 * delega la extraccion/envio real a sincronizarLibro_.
 *
 * @param {boolean} forzar Si es true, ignora el chequeo de modifiedTime sin
 *   cambios (usado por sincronizarAhora). El trigger programado pasa false.
 * @param {'cargar'|'actualizar'|undefined} accion filtra que filas se
 *   procesan (ver doPost); undefined = corrida completa (cargar + actualizar).
 */
function sincronizar_(forzar, accion) {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty('WORKER_URL');
  var importSecret = props.getProperty('IMPORT_SECRET');
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  var xlsxFileId = props.getProperty('XLSX_FILE_ID');

  if (!workerUrl || !importSecret) {
    throw new Error('Faltan WORKER_URL y/o IMPORT_SECRET en Script properties.');
  }
  if (!spreadsheetId && !xlsxFileId) {
    throw new Error('Falta XLSX_FILE_ID (o SPREADSHEET_ID) en Script properties.');
  }

  // Camino manual: el usuario ya convirtio el .xlsx a Google Sheet nativo y
  // dejo el id en SPREADSHEET_ID. No hay copia que trashear ni modifiedTime
  // que chequear (el propio Sheet ya es la fuente).
  if (spreadsheetId) {
    var libroNativo = SpreadsheetApp.openById(spreadsheetId);
    return sincronizarLibro_(workerUrl, importSecret, libroNativo, accion);
  }

  // Camino standalone (default): XLSX_FILE_ID apunta al .xlsx real en el
  // Drive compartido. SpreadsheetApp no puede abrirlo directo, asi que se
  // copia convirtiendolo a Google Sheet con el servicio avanzado de Drive
  // (v3), se procesa la copia y SIEMPRE se trashea al final.
  var metadata = Drive.Files.get(xlsxFileId, {
    fields: 'modifiedTime,name',
    supportsAllDrives: true,
  });
  var modifiedTime = metadata.modifiedTime;
  var ultimoSincronizado = props.getProperty('XLSX_LAST_SYNCED_MODIFIED');

  if (!forzar && ultimoSincronizado && ultimoSincronizado === modifiedTime) {
    return {
      hojasLeidas: 0,
      filas: [],
      avisos: ['Sin cambios en el xlsx desde la ultima sincronizacion (modifiedTime ' + modifiedTime + '); se omite para ahorrar cuota.'],
      recibidas: 0,
      insertadas: 0,
      actualizadas: 0,
      eliminadas: 0,
      comunasNuevos: 0,
      comunasActualizados: 0,
      omitido: true,
    };
  }

  var copia = Drive.Files.copy(
    {
      name: 'TEMP sync - ' + metadata.name + ' - ' + new Date().toISOString(),
      mimeType: 'application/vnd.google-apps.spreadsheet',
    },
    xlsxFileId,
    { supportsAllDrives: true },
  );
  var tempFileId = copia.id;

  try {
    var libroTemporal = SpreadsheetApp.openById(tempFileId);
    var resultado = sincronizarLibro_(workerUrl, importSecret, libroTemporal, accion);
    props.setProperty('XLSX_LAST_SYNCED_MODIFIED', modifiedTime);
    return resultado;
  } finally {
    // SIEMPRE trashear la copia temporal, haya o no completado el envio, para
    // no acumular archivos huerfanos en el Drive del dueno del script.
    try {
      Drive.Files.update({ trashed: true }, tempFileId, null, { supportsAllDrives: true });
    } catch (e) {
      Logger.log('No se pudo trashear la copia temporal ' + tempFileId + ': ' + e.message);
    }
  }
}

/**
 * Extrae filas y sincroniza comunas contra un libro ya abierto (nativo Google
 * Sheet: copia temporal del xlsx, o el SPREADSHEET_ID manual) y las envia al
 * worker. Es el mismo cuerpo que antes tenia sincronizar_() cuando el script
 * era bound a la planilla.
 *
 * @param {'cargar'|'actualizar'|undefined} accion ver extraerFilas_.
 */
function sincronizarLibro_(workerUrl, importSecret, libro, accion) {
  var extraido = extraerFilas_(libro, accion);

  // Sincroniza el directorio de correos de comunas (hoja "CORREOS CAMBIO DE
  // DOMICLIO") en la MISMA corrida. A diferencia del sync de peticiones, este
  // nunca borra (POST /api/comunas/sync solo hace upsert), asi que se corre
  // siempre, incluso si el chequeo de "0 hojas leidas" de abajo aborta el
  // envio de peticiones.
  var comunasResumen = sincronizarContactosComunas_(workerUrl, importSecret, libro, extraido.avisos);

  // Red de seguridad: si no se leyo ninguna hoja (libro vacio, permisos,
  // cambio de estructura, etc.) no se manda NADA al worker. Un POST con 0
  // hojas leidas no es evidencia de que las peticiones desaparecieron del
  // Excel, y el worker interpretaria un payload vacio como "hay que
  // limpiar" si no se informa hojasLeidas.
  if (extraido.hojasLeidas === 0) {
    extraido.avisos.push('Sincronizacion abortada: 0 hojas leidas, no se envia nada al worker.');
    return {
      hojasLeidas: extraido.hojasLeidas,
      filas: extraido.filas,
      avisos: extraido.avisos,
      recibidas: 0,
      insertadas: 0,
      actualizadas: 0,
      eliminadas: 0,
      comunasNuevos: comunasResumen.nuevos,
      comunasActualizados: comunasResumen.actualizados,
    };
  }

  var lotes = partirEnLotes_(extraido.filas, CONFIG.MAX_FILAS_POR_LOTE);
  var recibidas = 0, insertadas = 0, actualizadas = 0;
  var clavesCD = [];

  // Cada lote SOLO hace upsert (el worker nunca borra dentro de /api/import).
  // El libro real tiene miles de filas relevantes, asi que casi siempre hay
  // mas de un lote; la limpieza de obsoletas se decide una unica vez al
  // final, con el acumulado de las claves CD de TODOS los lotes. Ese
  // acumulado viaja en memoria aca (nunca se persiste lote a lote en el
  // worker: ver worker/lib/importar.js), y si un enviarLote_ falla, esta
  // funcion lanza y finalizarImport_ NUNCA se llama, asi que el worker no
  // necesita rastrear "cuantos lotes llegaron" por su cuenta.
  for (var i = 0; i < lotes.length; i++) {
    var respuesta = enviarLote_(workerUrl, importSecret, { filas: lotes[i] });
    recibidas += respuesta.recibidas || 0;
    insertadas += respuesta.insertadas || 0;
    actualizadas += respuesta.actualizadas || 0;
    if (respuesta.clavesCD && respuesta.clavesCD.length) {
      clavesCD = clavesCD.concat(respuesta.clavesCD);
    }
  }

  var final = finalizarImport_(workerUrl, importSecret, {
    clavesCD: clavesCD,
    hojasLeidas: extraido.hojasLeidas,
    recibidas: recibidas,
    insertadas: insertadas,
    actualizadas: actualizadas,
  });
  if (final.error) {
    extraido.avisos.push('Finalizar import fallo: ' + final.error);
  } else if (final.avisos && final.avisos.length) {
    extraido.avisos = extraido.avisos.concat(final.avisos);
  }

  return {
    hojasLeidas: extraido.hojasLeidas,
    filas: extraido.filas,
    avisos: extraido.avisos,
    recibidas: recibidas,
    insertadas: insertadas,
    actualizadas: actualizadas,
    eliminadas: final.eliminadas || 0,
    comunasNuevos: comunasResumen.nuevos,
    comunasActualizados: comunasResumen.actualizados,
  };
}

/**
 * Sincroniza el directorio de correos de comunas: busca la hoja cuyo nombre
 * contiene "correos cambio de dom" (columnas Municipio / Correo; el
 * municipio a veces viene con prefijo "MUNICIP/") y hace POST a
 * /api/comunas/sync, autenticado con el mismo IMPORT_SECRET que /api/import.
 * Es un port 1:1 de la lectura de
 * PeticionCambioDomicilio.Comunas.ComunaDirectory.ImportFromWorkbook. Nunca
 * lanza: cualquier error queda como aviso en `avisos` para no frenar el sync
 * de peticiones.
 */
function sincronizarContactosComunas_(workerUrl, importSecret, libro, avisos) {
  try {
    var hoja = null;
    var hojas = libro.getSheets();
    for (var h = 0; h < hojas.length; h++) {
      if (fold_(hojas[h].getName()).indexOf('correos cambio de dom') !== -1) {
        hoja = hojas[h];
        break;
      }
    }
    if (!hoja) {
      avisos.push('No se encontro la hoja de correos de comunas ("CORREOS CAMBIO DE DOMICLIO"); no se sincronizaron contactos.');
      return { nuevos: 0, actualizados: 0 };
    }

    var datos = hoja.getDataRange().getValues();
    var contactos = [];
    for (var r = 0; r < datos.length; r++) {
      var muni = String(datos[r][0] == null ? '' : datos[r][0]).trim();
      var mail = String(datos[r][1] == null ? '' : datos[r][1]).trim();
      if (!muni || !mail) continue;
      if (fold_(muni) === 'municipio' || mail.indexOf('@') === -1) continue;
      contactos.push({ comuna: stripMuniPrefix_(muni), email: mail });
    }

    if (contactos.length === 0) {
      avisos.push('La hoja de correos de comunas no tiene contactos validos; no se envio nada a /api/comunas/sync.');
      return { nuevos: 0, actualizados: 0 };
    }

    // Igual que /api/import: se reparte en lotes chicos (payload/tamaño de
    // statement bindeado), aunque el worker ya procesa cada request set-based.
    var lotesContactos = partirEnLotes_(contactos, CONFIG.MAX_CONTACTOS_POR_LOTE);
    var totalNuevos = 0;
    var totalActualizados = 0;

    for (var i = 0; i < lotesContactos.length; i++) {
      var url = workerUrl.replace(/\/+$/, '') + '/api/comunas/sync';
      var respuesta = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Import-Secret': importSecret },
        payload: JSON.stringify({ contactos: lotesContactos[i] }),
        muteHttpExceptions: true,
      });

      var codigo = respuesta.getResponseCode();
      var cuerpo = respuesta.getContentText();
      if (codigo < 200 || codigo >= 300) {
        avisos.push('POST /api/comunas/sync fallo (' + codigo + '): ' + cuerpo);
        continue;
      }

      var parsed = JSON.parse(cuerpo);
      totalNuevos += parsed.nuevos || 0;
      totalActualizados += parsed.actualizados || 0;
    }

    return { nuevos: totalNuevos, actualizados: totalActualizados };
  } catch (e) {
    avisos.push('Sincronizacion de correos de comunas fallo: ' + e.message);
    return { nuevos: 0, actualizados: 0 };
  }
}

/** Quita el prefijo "MUNICIP/" (o similar) de un nombre de municipio: todo antes del primer "/" si aparece dentro de los primeros 12 caracteres. */
function stripMuniPrefix_(raw) {
  var value = String(raw).trim();
  var slash = value.indexOf('/');
  if (slash >= 0 && slash < 12) {
    value = value.substring(slash + 1);
  }
  return value.trim().toUpperCase();
}

function partirEnLotes_(filas, tamano) {
  var lotes = [];
  for (var i = 0; i < filas.length; i += tamano) {
    lotes.push(filas.slice(i, i + tamano));
  }
  return lotes.length ? lotes : [[]];
}

function enviarLote_(workerUrl, importSecret, payload) {
  var url = workerUrl.replace(/\/+$/, '') + '/api/import';
  var respuesta = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Import-Secret': importSecret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var codigo = respuesta.getResponseCode();
  var cuerpo = respuesta.getContentText();
  if (codigo < 200 || codigo >= 300) {
    throw new Error('POST /api/import fallo (' + codigo + '): ' + cuerpo);
  }

  return JSON.parse(cuerpo);
}

/**
 * Cierra la sincronizacion: recien aca el worker decide si limpia obsoletas,
 * usando el acumulado de claves CD de todos los lotes enviados. Se llama
 * SIEMPRE despues de mandar todos los lotes (incluso si hubo 1 solo lote), y
 * NUNCA si algun enviarLote_ fallo antes (lanza y corta el flujo).
 */
function finalizarImport_(workerUrl, importSecret, datos) {
  var url = workerUrl.replace(/\/+$/, '') + '/api/import/finalizar';
  var respuesta = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Import-Secret': importSecret },
    payload: JSON.stringify(datos),
    muteHttpExceptions: true,
  });

  var codigo = respuesta.getResponseCode();
  var cuerpo = respuesta.getContentText();
  var parsed;
  try {
    parsed = JSON.parse(cuerpo);
  } catch (e) {
    parsed = {};
  }
  if (codigo < 200 || codigo >= 300) {
    return { error: (parsed && parsed.error) || ('codigo ' + codigo + ': ' + cuerpo), eliminadas: 0, avisos: [] };
  }

  return parsed;
}

/**
 * Recorre todas las hojas del libro (salvo las ignoradas), ubica la fila de
 * encabezados y arma una fila de import por cada fila cuyo estado de carpeta
 * es "CAMBIO DE DOMICILIO" o una etapa posterior (rango >= 1).
 *
 * @param {'cargar'|'actualizar'|undefined} accion cuando se especifica, filtra
 *   Y evita construir filas fuera de ese flujo: 'cargar' SOLO procesa filas
 *   exactamente "CAMBIO DE DOMICILIO" (rango 1); 'actualizar' SOLO procesa
 *   filas en etapa posterior (rango >= 2, las que pueden avanzar una peticion
 *   ya existente). undefined (corrida completa/trigger) procesa ambas, igual
 *   que antes.
 *
 * Lectura (Sheets API es la parte lenta de la sincronizacion, no el JS): por
 * hoja se hacen a lo sumo 2 llamadas .getValues() en vez de leer celda por
 * celda: (1) una chica, SOLO las primeras FILAS_MAX_ENCABEZADO filas a ancho
 * completo, para ubicar la fila de encabezados y mapear columnas; (2) una vez
 * conocidas las columnas que realmente se necesitan (nombre/rut/estado/
 * comuna/fecha/clases), se lee el CUERPO de datos acotado a ese rango de
 * columnas (min..max de las necesarias), no a todo el ancho de la hoja — el
 * libro real tiene columnas de sobra que nunca se usan aca.
 */
function extraerFilas_(libro, accion) {
  var hojas = libro.getSheets();
  var ignoradas = CONFIG.HOJAS_IGNORADAS.map(fold_);
  var filas = [];
  var avisos = [];
  var hojasLeidas = 0;
  var soloCambioDomicilio = accion === 'cargar';
  var soloAvance = accion === 'actualizar';

  for (var h = 0; h < hojas.length; h++) {
    var hoja = hojas[h];
    var nombreHoja = hoja.getName();
    var nombreFolded = fold_(nombreHoja);
    if (ignoradas.some(function (ig) { return nombreFolded.indexOf(ig) !== -1; })) {
      continue;
    }

    var totalFilas = hoja.getLastRow();
    var totalCols = hoja.getLastColumn();
    if (totalFilas === 0 || totalCols === 0) {
      continue;
    }

    // (1) Encabezado: solo las primeras filas, ancho completo (no sabemos
    // todavia que columnas hacen falta).
    var filasEncabezado = Math.min(totalFilas, CONFIG.FILAS_MAX_ENCABEZADO);
    var datosEncabezado = hoja.getRange(1, 1, filasEncabezado, totalCols).getValues();

    var encabezado = encontrarEncabezado_(datosEncabezado);
    if (!encabezado) {
      avisos.push('Hoja "' + nombreHoja + '": no se encontro la fila de encabezados (con "RUT"), se omite.');
      continue;
    }

    var col = function (nombreColumna) {
      var f = fold_(nombreColumna);
      return Object.prototype.hasOwnProperty.call(encabezado.columnas, f) ? encabezado.columnas[f] : -1;
    };

    var cNombre = col(CONFIG.COLUMNAS.nombreCompleto);
    var cRut = col(CONFIG.COLUMNAS.rut);
    var cEstado = col(CONFIG.COLUMNAS.estadoCarpeta);
    var cComuna = col(CONFIG.COLUMNAS.comunaOrigen);
    var cFecha = col(CONFIG.COLUMNAS.fechaSolicitud);
    var cFechaSubida = col(CONFIG.COLUMNAS.fechaSubidaCarpeta);
    var cClases = col(CONFIG.COLUMNAS.clases);

    if (cEstado === -1) {
      var cDecision = col('DECISION FINAL');
      if (cDecision > 0) {
        cEstado = cDecision - 1;
        avisos.push('Hoja "' + nombreHoja + '": encabezado de "' + CONFIG.COLUMNAS.estadoCarpeta +
          '" no encontrado, se uso la columna junto a "DECISION FINAL".');
      }
    }

    if (cNombre === -1 || cRut === -1 || cEstado === -1 || cComuna === -1) {
      avisos.push('Hoja "' + nombreHoja + '": faltan columnas obligatorias, se omite.');
      continue;
    }

    if (totalFilas <= encabezado.fila + 1) {
      hojasLeidas++;
      continue; // hoja sin filas de datos debajo del encabezado
    }

    // (2) Cuerpo: SOLO las columnas necesarias (nunca celda por celda), y
    // SOLO las filas debajo del encabezado. Las columnas 0-based
    // (cNombre/cRut/etc, indices dentro de `datosEncabezado`) se recalculan
    // como offsets relativos a `colMin` porque `datosCuerpo` ya no arranca en
    // la columna 1 de la hoja sino en `colMin`.
    var indicesUsados = [cNombre, cRut, cEstado, cComuna, cFecha, cFechaSubida, cClases].filter(function (i) { return i >= 0; });
    var colMin = Math.min.apply(null, indicesUsados); // 0-based
    var colMax = Math.max.apply(null, indicesUsados); // 0-based
    var filaInicioCuerpo = encabezado.fila + 2; // 1-based, Sheets API
    var numFilasCuerpo = totalFilas - filaInicioCuerpo + 1;
    var datosCuerpo = hoja.getRange(filaInicioCuerpo, colMin + 1, numFilasCuerpo, colMax - colMin + 1).getValues();

    var rNombre = cNombre >= 0 ? cNombre - colMin : -1;
    var rRut = cRut - colMin;
    var rEstado = cEstado - colMin;
    var rComuna = cComuna >= 0 ? cComuna - colMin : -1;
    var rFecha = cFecha >= 0 ? cFecha - colMin : -1;
    var rFechaSubida = cFechaSubida >= 0 ? cFechaSubida - colMin : -1;
    var rClases = cClases >= 0 ? cClases - colMin : -1;

    hojasLeidas++;
    var oficina = oficinaDeHoja_(nombreHoja);

    for (var r = 0; r < datosCuerpo.length; r++) {
      var fila = datosCuerpo[r];
      var rutRaw = String(fila[rRut] == null ? '' : fila[rRut]).trim();
      if (!rutRaw) {
        continue;
      }

      var estadoCrudo = String(fila[rEstado] == null ? '' : fila[rEstado]).trim();
      var rangoEstado = rangoEstadoCarpeta_(estadoCrudo);
      if (rangoEstado < 1) {
        continue; // fuera del flujo de cambio de domicilio
      }
      // accion-based filtering: evita construir (y despues mandar/procesar en
      // el worker) filas que esta corrida ni siquiera va a usar.
      if (soloCambioDomicilio && rangoEstado !== 1) {
        continue;
      }
      if (soloAvance && rangoEstado < 2) {
        continue;
      }

      var nombre = rNombre >= 0 ? String(fila[rNombre] == null ? '' : fila[rNombre]).trim() : '';
      var comunaRaw = rComuna >= 0 ? String(fila[rComuna] == null ? '' : fila[rComuna]).trim() : '';
      var clases = rClases >= 0 ? String(fila[rClases] == null ? '' : fila[rClases]).trim() : '';
      var fechaSolicitud = rFecha >= 0 ? leerFecha_(fila[rFecha]) : null;
      var fechaSubida = rFechaSubida >= 0 ? leerFecha_(fila[rFechaSubida]) : null;

      var rutNormalizado = normalizeAndValidateRut_(rutRaw);

      filas.push({
        nombreCompleto: nombre || '(sin nombre)',
        rut: rutNormalizado || (rutRaw || 'SIN RUT'),
        comuna: comunaRaw || '(sin comuna)',
        clases: clases || null,
        fechaSolicitud: fechaSolicitud,
        oficina: oficina,
        origen: nombreHoja + '!fila ' + (filaInicioCuerpo + r),
        ordenImportacion: filas.length + 1,
        rutInvalido: !rutNormalizado,
        estadoCarpeta: estadoCrudo,
        esCambioDomicilio: esCambioDomicilio_(estadoCrudo),
        fechaSubidaCarpeta: fechaSubida,
      });
    }
  }

  return { hojasLeidas: hojasLeidas, filas: filas, avisos: avisos };
}

/** Busca, en las primeras FILAS_MAX_ENCABEZADO filas, la primera que contiene "RUT". */
function encontrarEncabezado_(datos) {
  var limite = Math.min(datos.length, CONFIG.FILAS_MAX_ENCABEZADO);
  for (var i = 0; i < limite; i++) {
    var fila = datos[i];
    var tieneRut = fila.some(function (c) { return fold_(c) === 'rut'; });
    if (!tieneRut) {
      continue;
    }

    var columnas = {};
    for (var c = 0; c < fila.length; c++) {
      var clave = fold_(fila[c]);
      if (clave && !Object.prototype.hasOwnProperty.call(columnas, clave)) {
        columnas[clave] = c;
      }
    }
    return { fila: i, columnas: columnas };
  }
  return null;
}

function oficinaDeHoja_(nombreHoja) {
  var f = fold_(nombreHoja);
  if (f.indexOf('argentina') !== -1) return 'AV. ARGENTINA';
  if (f.indexOf('placilla') !== -1) return 'PLACILLA';
  if (f.indexOf('merc') !== -1 || f.indexOf('puerto') !== -1) return 'MERC. PUERTO';
  return nombreHoja.trim().toUpperCase();
}

function leerFecha_(valor) {
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    return Utilities.formatDate(valor, 'America/Santiago', 'yyyy-MM-dd');
  }
  return null;
}

// --------------------------------------------------------------------------
// Catalogo de estados de carpeta (port de worker/lib/estadoCarpeta.js / rango)
// --------------------------------------------------------------------------

var ESTADOS_FINALIZADOS = [
  'cambio dom. subido a conaset',
  'cambio dom. subido con correo',
  'subida a conaset',
  'subida con f8',
  'subida con oficio',
];

function rangoEstadoCarpeta_(estadoCrudo) {
  var f = fold_(estadoCrudo);
  // IMPORTANTE: una celda de "estado" vacia NO es "CAMBIO DE DOMICILIO". El
  // Excel real tiene miles de filas con estado vacio que no pertenecen al
  // flujo (ver incidente 2026-09: 17k Borrador creadas de un sync con ~5
  // filas reales, la mayoria por celdas vacias tratadas como rango 1).
  if (f === '') return 0;
  if (f === fold_(CONFIG.ESTADO_CAMBIO_DOMICILIO)) return 1;
  if (f === fold_('CAMBIO DE DOMICILIO SOLICITADO')) return 2;
  if (ESTADOS_FINALIZADOS.indexOf(f) !== -1) return 3;
  return 0;
}

/** true solo si el estado crudo es EXACTAMENTE "CAMBIO DE DOMICILIO" (fold). Vacio NO cuenta. */
function esCambioDomicilio_(estadoCrudo) {
  return fold_(estadoCrudo) === fold_(CONFIG.ESTADO_CAMBIO_DOMICILIO);
}

// --------------------------------------------------------------------------
// Utilidades (port de worker/lib/normalizar.js y worker/lib/rut.js)
// --------------------------------------------------------------------------

/** Minusculas, sin tildes, espacios colapsados. */
function fold_(valor) {
  if (valor == null) return '';
  var texto = String(valor).trim();
  if (!texto) return '';
  var sinTildes = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC');
  return sinTildes.split(/\s+/).filter(function (s) { return s.length > 0; }).join(' ');
}

/** Port de RutValidator.NormalizeAndValidate (modulo 11). Retorna null si no es un RUT valido. */
function normalizeAndValidateRut_(rutCrudo) {
  if (rutCrudo == null) return null;

  var digitsAndK = '';
  var texto = String(rutCrudo);
  for (var i = 0; i < texto.length; i++) {
    var c = texto.charAt(i);
    if (/[0-9]/.test(c) || c === 'k' || c === 'K') {
      digitsAndK += c.toUpperCase();
    }
  }

  if (digitsAndK.length < 2) return null;

  var body = digitsAndK.slice(0, -1);
  var checkDigit = digitsAndK.slice(-1);

  if (body.length < 7 || body.length > 8 || !/^[0-9]+$/.test(body)) return null;
  if (calcularDigitoVerificador_(body) !== checkDigit) return null;

  if (body.length === 7) body = '0' + body;

  return formatearRut_(body, checkDigit);
}

function calcularDigitoVerificador_(body) {
  var suma = 0;
  var multiplicador = 2;
  for (var i = body.length - 1; i >= 0; i--) {
    suma += (body.charCodeAt(i) - 48) * multiplicador;
    multiplicador = multiplicador === 7 ? 2 : multiplicador + 1;
  }
  var resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

function formatearRut_(body, checkDigit) {
  var reversed = body.split('').reverse().join('');
  var grouped = '';
  for (var i = 0; i < reversed.length; i++) {
    if (i > 0 && i % 3 === 0) grouped += '.';
    grouped += reversed[i];
  }
  var formattedBody = grouped.split('').reverse().join('');
  return formattedBody + '-' + checkDigit;
}
