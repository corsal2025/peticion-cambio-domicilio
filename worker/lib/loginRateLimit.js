// Rate limit simple de login: 5 fallos / 15 minutos por clave (ip+usuario).
// Guardado en D1 (tabla login_intentos) para funcionar sin estado en memoria
// entre invocaciones del Worker.
export const MAX_FALLOS = 5;
export const VENTANA_MS = 15 * 60 * 1000;

/** Clave de rate limit: combina IP y usuario para no bloquear a todos por una IP compartida sola. */
export function claveIntento(ip, usuario) {
  return `${ip || 'sin-ip'}:${String(usuario || '').toLowerCase()}`;
}

/** true si la clave esta actualmente bloqueada por exceso de fallos recientes. */
export async function estaBloqueado(db, clave, ahora = Date.now()) {
  const fila = await db.prepare('SELECT fallos, ultimo_fallo FROM login_intentos WHERE clave = ?').bind(clave).first();
  if (!fila || fila.fallos < MAX_FALLOS) return false;
  const ultimoFallo = Date.parse(fila.ultimo_fallo.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ultimoFallo)) return false;
  return ahora - ultimoFallo < VENTANA_MS;
}

/** Registra un intento fallido: incrementa el contador o lo reinicia si la ventana anterior ya expiro. */
export async function registrarFallo(db, clave, ahora = Date.now()) {
  const fila = await db.prepare('SELECT fallos, ultimo_fallo FROM login_intentos WHERE clave = ?').bind(clave).first();
  if (fila) {
    const ultimoFallo = Date.parse(fila.ultimo_fallo.replace(' ', 'T') + 'Z');
    const dentroDeVentana = !Number.isNaN(ultimoFallo) && ahora - ultimoFallo < VENTANA_MS;
    const nuevosFallos = dentroDeVentana ? fila.fallos + 1 : 1;
    await db
      .prepare("UPDATE login_intentos SET fallos = ?, ultimo_fallo = datetime('now') WHERE clave = ?")
      .bind(nuevosFallos, clave)
      .run();
  } else {
    await db
      .prepare("INSERT INTO login_intentos (clave, fallos, ultimo_fallo) VALUES (?, 1, datetime('now'))")
      .bind(clave)
      .run();
  }
}

/** Limpia el contador de fallos tras un login exitoso. */
export async function limpiarFallos(db, clave) {
  await db.prepare('DELETE FROM login_intentos WHERE clave = ?').bind(clave).run();
}
