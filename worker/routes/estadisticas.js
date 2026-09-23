// Estadisticas: como responden las comunas. Port 1:1 de
// PeticionCambioDomicilio.Pages.EstadisticasModel (C#) — mismos totales,
// mismo ranking de volumen y misma tabla "por comuna" (demora habil desde el
// envio del correo hasta que la carpeta figura como subida en el Excel /
// dashboard, columna ESTADO DE LA CARPETA).
//
// Presupuesto D1: UN solo SELECT (constante, no depende del volumen de
// filas); toda la agregacion se hace en JS (worker/lib/estadisticasCalc.js),
// igual que el LINQ in-memory del .NET original.
import { Hono } from 'hono';
import { calcularEstadisticas } from '../lib/estadisticasCalc.js';

export const estadisticasRoutes = new Hono();

estadisticasRoutes.get('/estadisticas', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT comuna, enviada_en, subida_en, estado_carpeta
       FROM peticiones
      WHERE estado = 'Enviada' AND enviada_en IS NOT NULL`,
  ).all();

  return c.json(calcularEstadisticas(results));
});
