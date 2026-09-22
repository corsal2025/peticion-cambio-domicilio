// Capa de acceso a datos sobre Cloudflare D1. Sin ORM: los modulos de worker/lib
// reciben el binding D1 (`c.env.DB`) por request y preparan sus propios statements.
//
// D1 es 100% asincrono y no tiene BEGIN/COMMIT manual; `db.batch([...statements])`
// ejecuta un arreglo de D1PreparedStatement ya bindeados como una sola transaccion
// atomica. `batch()` es un wrapper delgado sobre eso (evita llamar a db.batch con
// un arreglo vacio, que algunos drivers rechazan).

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {import('@cloudflare/workers-types').D1PreparedStatement[]} statements
 */
export async function batch(db, statements) {
  if (!statements.length) {
    return [];
  }
  return db.batch(statements);
}
