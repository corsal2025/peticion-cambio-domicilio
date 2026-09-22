// Configuracion clave/valor (tabla `config`): mail.mode, mail.test_email,
// mail.send_as, etc. Restringido a admin en las rutas (Batch 6); este modulo
// solo hace lectura/escritura sobre D1.

export async function obtenerConfig(db, clave) {
  const fila = await db.prepare('SELECT valor FROM config WHERE clave = ?').bind(clave).first();
  return fila ? fila.valor : null;
}

export async function obtenerTodaLaConfig(db) {
  const { results } = await db.prepare('SELECT clave, valor FROM config').all();
  return Object.fromEntries(results.map((r) => [r.clave, r.valor]));
}

export async function setConfig(db, clave, valor) {
  await db
    .prepare('INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
    .bind(clave, valor)
    .run();
}
