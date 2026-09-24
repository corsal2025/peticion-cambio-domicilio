// POST /api/import: recibe filas filtradas desde Apps Script y hace upsert
// idempotente (nunca borra). POST /api/import/finalizar: cierra una
// sincronizacion y recien ahi ejecuta la limpieza de obsoletas, usando el
// acumulado de claves CD (`clavesCD`) de TODOS los lotes de esa
// sincronizacion, acumulado en memoria del lado de Apps Script y enviado
// completo en este ultimo POST (el libro real tiene ~4400 filas relevantes y
// Apps Script siempre reparte el envio en varios POST /api/import). Tambien
// escribe la UNICA fila de sync_log de esta corrida (antes se escribia una
// por lote). Autenticado por secreto compartido (header X-Import-Secret), NO
// por sesion de usuario (Apps Script no tiene cookie).
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

  try {
    // No se escribe sync_log aca: una fila por lote (~25 por sync cada 15 min)
    // era, junto a import_vistos/import_lotes, buena parte de las escrituras
    // que agotaban el limite diario de D1 free tier. La UNICA fila de
    // sync_log de esta corrida se escribe en /import/finalizar.
    const resumen = await importarFilas(c.env.DB, filas);
    return c.json({ ok: true, ...resumen });
  } catch (err) {
    const esRechazoPorVolumen = /Lote rechazado/i.test(err.message);
    return c.json({ error: err.message }, esRechazoPorVolumen ? 422 : 400);
  }
});

// Cierra la sincronizacion: ejecuta la limpieza de obsoletas usando el
// acumulado de `clavesCD` de todos los lotes (Apps Script las junta en
// memoria y las manda completas aca) y escribe la UNICA fila de sync_log de
// toda la corrida, con los totales acumulados que Apps Script tambien manda.
importarRoutes.post('/import/finalizar', async (c) => {
  if (!secretoValido(c)) {
    return c.json({ error: 'Secreto de import invalido' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const clavesCD = Array.isArray(body.clavesCD) ? body.clavesCD : [];
  const hojasLeidas = Number.isFinite(body.hojasLeidas) ? body.hojasLeidas : undefined;
  const recibidas = Number.isFinite(body.recibidas) ? body.recibidas : 0;
  const insertadas = Number.isFinite(body.insertadas) ? body.insertadas : 0;
  const actualizadas = Number.isFinite(body.actualizadas) ? body.actualizadas : 0;

  try {
    const resumen = await finalizarImport(c.env.DB, { clavesCD, hojasLeidas });
    await c.env.DB
      .prepare('INSERT INTO sync_log (fuente, recibidas, insertadas, actualizadas, errores) VALUES (?, ?, ?, ?, ?)')
      .bind('apps-script', recibidas, insertadas, actualizadas, resumen.avisos.length)
      .run();
    return c.json({ ok: true, ...resumen });
  } catch (err) {
    return c.json({ error: err.message }, 409);
  }
});
