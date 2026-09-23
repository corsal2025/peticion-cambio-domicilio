/**
 * Sincronizacion Drive -> Worker Cloudflare.
 *
 * Lee el libro "DETALLE CARPETAS" (bound a esta planilla o referenciado por
 * PropertiesService.SPREADSHEET_ID), recorre cada hoja de agenda mensual, se
 * queda con las filas cuyo estado de carpeta es "CAMBIO DE DOMICILIO" o una
 * etapa posterior del mismo flujo (SOLICITADO / SUBIDA...) y las envia por
 * POST a /api/import del worker, autenticado con el header X-Import-Secret.
 *
 * Es un port 1:1 (en lo que aplica) de
 * PeticionCambioDomicilio.Excel.ExcelPeticionImporter (ver ese archivo para
 * el detalle de las reglas de negocio).
 *
 * Configuracion via Project Settings > Script properties:
 *   WORKER_URL     -> ej. https://peticion-cambio-domicilio.pages.dev
 *   IMPORT_SECRET  -> mismo valor que el secret IMPORT_SECRET del worker
 *   SPREADSHEET_ID -> opcional; vacio = usa SpreadsheetApp.getActive()
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
  MAX_FILAS_POR_LOTE: 500,
  FILAS_MAX_ENCABEZADO: 8,
};

// --------------------------------------------------------------------------
// Menu / trigger
// --------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Cambio de domicilio')
    .addItem('Sincronizar ahora', 'sincronizarAhora')
    .addToUi();
}

/** Instala el time trigger de sincronizacion automatica (correr una vez a mano). */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sincronizarAhora'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('sincronizarAhora')
    .timeBased()
    .everyMinutes(30)
    .create();
}

/** Entry point del menu y del trigger. */
function sincronizarAhora() {
  var resultado = sincronizar_();
  var ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    ui = null; // corriendo desde el trigger, sin UI
  }
  if (ui) {
    ui.alert(
      'Sincronizacion completa',
      'Hojas leidas: ' + resultado.hojasLeidas + '\n' +
        'Filas enviadas: ' + resultado.filas.length + '\n' +
        'Avisos: ' + resultado.avisos.length,
      ui.ButtonSet.OK,
    );
  }
  return resultado;
}

// --------------------------------------------------------------------------
// Nucleo
// --------------------------------------------------------------------------

function sincronizar_() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty('WORKER_URL');
  var importSecret = props.getProperty('IMPORT_SECRET');
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');

  if (!workerUrl || !importSecret) {
    throw new Error('Faltan WORKER_URL y/o IMPORT_SECRET en Script properties.');
  }

  var libro = spreadsheetId ? SpreadsheetApp.openById(spreadsheetId) : SpreadsheetApp.getActive();
  var extraido = extraerFilas_(libro);

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
    };
  }

  var lotes = partirEnLotes_(extraido.filas, CONFIG.MAX_FILAS_POR_LOTE);
  var recibidas = 0, insertadas = 0, actualizadas = 0, eliminadas = 0;

  for (var i = 0; i < lotes.length; i++) {
    var respuesta = enviarLote_(workerUrl, importSecret, lotes[i], extraido.hojasLeidas);
    recibidas += respuesta.recibidas || 0;
    insertadas += respuesta.insertadas || 0;
    actualizadas += respuesta.actualizadas || 0;
    eliminadas += respuesta.eliminadas || 0;
  }

  return {
    hojasLeidas: extraido.hojasLeidas,
    filas: extraido.filas,
    avisos: extraido.avisos,
    recibidas: recibidas,
    insertadas: insertadas,
    actualizadas: actualizadas,
    eliminadas: eliminadas,
  };
}

function partirEnLotes_(filas, tamano) {
  var lotes = [];
  for (var i = 0; i < filas.length; i += tamano) {
    lotes.push(filas.slice(i, i + tamano));
  }
  return lotes.length ? lotes : [[]];
}

function enviarLote_(workerUrl, importSecret, filas, hojasLeidas) {
  var url = workerUrl.replace(/\/+$/, '') + '/api/import';
  var respuesta = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Import-Secret': importSecret },
    payload: JSON.stringify({ filas: filas, hojasLeidas: hojasLeidas }),
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
 * Recorre todas las hojas del libro (salvo las ignoradas), ubica la fila de
 * encabezados y arma una fila de import por cada fila cuyo estado de carpeta
 * es "CAMBIO DE DOMICILIO" o una etapa posterior (rango >= 1).
 */
function extraerFilas_(libro) {
  var hojas = libro.getSheets();
  var ignoradas = CONFIG.HOJAS_IGNORADAS.map(fold_);
  var filas = [];
  var avisos = [];
  var hojasLeidas = 0;

  for (var h = 0; h < hojas.length; h++) {
    var hoja = hojas[h];
    var nombreHoja = hoja.getName();
    var nombreFolded = fold_(nombreHoja);
    if (ignoradas.some(function (ig) { return nombreFolded.indexOf(ig) !== -1; })) {
      continue;
    }

    var datos = hoja.getDataRange().getValues();
    if (!datos.length) {
      continue;
    }

    var encabezado = encontrarEncabezado_(datos);
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

    hojasLeidas++;
    var oficina = oficinaDeHoja_(nombreHoja);

    for (var r = encabezado.fila + 1; r < datos.length; r++) {
      var fila = datos[r];
      var rutRaw = String(fila[cRut] == null ? '' : fila[cRut]).trim();
      if (!rutRaw) {
        continue;
      }

      var estadoCrudo = String(fila[cEstado] == null ? '' : fila[cEstado]).trim();
      var rangoEstado = rangoEstadoCarpeta_(estadoCrudo);
      if (rangoEstado < 1) {
        continue; // fuera del flujo de cambio de domicilio
      }

      var nombre = cNombre >= 0 ? String(fila[cNombre] == null ? '' : fila[cNombre]).trim() : '';
      var comunaRaw = cComuna >= 0 ? String(fila[cComuna] == null ? '' : fila[cComuna]).trim() : '';
      var clases = cClases >= 0 ? String(fila[cClases] == null ? '' : fila[cClases]).trim() : '';
      var fechaSolicitud = cFecha >= 0 ? leerFecha_(fila[cFecha]) : null;
      var fechaSubida = cFechaSubida >= 0 ? leerFecha_(fila[cFechaSubida]) : null;

      var rutNormalizado = normalizeAndValidateRut_(rutRaw);

      filas.push({
        nombreCompleto: nombre || '(sin nombre)',
        rut: rutNormalizado || (rutRaw || 'SIN RUT'),
        comuna: comunaRaw || '(sin comuna)',
        clases: clases || null,
        fechaSolicitud: fechaSolicitud,
        oficina: oficina,
        origen: nombreHoja + '!fila ' + (r + 1),
        ordenImportacion: filas.length + 1,
        rutInvalido: !rutNormalizado,
        estadoCarpeta: estadoCrudo,
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
  if (f === '' || f === fold_(CONFIG.ESTADO_CAMBIO_DOMICILIO)) return 1;
  if (f === fold_('CAMBIO DE DOMICILIO SOLICITADO')) return 2;
  if (ESTADOS_FINALIZADOS.indexOf(f) !== -1) return 3;
  return 0;
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
