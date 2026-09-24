// Validacion de RUT chileno (modulo 11). Port 1:1 de
// PeticionCambioDomicilio.Domain.RutValidator.NormalizeAndValidate.

/**
 * Normaliza un RUT (con o sin puntos, K mayuscula o minuscula) a la forma
 * canonica con puntos (ej. "18.785.387-7") y valida el digito verificador.
 * Retorna null si la entrada no tiene forma de RUT o el digito no calza.
 */
export function normalizeAndValidate(rawRut) {
  if (rawRut == null) {
    return null;
  }

  let digitsAndK = '';
  for (const c of String(rawRut)) {
    if (/[0-9]/.test(c) || c === 'k' || c === 'K') {
      digitsAndK += c.toUpperCase();
    }
  }

  if (digitsAndK.length < 2) {
    return null;
  }

  let body = digitsAndK.slice(0, -1);
  const checkDigit = digitsAndK.slice(-1);

  if (body.length < 7 || body.length > 8 || !/^[0-9]+$/.test(body)) {
    return null;
  }

  if (computeCheckDigit(body) !== checkDigit) {
    return null;
  }

  if (body.length === 7) {
    body = '0' + body;
  }

  return format(body, checkDigit);
}

function computeCheckDigit(body) {
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += (body.charCodeAt(i) - 48) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  if (remainder === 11) return '0';
  if (remainder === 10) return 'K';
  return String(remainder);
}

function format(body, checkDigit) {
  const reversed = body.split('').reverse().join('');
  let grouped = '';
  for (let i = 0; i < reversed.length; i++) {
    if (i > 0 && i % 3 === 0) {
      grouped += '.';
    }
    grouped += reversed[i];
  }
  const formattedBody = grouped.split('').reverse().join('');
  return `${formattedBody}-${checkDigit}`;
}
