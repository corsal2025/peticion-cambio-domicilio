// Catalogo de estados de carpeta. Port 1:1 de
// PeticionCambioDomicilio.Domain.EstadoCarpetaCatalog.
import { fold } from './normalizar.js';

export const CAMBIO_DE_DOMICILIO = 'CAMBIO DE DOMICILIO';

export const VALORES = [
  'CAMBIO DE DOMICILIO',
  'CAMBIO DE DOMICILIO SOLICITADO',
  'CAMBIO DOM. SUBIDO A CONASET',
  'CAMBIO DOM. SUBIDO CON CORREO',
  'SUBIDA A CONASET',
  'SUBIDA CON F8',
  'SUBIDA CON OFICIO',
  'SE ENCUENTRA EN ARCHIVOS',
  'SE ENCUENTRA EN OF. 43',
  'NO EXISTE CARPETA',
  'CREAR OFICIO',
  'CREAR CERTIFICADO',
  'CANJE LIC. EXTRANJERA',
  '1° LICENCIA',
];

const FINALIZADOS = new Set([
  'CAMBIO DOM. SUBIDO A CONASET',
  'CAMBIO DOM. SUBIDO CON CORREO',
  'SUBIDA A CONASET',
  'SUBIDA CON F8',
  'SUBIDA CON OFICIO',
]);

export function esFinalizado(estado) {
  return FINALIZADOS.has(estado);
}

const SUBIDA_POR_COMUNA = new Set(['CAMBIO DOM. SUBIDO A CONASET', 'SUBIDA A CONASET']);
const SUBIDA_POR_NOSOTROS = new Set(['CAMBIO DOM. SUBIDO CON CORREO', 'SUBIDA CON F8', 'SUBIDA CON OFICIO']);

export function subidaPorComuna(estado) {
  return SUBIDA_POR_COMUNA.has(estado);
}

export function subidaPorNosotros(estado) {
  return SUBIDA_POR_NOSOTROS.has(estado);
}

/**
 * Etapa del flujo de cambio de domicilio: 0 = fuera del flujo, 1 = recien
 * llegada, 2 = solicitada a la comuna, 3 = subida a CONASET (cerrada). Solo
 * se aplica un estado que venga del Excel/import si su rango es mayor al
 * que ya tiene la peticion.
 */
export function rango(estadoCrudo) {
  const e = normalizar(estadoCrudo);
  if (e === 'CAMBIO DE DOMICILIO') return 1;
  if (e === 'CAMBIO DE DOMICILIO SOLICITADO') return 2;
  return esFinalizado(e) ? 3 : 0;
}

/**
 * Version SQL de `rango()`, para usar dentro de un UPDATE/UPSERT masivo
 * (ver worker/lib/importar.js) sin tener que traer cada fila a JS para
 * decidir si el estado_carpeta entrante avanza o no. Generada a partir de
 * las MISMAS constantes que `rango()` (VALORES/FINALIZADOS) para que ambas
 * nunca queden desincronizadas.
 *
 * @param {string} expr expresion SQL que evalua a un estado_carpeta ya
 *   normalizado (ej. `excluded.estado_carpeta` o `peticiones.estado_carpeta`).
 */
export function rangoSql(expr) {
  const partes = [`CASE ${expr}`, `WHEN '${escaparSql('CAMBIO DE DOMICILIO')}' THEN 1`, `WHEN '${escaparSql('CAMBIO DE DOMICILIO SOLICITADO')}' THEN 2`];
  for (const v of FINALIZADOS) {
    partes.push(`WHEN '${escaparSql(v)}' THEN 3`);
  }
  partes.push('ELSE 0 END');
  return partes.join(' ');
}

function escaparSql(v) {
  return v.replace(/'/g, "''");
}

export const SIN_SUBIR = 'CAMBIO DE DOMICILIO SOLICITADO';
export const SUBIDA_CONASET = 'CAMBIO DOM. SUBIDO A CONASET';
export const SUBIDA_CORREO = 'CAMBIO DOM. SUBIDO CON CORREO';

export const OPCIONES_DASHBOARD = [SIN_SUBIR, SUBIDA_CONASET, SUBIDA_CORREO];

/** Colapsa cualquier estado a una de las 3 opciones del dashboard. */
export function opcionDashboard(estado) {
  if (rango(estado) < 3) {
    return SIN_SUBIR;
  }
  return subidaPorComuna(estado) ? SUBIDA_CONASET : SUBIDA_CORREO;
}

const VARIANTES_TIPEO = {
  'se encuentra en of 43': 'SE ENCUENTRA EN OF. 43',
  'se encuentra en of43': 'SE ENCUENTRA EN OF. 43',
  'cambio dom subido a conaset': 'CAMBIO DOM. SUBIDO A CONASET',
  'cambio de dom subido con correo': 'CAMBIO DOM. SUBIDO CON CORREO',
};

/** Normaliza un valor crudo (del Excel/import o UI) al valor canonico del catalogo. */
export function normalizar(crudo) {
  const f = fold(crudo);
  for (const v of VALORES) {
    if (fold(v) === f) {
      return v;
    }
  }

  if (f in VARIANTES_TIPEO) {
    return VARIANTES_TIPEO[f];
  }

  if (f === '') {
    return CAMBIO_DE_DOMICILIO;
  }

  return crudo != null ? String(crudo).trim().toUpperCase() : CAMBIO_DE_DOMICILIO;
}
