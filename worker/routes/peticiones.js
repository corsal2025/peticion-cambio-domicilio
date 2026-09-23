// CRUD de peticiones + buscador + marcar/marcar todas + envio agrupado por comuna.
// Todas estas rutas viven detras del guard de sesion (worker/routes/auth.js).
import { Hono } from 'hono';
import { normalizeAndValidate } from '../lib/rut.js';
import { upsertPeticion, listarPeticiones, marcarPeticion, marcarTodas } from '../lib/peticiones.js';
import { obtenerConfig, resolverSendAs } from '../lib/config.js';
import { listarComunas } from '../lib/comunas.js';
import { prepararEnvios, encolarEnvios, enviarDirecto } from '../lib/mail.js';
import { plazoInfo } from '../lib/plazos.js';
import { fold } from '../lib/normalizar.js';

export const peticionesRoutes = new Hono();

function conPlazo(p) {
  return { ...p, plazo: plazoInfo({ enviadaEn: p.enviada_en }) };
}

peticionesRoutes.get('/peticiones', async (c) => {
  const db = c.env.DB;
  const busqueda = c.req.query('busqueda') || '';
  const filas = await listarPeticiones(db, { busqueda });
  return c.json(filas.map(conPlazo));
});

// Alta manual: NOMBRE, RUT, COMUNA a mano. Oficina="MANUAL", Origen="Ingreso
// manual". El RUT se valida pero no bloquea el guardado (RutInvalido=true si no calza).
peticionesRoutes.post('/peticiones', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const { nombre, rut, comuna } = body || {};
  if (!nombre || !rut || !comuna) {
    return c.json({ error: 'Faltan nombre, rut o comuna' }, 400);
  }

  const rutValidado = normalizeAndValidate(rut);
  const { id, creada } = await upsertPeticion(db, {
    nombreCompleto: nombre,
    rut: rutValidado ?? rut,
    comuna,
    oficina: 'MANUAL',
    origen: 'Ingreso manual',
    rutInvalido: rutValidado === null,
  });

  return c.json({ id, creada, rutInvalido: rutValidado === null }, 201);
});

peticionesRoutes.patch('/peticiones/:id', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));

  if (typeof body.marcada === 'boolean') {
    await marcarPeticion(db, id, body.marcada);
  }
  if (typeof body.estado_carpeta === 'string') {
    await db.prepare('UPDATE peticiones SET estado_carpeta = ? WHERE id = ?').bind(body.estado_carpeta, id).run();
  }

  const actualizada = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(id).first();
  if (!actualizada) return c.json({ error: 'Peticion no encontrada' }, 404);
  return c.json(conPlazo(actualizada));
});

peticionesRoutes.post('/peticiones/marcar-todas', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const marcada = Boolean(body.marcada);
  await marcarTodas(db, ids, marcada);
  return c.json({ ok: true, actualizadas: ids.length });
});

/** Enviar marcadas: agrupa pendientes por comuna, respeta MAIL_MODE (relay|direct) y test_email. */
peticionesRoutes.post('/peticiones/enviar', async (c) => {
  const db = c.env.DB;
  const todas = await listarPeticiones(db);
  const pendientes = todas.filter((p) => p.marcada && !p.enviada_en);
  if (pendientes.length === 0) {
    return c.json({ ok: true, enviados: 0, mensaje: 'No hay peticiones marcadas pendientes de envio.' });
  }

  const comunas = await listarComunas(db);
  const correoPorComunaNorm = Object.fromEntries(comunas.map((cc) => [fold(cc.nombre), cc.correos]));
  const testEmail = await obtenerConfig(db, 'mail.test_email');

  const envios = prepararEnvios(pendientes, {
    correosPorComuna: correoPorComunaNorm,
    testEmail,
  });

  const sinCorreo = envios.filter((e) => !e.para);
  const conCorreo = envios.filter((e) => e.para);
  for (const e of sinCorreo) {
    for (const id of e.peticionIds) {
      await db.prepare("UPDATE peticiones SET estado = 'SinCorreoComuna' WHERE id = ?").bind(id).run();
    }
  }

  await encolarEnvios(db, conCorreo);

  const modo = (await obtenerConfig(db, 'mail.mode')) || 'relay';
  if (modo === 'direct') {
    const sendAs = await resolverSendAs(db, c.env.EWS_SEND_AS);
    const ewsOpciones = { url: c.env.EWS_URL, usuario: c.env.EWS_USER, clave: c.env.EWS_PASS, sendAs };
    const { results: pendientesRecien } = await db.prepare("SELECT * FROM envios WHERE estado = 'pendiente'").all();
    for (const envio of pendientesRecien) {
      await enviarDirecto(db, envio, ewsOpciones);
    }
  }

  return c.json({ ok: true, encolados: conCorreo.length, sinCorreo: sinCorreo.length, modo });
});
