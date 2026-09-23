// Metricas de la pagina "Estadisticas". Port 1:1 de
// PeticionCambioDomicilio.Pages.EstadisticasModel (C#): mismas formulas de
// demora habil (dias habiles entre el envio del correo y la fecha en que la
// carpeta figuro como subida), mismo ranking de volumen (top 12) y misma
// tabla "por comuna" (orden por demora promedio desc, sin cerrar al final).
import { fold } from './normalizar.js';
import { businessDaysBetween, fechaLocalSantiago, PLAZO_DIAS_HABILES } from './plazos.js';
import { subidaPorComuna, subidaPorNosotros } from './estadoCarpeta.js';

/** Dias habiles entre el envio y la subida de una fila (null si sigue abierta). */
function demoraHabiles(fila) {
  if (!fila.enviada_en || !fila.subida_en) {
    return null;
  }
  const inicio = fechaLocalSantiago(new Date(fila.enviada_en));
  const subida = String(fila.subida_en).slice(0, 10);
  if (subida <= inicio) {
    return 0;
  }
  return businessDaysBetween(inicio, subida);
}

function promedio(valores) {
  return valores.length > 0 ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
}

/**
 * Calcula todas las metricas de la pagina de estadisticas.
 * @param {Array<{comuna: string, enviada_en: string|null, subida_en: string|null, estado_carpeta: string}>} filas
 *   filas YA filtradas por estado = 'Enviada' AND enviada_en IS NOT NULL (ver worker/routes/estadisticas.js).
 */
export function calcularEstadisticas(filas) {
  const totalEnviadas = filas.length;

  const comunasSet = new Set(filas.map((f) => fold(f.comuna)));
  const comunasConEnvios = comunasSet.size;

  const cerradas = filas.filter((f) => f.subida_en);
  const abiertas = totalEnviadas - cerradas.length;
  const subioComuna = cerradas.filter((f) => subidaPorComuna(f.estado_carpeta)).length;
  const subimosNosotros = cerradas.filter((f) => subidaPorNosotros(f.estado_carpeta)).length;

  const demoras = cerradas.map(demoraHabiles).filter((d) => d !== null);
  let demoraPromedio = null;
  let dentroDePlazo = 0;
  let porcentajeEnPlazo = null;
  if (demoras.length > 0) {
    demoraPromedio = promedio(demoras);
    dentroDePlazo = demoras.filter((d) => d <= PLAZO_DIAS_HABILES).length;
    porcentajeEnPlazo = (dentroDePlazo / demoras.length) * 100;
  }

  // Ranking de volumen: top 12 comunas por cantidad de carpetas pedidas.
  const conteoPorComuna = new Map();
  for (const f of filas) {
    const key = fold(f.comuna);
    const entry = conteoPorComuna.get(key);
    if (entry) {
      entry.cantidad++;
    } else {
      conteoPorComuna.set(key, { comuna: f.comuna, cantidad: 1 });
    }
  }
  const rankingVolumen = [...conteoPorComuna.values()]
    .sort((a, b) => b.cantidad - a.cantidad || a.comuna.localeCompare(b.comuna, 'es'))
    .slice(0, 12);
  const volumenMaximo = rankingVolumen.length > 0 ? Math.max(...rankingVolumen.map((r) => r.cantidad)) : 1;

  // Tabla por comuna: todas las comunas, con su propia demora y % en plazo.
  const grupos = new Map();
  for (const f of filas) {
    const key = fold(f.comuna);
    let g = grupos.get(key);
    if (!g) {
      g = { comuna: f.comuna, filas: [] };
      grupos.set(key, g);
    }
    g.filas.push(f);
  }
  const porComuna = [...grupos.values()]
    .map(({ comuna, filas: fs }) => {
      const cerr = fs.filter((f) => f.subida_en);
      const ds = cerr.map(demoraHabiles).filter((d) => d !== null);
      const demoraProm = promedio(ds);
      const pctPlazo = ds.length > 0 ? (ds.filter((d) => d <= PLAZO_DIAS_HABILES).length / ds.length) * 100 : null;
      return {
        comuna,
        solicitadas: fs.length,
        subioComuna: cerr.filter((f) => subidaPorComuna(f.estado_carpeta)).length,
        subimosNosotros: cerr.filter((f) => subidaPorNosotros(f.estado_carpeta)).length,
        cerradas: cerr.length,
        demoraPromedio: demoraProm,
        porcentajeEnPlazo: pctPlazo,
      };
    })
    .sort((a, b) => {
      const da = a.demoraPromedio ?? -1;
      const db_ = b.demoraPromedio ?? -1;
      if (db_ !== da) return db_ - da;
      if (b.solicitadas !== a.solicitadas) return b.solicitadas - a.solicitadas;
      return a.comuna.localeCompare(b.comuna, 'es');
    });

  return {
    totalEnviadas,
    comunasConEnvios,
    cerradas: cerradas.length,
    abiertas,
    subioComuna,
    subimosNosotros,
    dentroDePlazo,
    porcentajeEnPlazo,
    demoraPromedio,
    rankingVolumen,
    volumenMaximo,
    porComuna,
  };
}
