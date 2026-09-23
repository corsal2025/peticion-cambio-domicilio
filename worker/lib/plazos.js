// Plazo legal en dias habiles (lunes a viernes). Port 1:1 de
// PeticionCambioDomicilio.Domain.DeadlineCalculator / PlazoInfo.
//
// Paridad exacta con el .NET: los feriados chilenos NO se descuentan por
// defecto (el conteo queda ligeramente conservador en semanas con feriado,
// que es el lado seguro para un plazo legal). El parametro `feriados` existe
// para poder activarlo sin cambiar codigo (tabla `feriados` vacia por defecto).

export const PLAZO_DIAS_HABILES = 15;

function parseFecha(value) {
  // Acepta 'YYYY-MM-DD' o ISO completo; siempre trabaja en UTC para evitar
  // corrimientos de zona horaria al sumar dias.
  const [datePart] = String(value).split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

const FORMATO_FECHA_SANTIAGO = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Fecha local de Chile (America/Santiago) de un instante, como 'YYYY-MM-DD'.
 * Paridad con el .NET (`EnviadaEn.LocalDateTime` / `DateTime.Now`, hora de
 * Chile): un envio a las 23:30 en Chile cuenta para ESE dia, aunque su
 * timestamp UTC ya sea el dia siguiente (offset UTC-3/UTC-4 segun horario
 * de verano). Truncar el ISO en UTC directamente adelanta el inicio del
 * plazo un dia entero cerca de la medianoche chilena.
 */
function fechaLocalSantiago(date) {
  return FORMATO_FECHA_SANTIAGO.format(date);
}

function esFinDeSemana(date) {
  const dow = date.getUTCDay();
  return dow === 0 || dow === 6;
}

/** Suma `businessDays` dias habiles a `start` ('YYYY-MM-DD'). feriados es un Set opcional de fechas ISO a saltar. */
export function addBusinessDays(start, businessDays, feriados = new Set()) {
  let date = parseFecha(start);
  let added = 0;
  while (added < businessDays) {
    date = new Date(date.getTime() + 86400000);
    if (!esFinDeSemana(date) && !feriados.has(toISODate(date))) {
      added++;
    }
  }
  return toISODate(date);
}

/** Dias habiles entre dos fechas (excluye `from`, incluye `to` si es habil). */
export function businessDaysBetween(from, to, feriados = new Set()) {
  let date = parseFecha(from);
  const end = parseFecha(to);
  if (date >= end) {
    return 0;
  }
  let count = 0;
  while (date < end) {
    date = new Date(date.getTime() + 86400000);
    if (!esFinDeSemana(date) && !feriados.has(toISODate(date))) {
      count++;
    }
  }
  return count;
}

/**
 * Estado del plazo de una peticion, listo para pintar en la tabla.
 * @param {{enviadaEn: string|null}} peticion
 * @param {Date} [ahora] inyectable para tests
 */
export function plazoInfo(peticion, ahora = new Date(), feriados = new Set()) {
  const inicio = peticion.enviadaEn ? fechaLocalSantiago(new Date(peticion.enviadaEn)) : null;

  if (inicio === null) {
    return { inicio: null, vence: null, diasTranscurridos: 0, diasRestantes: PLAZO_DIAS_HABILES, vencido: false };
  }

  const hoy = fechaLocalSantiago(ahora);
  const vence = addBusinessDays(inicio, PLAZO_DIAS_HABILES, feriados);
  const diasTranscurridos = businessDaysBetween(inicio, hoy, feriados);
  const diasRestantes = PLAZO_DIAS_HABILES - diasTranscurridos;

  return { inicio, vence, diasTranscurridos, diasRestantes, vencido: diasRestantes < 0 };
}
