// POST /api/sincronizar: dispara una sincronizacion manual bajo demanda
// (paridad con el boton "Cargar cambios de domicilio" del .NET viejo). Exige
// sesion valida (cualquier rol), a diferencia de /api/import y
// /api/comunas/sync que se autentican por secreto compartido porque los
// llama Apps Script sin navegador. Se monta despues de `api.use('*', guard)`
// en app.js.
import { Hono } from 'hono';
import { ejecutarSincronizacionManual, obtenerUltimaSincronizacion } from '../lib/sincronizar.js';

export const sincronizarRoutes = new Hono();

sincronizarRoutes.post('/sincronizar', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const resultado = await ejecutarSincronizacionManual(c.env, fetch, body.accion);
  return c.json(resultado.body, resultado.status);
});

sincronizarRoutes.get('/sincronizar/estado', async (c) => {
  const ultimaSincronizacion = await obtenerUltimaSincronizacion(c.env.DB);
  return c.json({ ultimaSincronizacion });
});
