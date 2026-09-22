// Metricas agregadas: conteo por estado, por comuna, vencidas vs en plazo.
import { Hono } from 'hono';
import { listarPeticiones } from '../lib/peticiones.js';
import { plazoInfo } from '../lib/plazos.js';

export const estadisticasRoutes = new Hono();

estadisticasRoutes.get('/estadisticas', async (c) => {
  const filas = await listarPeticiones(c.env.DB);

  const porEstado = {};
  const porComuna = {};
  let vencidas = 0;
  let enPlazo = 0;

  for (const p of filas) {
    porEstado[p.estado] = (porEstado[p.estado] || 0) + 1;
    porComuna[p.comuna] = (porComuna[p.comuna] || 0) + 1;
    const { vencido } = plazoInfo({ enviadaEn: p.enviada_en });
    if (p.enviada_en) {
      vencido ? vencidas++ : enPlazo++;
    }
  }

  return c.json({ total: filas.length, porEstado, porComuna, vencidas, enPlazo });
});
