// Gestion de usuarios (solo admin): alta y listado. La clave nunca se expone.
import { Hono } from 'hono';
import { crearUsuario, listarUsuarios } from '../lib/usuarios.js';

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
