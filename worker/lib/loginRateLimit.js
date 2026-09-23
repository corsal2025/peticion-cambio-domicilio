// Rate limit de login, dos capas, ambas en D1 (tabla login_intentos):
// 1) por clave ip+usuario: 5 fallos / 15 minutos (bloquea fuerza bruta desde
//    una misma IP contra un usuario).
// 2) global por usuario (clave 'global:<usuario>'): 20 fallos / 1 hora
//    sumando TODAS las IPs, para que rotar de IP no evada el bloqueo (1).
// El incremento de cada clave es una unica sentencia UPSERT atomica (sin
// lectura previa separada), para no perder fallos por una carrera entre
// logins concurrentes con la misma clave.
export const MAX_FALLOS = 5;
export const VENTANA_MS = 15 * 60 * 1000;
export const MAX_FALLOS_GLOBAL = 20;
export const VENTANA_GLOBAL_MS = 60 * 60 * 1000;

/** Nombre de usuario normalizado (trim + lowercase) para armar claves de rate limit. */
function normalizar(usuario) {
  return String(usuario || '').trim().toLowerCase();
}

/** Clave de rate limit por IP: combina IP y usuario para no bloquear a todos por una IP compartida sola. */
export function claveIntento(ip, usuario) {
  return `${ip || 'sin-ip'}:${normalizar(usuario)}`;
}

/** Clave de rate limit global por usuario (sin IP), para el tope (2). */
export function claveUsuarioGlobal(usuario) {
  return `global:${normalizar(usuario)}`;
}

async function fallosVigentes(db, clave, ventanaMs, ahora) {
  const fila = await db.prepare('SELECT fallos, ultimo_fallo FROM login_intentos WHERE clave = ?').bind(clave).first();
  if (!fila) return 0;
  const ultimoFallo = Date.parse(fila.ultimo_fallo.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ultimoFallo) || ahora - ultimoFallo >= ventanaMs) return 0;
  return fila.fallos;
}

/** true si la clave ip+usuario esta actualmente bloqueada por exceso de fallos recientes. */
export async function estaBloqueado(db, clave, ahora = Date.now()) {
  return (await fallosVigentes(db, clave, VENTANA_MS, ahora)) >= MAX_FALLOS;
}

/** true si el usuario esta bloqueado por el tope global (todas las IPs sumadas). */
export async function estaBloqueadoGlobal(db, usuario, ahora = Date.now()) {
  return (await fallosVigentes(db, claveUsuarioGlobal(usuario), VENTANA_GLOBAL_MS, ahora)) >= MAX_FALLOS_GLOBAL;
}

/**
 * Incrementa el contador de UNA clave con un UPSERT atomico: si la clave no
 * existe la crea en 1; si existe y la ventana anterior sigue vigente suma 1;
 * si la ventana ya vencio, reinicia en 1. Todo en una sola sentencia SQL (sin
 * SELECT previo) para evitar la carrera de leer-luego-escribir entre dos
 * logins fallidos concurrentes con la misma clave.
 */
async function incrementarClave(db, clave, ventanaMs) {
  const ventanaSegundos = ventanaMs / 1000;
  await db
    .prepare(
      `INSERT INTO login_intentos (clave, fallos, ultimo_fallo) VALUES (?, 1, datetime('now'))
       ON CONFLICT(clave) DO UPDATE SET
         fallos = CASE
           WHEN (julianday('now') - julianday(ultimo_fallo)) * 86400 < ?
           THEN fallos + 1
           ELSE 1
         END,
         ultimo_fallo = datetime('now')`,
    )
    .bind(clave, ventanaSegundos)
    .run();
}

/**
 * Registra un intento fallido. `clave` es la clave ip+usuario (ventana de 15
 * min). Si se pasa `usuario`, tambien incrementa el tope global de ese
 * usuario (ventana de 1h) para que cambiar de IP no evada el bloqueo.
 */
export async function registrarFallo(db, clave, usuario) {
  await incrementarClave(db, clave, VENTANA_MS);
  if (usuario) await incrementarClave(db, claveUsuarioGlobal(usuario), VENTANA_GLOBAL_MS);
}

/** Limpia el contador de fallos tras un login exitoso (clave ip+usuario y, si se pasa `usuario`, el tope global). */
export async function limpiarFallos(db, clave, usuario) {
  await db.prepare('DELETE FROM login_intentos WHERE clave = ?').bind(clave).run();
  if (usuario) await db.prepare('DELETE FROM login_intentos WHERE clave = ?').bind(claveUsuarioGlobal(usuario)).run();
}
