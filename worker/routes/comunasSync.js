// POST /api/comunas/sync: recibe el directorio de correos municipales desde
// Apps Script (hoja "CORREOS CAMBIO DE DOMICLIO", ver apps-script/Code.gs) y
// hace upsert (nunca borra), paridad con ComunaDirectory.AddOrUpdate. Se
// autentica por secreto compartido (header X-Import-Secret, MISMO secreto
// que /api/import), NO por sesion de usuario -- Apps Script no tiene cookie.
// Se registra un renglon en sync_log por cada sincronizacion, igual que
// /api/import, para poder diagnosticar "Apps Script nunca llego al worker"
// revisando si la tabla esta vacia (ver DEPLOY-CLOUDFLARE.md seccion 6).
import { Hono } from 'hono';
import { sincronizarContactos } from '../lib/comunas.js';
import { timingSafeEqual } from '../lib/seguridad.js';

function secretoValido(c) {
  const secreto = c.req.header('X-Import-Secret') || '';
  return Boolean(c.env.IMPORT_SECRET) && timingSafeEqual(secreto, c.env.IMPORT_SECRET);
}

export const comunasSyncRoutes = new Hono();

comunasSyncRoutes.post('/comunas/sync', async (c) => {
  if (!secretoValido(c)) {
    return c.json({ error: 'Secreto de import invalido' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const contactos = Array.isArray(body.contactos) ? body.contactos : [];

  const resumen = await sincronizarContactos(c.env.DB, contactos);
  await c.env.DB
    .prepare('INSERT INTO sync_log (fuente, recibidas, insertadas, actualizadas, errores) VALUES (?, ?, ?, ?, ?)')
    .bind('apps-script-comunas', resumen.leidos, resumen.nuevos, resumen.actualizados, 0)
    .run();

  return c.json({ ok: true, ...resumen });
});
