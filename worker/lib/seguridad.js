// Comparacion de strings en tiempo constante, compartida por auth (PIN
// maestro) y por los secretos compartidos de import/relay. Evita timing
// attacks al comparar secretos byte a byte con early-return.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Longitud distinta: igual recorremos el largo mayor comparando contra la
  // cadena mas corta repetida, para no filtrar la longitud via early-exit.
  const largo = Math.max(a.length, b.length);
  let dif = a.length === b.length ? 0 : 1;
  for (let i = 0; i < largo; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    dif |= ca ^ cb;
  }
  return dif === 0;
}
