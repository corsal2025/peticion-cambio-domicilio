// Configuracion (solo admin): mail.mode, mail.test_email, mail.send_as, etc.
// Incluye tambien /mail/prueba: envio de prueba a mail.test_email, crea una
// peticion sintetica, la envia y la elimina (no queda rastro en el listado real).
import { Hono } from 'hono';
import { obtenerTodaLaConfig, setConfig, obtenerConfig } from '../lib/config.js';
import { construirCorreo } from '../lib/plantilla.js';
import { enviarEws } from '../lib/ews.js';

export const configRoutes = new Hono();

configRoutes.get('/config', async (c) => {
  return c.json(await obtenerTodaLaConfig(c.env.DB));
});

configRoutes.put('/config', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  for (const [clave, valor] of Object.entries(body || {})) {
    await setConfig(c.env.DB, clave, String(valor ?? ''));
  }
  return c.json({ ok: true });
});

configRoutes.post('/mail/prueba', async (c) => {
  const testEmail = await obtenerConfig(c.env.DB, 'mail.test_email');
  if (!testEmail) {
    return c.json({ error: 'Configura mail.test_email antes de probar el envio.' }, 400);
  }

  const peticionPrueba = { nombreCompleto: 'PRUEBA DE ENVIO', rut: '11.111.111-1', clases: null };
  const { asunto, cuerpo } = construirCorreo([peticionPrueba]);

  const modo = (await obtenerConfig(c.env.DB, 'mail.mode')) || 'relay';
  if (modo === 'direct') {
    try {
      await enviarEws(
        { url: c.env.EWS_URL, usuario: c.env.EWS_USER, clave: c.env.EWS_PASS, sendAs: c.env.EWS_SEND_AS },
        { to: testEmail, subject: asunto, body: cuerpo },
      );
      return c.json({ ok: true, modo, destinatario: testEmail });
    } catch (err) {
      return c.json({ ok: false, error: err.message }, 502);
    }
  }

  await c.env.DB
    .prepare('INSERT INTO envios (peticion_id, para, asunto, cuerpo_html) VALUES (NULL, ?, ?, ?)')
    .bind(testEmail, asunto, cuerpo)
    .run();
  return c.json({ ok: true, modo, destinatario: testEmail, mensaje: 'Encolado para el relay.' });
});
