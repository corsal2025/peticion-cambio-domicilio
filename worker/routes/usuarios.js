// Gestion de usuarios (solo admin): alta, listado, edicion, reset de clave y
// baja. La clave (ni su hash/salt) nunca se expone en ninguna respuesta.
import { Hono } from 'hono';
import {
  crearUsuario,
  listarUsuarios,
  actualizarUsuario,
  actualizarClave,
  eliminarUsuario,
  contarAdminsActivos,
  porId,
} from '../lib/usuarios.js';
import { obtenerSesion } from './auth.js';

export const usuariosRoutes = new Hono();

usuariosRoutes.get('/usuarios', async (c) => {
  return c.json(await listarUsuarios(c.env.DB));
});

usuariosRoutes.post('/usuarios', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { usuario, nombre, rol, clave } = body || {};
  if (!usuario || !clave) return c.json({ error: 'Faltan usuario o clave' }, 400);
  const { id } = await crearUsuario(c.env.DB, { usuario, nombre, rol, clave });
  return c.json({ id }, 201);
});

/**
 * Edita nombre/rol/activo. Dos guardas de seguridad (independientes de
 * cuantos admins haya): (1) nadie puede desactivar su propia cuenta desde
 * aca (evita que un admin se deje afuera sin querer); (2) no se puede dejar
 * al sistema sin NINGUN admin activo (ni desactivando ni degradando a staff
 * al ultimo admin activo que quede).
 */
usuariosRoutes.put('/usuarios/:id', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const objetivo = await porId(db, id);
  if (!objetivo) return c.json({ error: 'El usuario no existe.' }, 404);

  const body = await c.req.json().catch(() => ({}));
  if (body.rol !== undefined && body.rol !== 'admin' && body.rol !== 'staff') {
    return c.json({ error: 'Rol invalido (admin o staff).' }, 400);
  }

  const sesion = await obtenerSesion(c);
  const activoNuevo = body.activo === undefined ? Boolean(objetivo.activo) : Boolean(body.activo);
  const rolNuevo = body.rol ?? objetivo.rol;
  const eraAdminActivo = objetivo.rol === 'admin' && objetivo.activo === 1;

  if (sesion && sesion.usuario === objetivo.usuario && !activoNuevo) {
    return c.json({ error: 'No puedes desactivar tu propia cuenta.' }, 409);
  }

  if (eraAdminActivo && (!activoNuevo || rolNuevo !== 'admin')) {
    const otrosAdmins = await contarAdminsActivos(db, objetivo.id);
    if (otrosAdmins === 0) {
      return c.json({ error: 'No se puede quitar al ultimo administrador activo.' }, 409);
    }
  }

  await actualizarUsuario(db, id, { nombre: body.nombre, rol: body.rol, activo: activoNuevo });
  return c.json({ ok: true });
});

/** Reseteo de clave por un admin: no pide la clave anterior (a diferencia de POST /auth/clave). */
usuariosRoutes.post('/usuarios/:id/clave', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const objetivo = await porId(db, id);
  if (!objetivo) return c.json({ error: 'El usuario no existe.' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const { clave } = body || {};
  if (!clave || String(clave).length < 4) {
    return c.json({ error: 'La clave debe tener al menos 4 caracteres.' }, 400);
  }

  await actualizarClave(db, id, clave);
  return c.json({ ok: true });
});

/** Baja definitiva. Mismas guardas que la desactivacion: nunca a si mismo, nunca al ultimo admin activo. */
usuariosRoutes.delete('/usuarios/:id', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const objetivo = await porId(db, id);
  if (!objetivo) return c.json({ error: 'El usuario no existe.' }, 404);

  const sesion = await obtenerSesion(c);
  if (sesion && sesion.usuario === objetivo.usuario) {
    return c.json({ error: 'No puedes eliminar tu propia cuenta.' }, 409);
  }

  if (objetivo.rol === 'admin' && objetivo.activo === 1) {
    const otrosAdmins = await contarAdminsActivos(db, objetivo.id);
    if (otrosAdmins === 0) {
      return c.json({ error: 'No se puede eliminar al ultimo administrador activo.' }, 409);
    }
  }

  await eliminarUsuario(db, id);
  return c.json({ ok: true });
});
