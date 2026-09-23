// Renderiza /api/estadisticas. Port 1:1 del layout de
// PeticionCambioDomicilio/Pages/Estadisticas.cshtml: mismos chips, mismo
// ranking de volumen (barras), mismo split "quien sube la carpeta" y misma
// tabla por comuna con barra de % en plazo.
import { api } from './api.js';
import { esc } from './escape.js';

function pct(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v)}%`;
}

function dias(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v * 10) / 10} d.`;
}

function renderRankingVolumen(ranking, volumenMaximo) {
  return ranking
    .map(({ comuna, cantidad }) => {
      const ancho = Math.round((cantidad * 100) / volumenMaximo);
      return `
        <div class="d-flex align-items-center gap-2 mb-2">
          <span class="text-end text-muted" style="width:130px; font-size:.8rem;">${esc(comuna)}</span>
          <div class="barra-track flex-grow-1">
            <i style="width:${esc(ancho)}%"></i>
          </div>
          <span class="num fw-bold" style="width:26px; font-size:.8rem;">${esc(cantidad)}</span>
        </div>`;
    })
    .join('');
}

function renderSplitSubida(subioComuna, subimosNosotros, abiertas) {
  const totalClasif = subioComuna + subimosNosotros;
  const pComuna = totalClasif > 0 ? Math.round((subioComuna * 100) / totalClasif) : 0;
  const barra =
    totalClasif === 0
      ? '<i class="s-idle" style="width:100%"></i>'
      : `<i class="s-ok" style="width:${esc(pComuna)}%"></i><i class="s-bad" style="width:${esc(100 - pComuna)}%"></i>`;

  return `
    <div class="barra-split mb-3">${barra}</div>
    <div class="d-flex justify-content-between mb-2" style="font-size:.82rem;">
      <span><span class="cuadro s-ok"></span> La subió la comuna (SGL)</span>
      <span class="num fw-bold">${esc(subioComuna)}</span>
    </div>
    <div class="d-flex justify-content-between mb-2" style="font-size:.82rem;">
      <span><span class="cuadro s-bad"></span> La subimos nosotros (F8 / oficio / correo)</span>
      <span class="num fw-bold">${esc(subimosNosotros)}</span>
    </div>
    <div class="d-flex justify-content-between text-muted" style="font-size:.82rem;">
      <span><span class="cuadro s-idle"></span> Todavía abiertas</span>
      <span class="num fw-bold">${esc(abiertas)}</span>
    </div>`;
}

function celdaPorcentajeEnPlazo(porcentajeEnPlazo) {
  if (porcentajeEnPlazo === null || porcentajeEnPlazo === undefined) {
    return '<span class="text-muted" style="font-size:.8rem;">sin cerrar</span>';
  }
  const valor = Math.round(porcentajeEnPlazo);
  const color = valor >= 80 ? 'var(--ok-rail)' : valor >= 50 ? 'var(--warn-rail)' : 'var(--bad-rail)';
  return `
    <div class="d-flex align-items-center gap-2">
      <div class="barra-track flex-grow-1"><i style="width:${esc(valor)}%; background:${color}"></i></div>
      <span class="num text-muted" style="font-size:.78rem; width:34px;">${esc(valor)}%</span>
    </div>`;
}

function renderTablaComunas(porComuna) {
  return porComuna
    .map((c) => {
      const claseNosotros = c.subimosNosotros > 0 ? 'fw-bold' : '';
      const estiloNosotros = c.subimosNosotros > 0 ? 'style="color:var(--warn-ink)"' : '';
      return `
        <tr class="fila-pendiente">
          <td class="dato text-start">${esc(c.comuna)}</td>
          <td class="num">${esc(c.solicitadas)}</td>
          <td class="num">${esc(c.subioComuna)}</td>
          <td class="num ${claseNosotros}" ${estiloNosotros}>${esc(c.subimosNosotros)}</td>
          <td class="num fw-bold">${esc(dias(c.demoraPromedio))}</td>
          <td>${celdaPorcentajeEnPlazo(c.porcentajeEnPlazo)}</td>
        </tr>`;
    })
    .join('');
}

const datos = await api('/api/estadisticas');

if (datos.totalEnviadas === 0) {
  document.getElementById('sin-datos').classList.remove('d-none');
} else {
  document.getElementById('contenido').classList.remove('d-none');

  document.getElementById('s-total').textContent = datos.totalEnviadas;
  document.getElementById('s-comunas').textContent = datos.comunasConEnvios;
  document.getElementById('s-enplazo').textContent = pct(datos.porcentajeEnPlazo);
  document.getElementById('s-demora').textContent = dias(datos.demoraPromedio);
  document.getElementById('s-nosotros').textContent = datos.subimosNosotros;
  document.getElementById('s-abiertas').textContent = datos.abiertas;
  document.getElementById('s-cerradas').textContent = datos.cerradas;

  document.getElementById('ranking-volumen').innerHTML = renderRankingVolumen(
    datos.rankingVolumen,
    datos.volumenMaximo,
  );
  document.getElementById('split-subida').innerHTML = renderSplitSubida(
    datos.subioComuna,
    datos.subimosNosotros,
    datos.abiertas,
  );
  document.getElementById('tabla-comunas').innerHTML = renderTablaComunas(datos.porComuna);
}
