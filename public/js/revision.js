// Banner de envios 'revision' (lease de relay vencido sin reporte, ver
// worker/lib/relay.js): visible en Index y Configuracion para que un admin
// decida reencolar (reintentar) o confirmar que el correo SI salio, antes de
// que el operador dispare un reintento a ciegas que podria duplicar el envio.
import { api } from './api.js';
import { esc } from './escape.js';

/**
 * Monta el banner dentro de `contenedor` (se llama en cada pagina que quiera
 * mostrarlo). Silencioso si el usuario no es admin (403) o si no hay nada en
 * revision.
 */
export async function montarBannerRevision(contenedor) {
  if (!contenedor) return;
  let envios;
  try {
    envios = await api('/api/envios/revision');
  } catch {
    contenedor.innerHTML = '';
    return; // no-admin (403) u otro error: no interrumpir la pagina por esto
  }
  pintar(contenedor, envios);
}

function pintar(contenedor, envios) {
  if (!envios || envios.length === 0) {
    contenedor.innerHTML = '';
    return;
  }
  const filas = envios
    .map(
      (e) => `<li class="d-flex align-items-center gap-2 mb-1">
        <span>${esc(e.para)} (intento tomado ${esc(e.tomado_en || '')})</span>
        <button type="button" class="btn btn-sm btn-outline-secondary btn-revision-reencolar" data-id="${esc(e.id)}">Reencolar</button>
        <button type="button" class="btn btn-sm btn-outline-success btn-revision-confirmar" data-id="${esc(e.id)}">Marcar enviado</button>
      </li>`,
    )
    .join('');

  contenedor.innerHTML = `
    <div class="alert alert-warning">
      <strong>Envío sin confirmar — revisar buzón enviados antes de reintentar.</strong>
      <p class="mb-1" style="font-size:.85rem;">
        El relay tomó estos correos hace más de 10 minutos y no reportó resultado.
        Revisa el buzón de enviados de Exchange antes de decidir: si el correo
        YA salió, usa "Marcar enviado"; si NO salió, usa "Reencolar".
      </p>
      <ul class="list-unstyled mb-0">${filas}</ul>
    </div>
  `;

  contenedor.querySelectorAll('.btn-revision-reencolar').forEach((btn) => {
    btn.addEventListener('click', () => accion(contenedor, btn.dataset.id, 'reencolar'));
  });
  contenedor.querySelectorAll('.btn-revision-confirmar').forEach((btn) => {
    btn.addEventListener('click', () => accion(contenedor, btn.dataset.id, 'confirmar'));
  });
}

async function accion(contenedor, id, tipo) {
  const mensaje = tipo === 'reencolar'
    ? 'Confirmas que el correo NO salió y hay que reencolarlo?'
    : 'Confirmas que revisaste el buzón de enviados y el correo SI salió?';
  if (!confirm(mensaje)) return;
  try {
    await api(`/api/envios/${id}/${tipo}`, { method: 'POST' });
  } catch (err) {
    alert(err.message);
  }
  await montarBannerRevision(contenedor);
}
