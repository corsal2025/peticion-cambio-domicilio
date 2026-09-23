// POST /api/import: recibe filas filtradas desde Apps Script y hace upsert
// idempotente (nunca borra). POST /api/import/finalizar: cierra una
// sincronizacion (identificada por syncId) y recien ahi ejecuta la limpieza
// de obsoletas, usando el acumulado de TODOS los lotes de esa sincronizacion
// (el libro real tiene ~4400 filas relevantes y Apps Script siempre reparte
// el envio en varios POST /api/import). Autenticado por secreto compartido
// (header X-Import-Secret), NO por sesion de usuario (Apps Script no tiene
// cookie).
import { Hono } from 'hono';
import { importarFilas, finalizarImport } from '../lib/importar.js';
import { timingSafeEqual } from '../lib/seguridad.js';

function secretoValido(c) {
  const secreto = c.req.header('X-Import-Secret') || '';
  return Boolean(c.env.IMPORT_SECRET) && timingSafeEqual(secreto, c.env.IMPORT_SECRET);
}

export const importarRoutes = new Hono();

importarRoutes.post('/import', async (c) => {
  if (!secretoValido(c)) {
    return c.json({ error: 'Secreto de import invalido' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const filas = Array.isArray(body.filas) ? body.filas : [];
  const hojasLeidas = Number.isFinite(body.hojasLeidas) ? body.hojasLeidas : undefined;
  const syncId = typeof body.syncId === 'string' && body.syncId.length > 0 ? body.syncId : undefined;
  const lote = Number.isFinite(body.lote) ? body.lote : undefined;
  const totalLotes = Number.isFinite(body.totalLotes) ? body.totalLotes : undefined;

  try {
    const resumen = await importarFilas(c.env.DB, filas, { syncId, lote, totalLotes, hojasLeidas });
    await c.env.DB
      .prepare('INSERT INTO sync_log (fuente, recibidas, insertadas, actualizadas, errores) VALUES (?, ?, ?, ?, ?)')
      .bind('apps-script', resumen.recibidas, resumen.insertadas, resumen.actualizadas, 0)
      .run();
    return c.json({ ok: true, ...resumen });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

// Cierra la sincronizacion syncId: exige que hayan llegado todos los lotes
// anunciados (totalLotes) y ejecuta la limpieza de obsoletas una sola vez
// sobre el acumulado. Si aun faltan lotes, o el syncId no existe, rechaza sin
// borrar nada (409): Apps Script puede reintentar el finalizar mas tarde una
// vez que terminen de llegar los lotes.
importarRoutes.post('/import/finalizar', async (c) => {
  if (!secretoValido(c)) {
    return c.json({ error: 'Secreto de import invalido' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const syncId = typeof body.syncId === 'string' && body.syncId.length > 0 ? body.syncId : undefined;
  const hojasLeidas = Number.isFinite(body.hojasLeidas) ? body.hojasLeidas : undefined;

  if (!syncId) {
    return c.json({ error: 'finalizar requiere syncId' }, 400);
  }

  try {
    const resumen = await finalizarImport(c.env.DB, { syncId, hojasLeidas });
    return c.json({ ok: true, ...resumen });
  } catch (err) {
    return c.json({ error: err.message }, 409);
  }
});
