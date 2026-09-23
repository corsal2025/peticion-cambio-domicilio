// D1 (Cloudflare) rechaza un parametro/statement bindeado por encima de
// ~100KB. Cuando pasamos un lote entero como UN parametro JSON (para usarlo
// con json_each() dentro de un solo statement, ver importar.js/comunas.js),
// hay que partirlo en varios parametros mas chicos si el lote es grande.
// Partir por tamano (no solo por cantidad de filas) nos protege incluso si
// las filas son mas pesadas de lo esperado (nombres largos, muchos correos
// acumulados en una comuna, etc.).
const MAX_BYTES_DEFAULT = 90_000;

/**
 * Parte `items` en sub-arreglos cuyo JSON.stringify no supera `maxBytes`
 * (aproximado: usa longitud de string, suficiente para JSON ASCII/UTF-8
 * mayormente latino de este proyecto). Nunca devuelve un chunk vacio, salvo
 * que `items` este vacio (devuelve []). Si un item individual ya supera
 * `maxBytes`, igual se emite en su propio chunk (mejor un statement grande
 * que perder datos).
 *
 * @template T
 * @param {T[]} items
 * @param {number} [maxBytes]
 * @returns {T[][]}
 */
export function chunkPorTamano(items, maxBytes = MAX_BYTES_DEFAULT) {
  if (!items || items.length === 0) return [];

  const chunks = [];
  let actual = [];
  let actualBytes = 2; // '[' + ']'

  for (const item of items) {
    const itemBytes = JSON.stringify(item).length + 1; // + separador ','

    if (actual.length > 0 && actualBytes + itemBytes > maxBytes) {
      chunks.push(actual);
      actual = [];
      actualBytes = 2;
    }

    actual.push(item);
    actualBytes += itemBytes;
  }

  if (actual.length > 0) chunks.push(actual);
  return chunks;
}
