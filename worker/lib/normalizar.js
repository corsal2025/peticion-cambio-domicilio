// Normalizacion de texto para busqueda y comparacion (nombre, comuna, rut).
// Port de PeticionCambioDomicilio.Domain.TextNormalization (Fold) mas el
// soporte de busqueda por RUT sin puntos ni guion que exige el buscador.

/** Minusculas, sin tildes, espacios colapsados. Para comparar nombres/comunas. */
export function fold(value) {
  if (value == null || typeof value !== 'string' || value.trim() === '') {
    return '';
  }
  const sinTildes = value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC');
  return sinTildes.split(/\s+/).filter(Boolean).join(' ');
}

/** Deja solo digitos y K/k (mayuscula), para comparar RUTs sin puntos ni guion. */
function soloDigitosYK(value) {
  if (value == null) return '';
  return String(value)
    .toUpperCase()
    .replace(/[^0-9K]/g, '');
}

/**
 * True si `query` aparece en `texto`, ya sea como fragmento de texto (case/tilde
 * insensitive) o como fragmento de RUT (ignorando puntos y guion).
 */
export function coincide(texto, query) {
  if (!query) return true;
  if (texto == null) return false;

  if (fold(texto).includes(fold(query))) {
    return true;
  }

  const queryDigitos = soloDigitosYK(query);
  if (queryDigitos.length > 0) {
    return soloDigitosYK(texto).includes(queryDigitos);
  }

  return false;
}
