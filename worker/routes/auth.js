// Rutas de sesion (login/logout/me) + middlewares `guard` (exige sesion en todo
// /api/* salvo login/logout/me) y `soloAdmin` (rutas de configuracion).
// Usa worker/lib/auth.js (HMAC puro) + hono/cookie (getCookie/setCookie, sin
// firmar de nuevo: el HMAC ya lo aplica firmarSesion/verificarSesion).
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { firmarSesion, verificarSesion, pinValido, MAX_EDAD_MS } from '../lib/auth.js';
import { porUsuario, verificarClave } from '../lib/usuarios.js';

const NOMBRE_COOKIE = 'peticion_sesion';
const LIBRES = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me']);

function secreto(env) {
  return env.SESSION_SECRET || 'secreto-dev-inseguro-cambiar-en-produccion';
}

/** Lee y verifica la sesion actual, cacheandola en el contexto de Hono. */
export async function obtenerSesion(c) {
  const cacheada = c.get('sesion');
  if (cacheada !== undefined) return cacheada;
  const valor = getCookie(c, NOMBRE_COOKIE);
  const sesion = valor ? await verificarSesion(valor, secreto(c.env)) : null;
  c.set('sesion', sesion);
  return sesion;
}

async function establecerSesion(c, datos) {
  const valor = await firmarSesion(datos, secreto(c.env));
  setCookie(c, NOMBRE_COOKIE, valor, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(MAX_EDAD_MS / 1000),
  });
  c.set('sesion', { ...datos, exp: Date.now() + MAX_EDAD_MS });
}

/** Exige sesion valida en toda ruta /api/* salvo login/logout/me. Contrato: 401 sin sesion. */
export async function guard(c, next) {
  const path = new URL(c.req.url).pathname;
  if (LIBRES.has(path)) return next();
  const sesion = await obtenerSesion(c);
  if (!sesion) return c.json({ error: 'Sesion requerida', login: true }, 401);
  return next();
}

/** Bloquea rutas de configuracion a quien no tenga rol admin. */
export async function soloAdmin(c, next) {
  const sesion = await obtenerSesion(c);
  if (!sesion || sesion.rol !== 'admin') return c.json({ error: 'Esta accion es solo para administradores.' }, 403);
  return next();
}

export const authRoutes = new Hono();

authRoutes.post('/auth/login', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const { usuario, clave } = body || {};
  if (!usuario || !clave) return c.json({ error: 'Indica usuario y clave' }, 400);

  const u = await porUsuario(db, usuario);
  if (u && u.hash && (await verificarClave(clave, u.hash, u.salt))) {
    await establecerSesion(c, { usuario: u.usuario, rol: u.rol });
    return c.json({ ok: true, usuario: u.usuario, rol: u.rol });
  }

  if (!u || !u.hash) {
    if (pinValido(clave, c.env.MASTER_PIN)) {
      const rol = u ? u.rol : 'admin';
      await establecerSesion(c, { usuario: String(usuario), rol });
      return c.json({ ok: true, usuario: String(usuario), rol });
    }
  }

  return c.json({ error: 'Usuario o clave incorrectos' }, 401);
});

authRoutes.post('/auth/logout', (c) => {
  deleteCookie(c, NOMBRE_COOKIE, { path: '/' });
  c.set('sesion', null);
  return c.json({ ok: true });
});

authRoutes.get('/auth/me', async (c) => {
  const sesion = await obtenerSesion(c);
  return c.json({ usuario: sesion?.usuario ?? null, rol: sesion?.rol ?? null });
});
