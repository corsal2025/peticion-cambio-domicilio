// Rutas de sesion (login/logout/me) + middlewares `guard` (exige sesion en todo
// /api/* salvo login/logout/me) y `soloAdmin` (rutas de configuracion).
// Usa worker/lib/auth.js (HMAC puro) + hono/cookie (getCookie/setCookie, sin
// firmar de nuevo: el HMAC ya lo aplica firmarSesion/verificarSesion).
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { firmarSesion, verificarSesion, pinValido, MAX_EDAD_MS } from '../lib/auth.js';
import { porUsuarioTodos, verificarClave, normalizarUsuario } from '../lib/usuarios.js';
import { claveIntento, estaBloqueado, estaBloqueadoGlobal, registrarFallo, limpiarFallos } from '../lib/loginRateLimit.js';

const NOMBRE_COOKIE = 'peticion_sesion';
const LIBRES = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me']);

const FALLBACK_DEV_INSEGURO = 'secreto-dev-inseguro-cambiar-en-produccion';

/**
 * Resuelve el secreto de sesion. Falla cerrado: si no hay SESSION_SECRET en
 * el entorno, NO se usa un fallback salvo que se declare explicitamente modo
 * desarrollo local con `DEV=1` (o `.dev.vars` de wrangler, que Wrangler
 * inyecta como `env.DEV`). Devuelve `null` si no hay secreto utilizable, para
 * que el llamador responda 500 en vez de fallar-abierto con cookies forjables.
 */
function secreto(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.DEV === '1' || env.DEV === true) return FALLBACK_DEV_INSEGURO;
  return null;
}

const ERROR_SECRETO = { error: 'Configuracion del servidor incompleta (SESSION_SECRET)' };

/** Lee y verifica la sesion actual, cacheandola en el contexto de Hono. Lanza si falta secreto (fail closed). */
export async function obtenerSesion(c) {
  const cacheada = c.get('sesion');
  if (cacheada !== undefined) return cacheada;
  const s = secreto(c.env);
  if (!s) throw new Error('SESSION_SECRET_FALTANTE');
  const valor = getCookie(c, NOMBRE_COOKIE);
  const sesion = valor ? await verificarSesion(valor, s) : null;
  c.set('sesion', sesion);
  return sesion;
}

async function establecerSesion(c, datos) {
  const s = secreto(c.env);
  if (!s) throw new Error('SESSION_SECRET_FALTANTE');
  const valor = await firmarSesion(datos, s);
  setCookie(c, NOMBRE_COOKIE, valor, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(MAX_EDAD_MS / 1000),
  });
  c.set('sesion', { ...datos, exp: Date.now() + MAX_EDAD_MS });
}

/** Exige sesion valida en toda ruta /api/* salvo login/logout/me. Contrato: 401 sin sesion, 500 si falta config. */
export async function guard(c, next) {
  const path = new URL(c.req.url).pathname;
  if (LIBRES.has(path)) return next();
  let sesion;
  try {
    sesion = await obtenerSesion(c);
  } catch {
    return c.json(ERROR_SECRETO, 500);
  }
  if (!sesion) return c.json({ error: 'Sesion requerida', login: true }, 401);
  return next();
}

/** Bloquea rutas de configuracion a quien no tenga rol admin. */
export async function soloAdmin(c, next) {
  let sesion;
  try {
    sesion = await obtenerSesion(c);
  } catch {
    return c.json(ERROR_SECRETO, 500);
  }
  if (!sesion || sesion.rol !== 'admin') return c.json({ error: 'Esta accion es solo para administradores.' }, 403);
  return next();
}

export const authRoutes = new Hono();

authRoutes.post('/auth/login', async (c) => {
  if (!secreto(c.env)) return c.json(ERROR_SECRETO, 500);
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const { usuario, clave } = body || {};
  if (!usuario || !clave) return c.json({ error: 'Indica usuario y clave' }, 400);

  // Solo CF-Connecting-IP: es la cabecera que Cloudflare setea de verdad en
  // el edge y NO se puede falsificar desde fuera. `x-forwarded-for` la puede
  // mandar cualquier cliente con el valor que quiera, asi que usarla como
  // fallback dejaba rotar la IP "declarada" para evadir el rate limit por
  // clave ip+usuario.
  const ip = c.req.header('CF-Connecting-IP') || 'sin-ip';
  const claveRate = claveIntento(ip, usuario);
  if ((await estaBloqueado(db, claveRate)) || (await estaBloqueadoGlobal(db, usuario))) {
    return c.json({ error: 'Demasiados intentos fallidos. Intenta de nuevo en unos minutos.' }, 429);
  }

  // Puede haber mas de una fila que normaliza al mismo nombre (datos viejos
  // guardados antes de normalizar usuario, ej. "RAUL " y "Raul" en
  // produccion): se prueba la clave contra CADA candidato y se entra con el
  // primero que verifique.
  const candidatos = await porUsuarioTodos(db, usuario);
  for (const candidato of candidatos) {
    if (candidato.hash && (await verificarClave(clave, candidato.hash, candidato.salt))) {
      await limpiarFallos(db, claveRate, usuario);
      await establecerSesion(c, { usuario: candidato.usuario, rol: candidato.rol });
      return c.json({ ok: true, usuario: candidato.usuario, rol: candidato.rol });
    }
  }

  if (pinValido(clave, c.env.MASTER_PIN)) {
    // El PIN maestro solo puede: (a) autenticar a un usuario YA EXISTENTE
    // sin clave propia todavia, conservando su propio rol; o (b) crear una
    // sesion admin para el nombre fijo 'admin'. Nunca otorga admin a un
    // nombre de usuario arbitrario inventado en el login.
    const sinClave = candidatos.find((candidato) => !candidato.hash);
    if (sinClave) {
      await limpiarFallos(db, claveRate, usuario);
      await establecerSesion(c, { usuario: sinClave.usuario, rol: sinClave.rol });
      return c.json({ ok: true, usuario: sinClave.usuario, rol: sinClave.rol });
    }
    if (candidatos.length === 0 && normalizarUsuario(usuario) === 'admin') {
      await limpiarFallos(db, claveRate, usuario);
      await establecerSesion(c, { usuario: 'admin', rol: 'admin' });
      return c.json({ ok: true, usuario: 'admin', rol: 'admin' });
    }
  }

  await registrarFallo(db, claveRate, usuario);
  return c.json({ error: 'Usuario o clave incorrectos' }, 401);
});

authRoutes.post('/auth/logout', (c) => {
  deleteCookie(c, NOMBRE_COOKIE, { path: '/' });
  c.set('sesion', null);
  return c.json({ ok: true });
});

authRoutes.get('/auth/me', async (c) => {
  let sesion;
  try {
    sesion = await obtenerSesion(c);
  } catch {
    return c.json(ERROR_SECRETO, 500);
  }
  return c.json({ usuario: sesion?.usuario ?? null, rol: sesion?.rol ?? null });
});
