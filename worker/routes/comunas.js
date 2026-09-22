// CRUD del directorio de comunas + import de CSV (paridad con ComunaDirectory.cs).
import { Hono } from 'hono';
import { crearComuna, listarComunas, actualizarComuna, eliminarComuna, importarCsv } from '../lib/comunas.js';

export const comunasRoutes = new Hono();

comunasRoutes.get('/comunas', async (c) => {
  return c.json(await listarComunas(c.env.DB));
});

comunasRoutes.post('/comunas', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.nombre) return c.json({ error: 'Falta el nombre de la comuna' }, 400);
  const { id } = await crearComuna(c.env.DB, body);
  return c.json({ id }, 201);
});

comunasRoutes.put('/comunas/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await actualizarComuna(c.env.DB, Number(c.req.param('id')), body);
  return c.json({ ok: true });
});

comunasRoutes.delete('/comunas/:id', async (c) => {
  await eliminarComuna(c.env.DB, Number(c.req.param('id')));
  return c.json({ ok: true });
});

comunasRoutes.post('/comunas/import', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.csv) return c.json({ error: 'Falta el CSV (campo "csv")' }, 400);
  const resumen = await importarCsv(c.env.DB, body.csv);
  return c.json({ ok: true, ...resumen });
});
