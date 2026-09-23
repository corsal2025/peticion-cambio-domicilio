// POST /api/import: recibe filas filtradas desde Apps Script y hace upsert
// idempotente. Autenticado por secreto compartido (header X-Import-Secret),
// NO por sesion de usuario (Apps Script no tiene cookie).
import { Hono } from 'hono';
import { importarFilas } from '../lib/importar.js';

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

export const importarRoutes = new Hono();

importarRoutes.post('/import', async (c) => {
  const secreto = c.req.header('X-Import-Secret') || '';
  if (!c.env.IMPORT_SECRET || !timingSafeEqual(secreto, c.env.IMPORT_SECRET)) {
    return c.json({ error: 'Secreto de import invalido' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const filas = Array.isArray(body.filas) ? body.filas : [];
  const hojasLeidas = Number.isFinite(body.hojasLeidas) ? body.hojasLeidas : undefined;

  try {
    const resumen = await importarFilas(c.env.DB, filas, { hojasLeidas });
    await c.env.DB
      .prepare('INSERT INTO sync_log (fuente, recibidas, insertadas, actualizadas, errores) VALUES (?, ?, ?, ?, ?)')
      .bind('apps-script', resumen.recibidas, resumen.insertadas, resumen.actualizadas, 0)
      .run();
    return c.json({ ok: true, ...resumen });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});
