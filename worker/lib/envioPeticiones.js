// Vincula cada envio (un correo por comuna) con las peticiones EXACTAS que
// incluyo (tabla envio_peticiones), en vez de re-derivarlas por comuna+EnCola
// en el momento de reportar el resultado. Sin esta tabla, dos envios
// encolados para la misma comuna hacian que el primero en reportar 'ok'
// marcara TAMBIEN las peticiones del segundo (EnviadaEn/plazo incorrectos).
export async function registrarPeticionesEnvio(db, envioId, peticionIds) {
  for (const id of peticionIds) {
    await db.prepare('INSERT OR IGNORE INTO envio_peticiones (envio_id, peticion_id) VALUES (?, ?)').bind(envioId, id).run();
  }
}

/**
 * Peticiones exactas de un envio. Si no hay filas en envio_peticiones (envio
 * legado, previo a esta tabla), cae al comportamiento anterior (comuna +
 * EnCola) solo como fallback de compatibilidad.
 */
export async function peticionesDelEnvio(db, envio) {
  const { results } = await db.prepare('SELECT peticion_id FROM envio_peticiones WHERE envio_id = ?').bind(envio.id).all();
  if (results.length) return results.map((r) => r.peticion_id);

  const representante = await db.prepare('SELECT comuna FROM peticiones WHERE id = ?').bind(envio.peticion_id).first();
  if (!representante) return [envio.peticion_id];
  const { results: enCola } = await db
    .prepare("SELECT id FROM peticiones WHERE comuna = ? AND estado = 'EnCola'")
    .bind(representante.comuna)
    .all();
  return enCola.length ? enCola.map((r) => r.id) : [envio.peticion_id];
}
