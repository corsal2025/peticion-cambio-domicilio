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

export async function crearUsuario(db, { usuario, nombre, rol = 'staff', clave }) {
  const { hash, salt } = await hashClave(clave);
  const result = await db
    .prepare('INSERT INTO usuarios (usuario, nombre, rol, hash, salt) VALUES (?, ?, ?, ?, ?)')
    .bind(usuario, nombre ?? usuario, rol, hash, salt)
    .run();
  return { id: result.meta.last_row_id };
}

export async function porUsuario(db, usuario) {
  return db.prepare('SELECT * FROM usuarios WHERE usuario = ?').bind(usuario).first();
}

export async function listarUsuarios(db) {
  const { results } = await db.prepare('SELECT id, usuario, nombre, rol, activo FROM usuarios WHERE activo = 1 ORDER BY usuario ASC').all();
  return results;
}
