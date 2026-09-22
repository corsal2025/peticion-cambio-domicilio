// Endpoints usados por el proceso .NET `--relay` (autenticado por secreto
// compartido, NO por sesion de usuario).
import { Hono } from 'hono';
import { obtenerPendientes, reportarResultado } from '../lib/relay.js';

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function autenticado(c) {
  const secreto = c.req.header('X-Relay-Secret') || '';
  return Boolean(c.env.RELAY_SECRET) && timingSafeEqual(secreto, c.env.RELAY_SECRET);
}

export const relayRoutes = new Hono();

relayRoutes.get('/relay/pendientes', async (c) => {
  if (!autenticado(c)) return c.json({ error: 'Secreto de relay invalido' }, 401);
  const limite = Number(c.req.query('limit')) || 10;
  const pendientes = await obtenerPendientes(c.env.DB, limite);
  return c.json(pendientes);
});

relayRoutes.post('/relay/resultado', async (c) => {
  if (!autenticado(c)) return c.json({ error: 'Secreto de relay invalido' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const { id, ok, detalle } = body || {};
  if (!id) return c.json({ error: 'Falta id' }, 400);
  const resultado = await reportarResultado(c.env.DB, Number(id), Boolean(ok), detalle);
  return c.json(resultado);
});
