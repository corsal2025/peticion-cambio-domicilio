// Usuarios (funcionarios) con clave propia, alternativa al PIN maestro.
// Hash de clave con PBKDF2 (Web Crypto, disponible en Workers y Node), salt
// aleatorio por usuario. Nunca se guarda ni se compara la clave en texto plano.
const ITERACIONES_PBKDF2 = 100_000;

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function derivarHash(clave, saltBytes) {
  const claveImportada = await crypto.subtle.importKey('raw', new TextEncoder().encode(clave), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: ITERACIONES_PBKDF2, hash: 'SHA-256' },
    claveImportada,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

async function hashClave(clave) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToHex(saltBytes);
  const hash = await derivarHash(clave, saltBytes);
  return { hash, salt };
}

export async function verificarClave(clave, hash, salt) {
  if (!hash || !salt) return false;
  const calculado = await derivarHash(clave, hexToBytes(salt));
  return calculado === hash;
}

/**
 * Normaliza un nombre de usuario para comparar/guardar: recorta espacios y
 * pasa a minusculas. En produccion existian filas creadas antes de esta
 * normalizacion ("RAUL " con espacio final, "Raul" con mayuscula) que nunca
 * calzaban entre si ni con el login; por eso el alta, la edicion y el login
 * SIEMPRE comparan/guardan la forma normalizada.
 */
export function normalizarUsuario(usuario) {
  return String(usuario ?? '').trim().toLowerCase();
}

export async function crearUsuario(db, { usuario, nombre, rol = 'staff', clave }) {
  const usuarioNorm = normalizarUsuario(usuario);
  const existente = await porUsuario(db, usuarioNorm);
  if (existente) {
    throw Object.assign(new Error('Ya existe un usuario con ese nombre.'), { status: 409 });
  }

  const { hash, salt } = await hashClave(clave);
  const result = await db
    .prepare('INSERT INTO usuarios (usuario, nombre, rol, hash, salt) VALUES (?, ?, ?, ?, ?)')
    .bind(usuarioNorm, nombre ?? usuarioNorm, rol, hash, salt)
    .run();
  return { id: result.meta.last_row_id };
}

/**
 * Busca UN usuario por nombre normalizado (trim + lowercase), matcheando
 * tambien filas antiguas guardadas sin normalizar. Si hay mas de una fila
 * duplicada (mismo nombre normalizado, ver comentario de `normalizarUsuario`)
 * retorna la primera; para el login, que debe probar la clave contra CADA
 * candidato, usar `porUsuarioTodos`.
 */
export async function porUsuario(db, usuario) {
  return db
    .prepare("SELECT * FROM usuarios WHERE lower(trim(usuario)) = ?")
    .bind(normalizarUsuario(usuario))
    .first();
}

/** Todas las filas cuyo nombre normalizado matchea (para resolver duplicados en el login). */
export async function porUsuarioTodos(db, usuario) {
  const { results } = await db
    .prepare("SELECT * FROM usuarios WHERE lower(trim(usuario)) = ?")
    .bind(normalizarUsuario(usuario))
    .all();
  return results;
}

export async function porId(db, id) {
  return db.prepare('SELECT * FROM usuarios WHERE id = ?').bind(id).first();
}

/** Todos los usuarios (activos e inactivos), para la pantalla de gestion de Configuracion. */
export async function listarUsuarios(db) {
  const { results } = await db.prepare('SELECT id, usuario, nombre, rol, activo FROM usuarios ORDER BY usuario ASC').all();
  return results;
}

/** Edita nombre/rol/activo de un usuario existente (alta de clave aparte, ver `actualizarClave`). */
export async function actualizarUsuario(db, id, { nombre, rol, activo } = {}) {
  const actual = await porId(db, id);
  if (!actual) {
    throw Object.assign(new Error('El usuario no existe.'), { status: 404 });
  }
  const nombreNuevo = nombre ?? actual.nombre;
  const rolNuevo = rol ?? actual.rol;
  const activoNuevo = activo === undefined ? actual.activo : activo ? 1 : 0;
  await db
    .prepare('UPDATE usuarios SET nombre = ?, rol = ?, activo = ? WHERE id = ?')
    .bind(nombreNuevo, rolNuevo, activoNuevo, id)
    .run();
}

/** Cambia la clave (hash+salt nuevos) de un usuario existente. Usado tanto por el reset de un admin como por el cambio de clave propia. */
export async function actualizarClave(db, id, claveNueva) {
  const { hash, salt } = await hashClave(claveNueva);
  await db.prepare('UPDATE usuarios SET hash = ?, salt = ? WHERE id = ?').bind(hash, salt, id).run();
}

export async function eliminarUsuario(db, id) {
  await db.prepare('DELETE FROM usuarios WHERE id = ?').bind(id).run();
}

/** Cuenta admins activos, opcionalmente excluyendo un id (para chequear "es el ultimo admin"). */
export async function contarAdminsActivos(db, excluirId = null) {
  const fila = await db
    .prepare("SELECT COUNT(*) AS n FROM usuarios WHERE activo = 1 AND rol = 'admin' AND id != ?")
    .bind(excluirId ?? -1)
    .first();
  return fila.n;
}
