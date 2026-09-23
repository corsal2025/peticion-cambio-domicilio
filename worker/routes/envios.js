// Panel admin de envios en 'revision' (lease de relay vencido sin reporte, ver
// worker/lib/relay.js). Rutas de sesion (admin), NO de secreto de relay.
import { Hono } from 'hono';
import { listarEnRevision, reencolarRevision, confirmarEnviadoManual } from '../lib/relay.js';

export const enviosRoutes = new Hono();

enviosRoutes.get('/envios/revision', async (c) => {
  return c.json(await listarEnRevision(c.env.DB));
});

enviosRoutes.post('/envios/:id/reencolar', async (c) => {
  const id = Number(c.req.param('id'));
  const resultado = await reencolarRevision(c.env.DB, id);
  return c.json(resultado, resultado.ok ? 200 : 409);
});

enviosRoutes.post('/envios/:id/confirmar', async (c) => {
  const id = Number(c.req.param('id'));
  const resultado = await confirmarEnviadoManual(c.env.DB, id);
  return c.json(resultado, resultado.ok ? 200 : 409);
});
