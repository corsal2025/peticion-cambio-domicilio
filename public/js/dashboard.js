// Dashboard de peticiones: buscador RUT/nombre, carga manual, marcar/marcar
// todas (visibles), enviar marcadas, estado de carpeta, plazo legal.
import { api, fold } from './api.js';

const OPCIONES_CARPETA = [
  { valor: 'CAMBIO DE DOMICILIO SOLICITADO', etiqueta: '— sin subir —' },
  { valor: 'CAMBIO DOM. SUBIDO A CONASET', etiqueta: 'Subida a CONASET' },
  { valor: 'CAMBIO DOM. SUBIDO CON CORREO', etiqueta: 'Subida con correo' },
];

let peticiones = [];

const tbody = document.getElementById('tbody-peticiones');
const buscador = document.getElementById('buscador');
const buscadorInfo = document.getElementById('buscador-info');
const btnEnviar = document.getElementById('btn-enviar-marcadas');
const nMarcadas = document.getElementById('n-marcadas');
const chkTodas = document.getElementById('chk-marcar-todas');
const mensaje = document.getElementById('mensaje');

function mostrarMensaje(texto, tipo = 'info') {
  mensaje.textContent = texto;
  mensaje.className = `alert alert-${tipo}`;
  mensaje.style.display = 'block';
}

function formatearFecha(iso) {
  if (!iso) return '— sin pedir';
  const [fecha] = String(iso).split('T');
  const [y, m, d] = fecha.split('-');
  return `${d}-${m}-${y}`;
}

function textoPill(p) {
  if (p.estado === 'Enviada') return { clase: 'pill--ok', texto: 'Enviado' };
  if (p.estado === 'SinCorreoComuna') return { clase: 'pill--warn', texto: 'Sin correo comuna' };
  if (p.estado === 'Error') return { clase: 'pill--bad', texto: 'Error' };
  return { clase: 'pill--idle', texto: 'Sin enviar' };
}

function claseFila(p) {
  if (p.marcada) return 'fila-marcada';
  if (p.estado === 'Enviada') return 'fila-enviada';
  if (p.estado === 'SinCorreoComuna') return 'fila-sincorreo';
  if (p.estado === 'Error') return 'fila-error';
  if (p.rut_invalido) return 'fila-rutinvalido';
  return 'fila-pendiente';
}

function opcionActual(estadoCarpeta) {
  // Colapsa cualquier estado intermedio a "sin subir" (misma regla que worker/lib/estadoCarpeta.js).
  const finalizados = new Set(['CAMBIO DOM. SUBIDO A CONASET', 'SUBIDA A CONASET']);
  const finalizadosCorreo = new Set(['CAMBIO DOM. SUBIDO CON CORREO', 'SUBIDA CON F8', 'SUBIDA CON OFICIO']);
  if (finalizados.has(estadoCarpeta)) return 'CAMBIO DOM. SUBIDO A CONASET';
  if (finalizadosCorreo.has(estadoCarpeta)) return 'CAMBIO DOM. SUBIDO CON CORREO';
  return 'CAMBIO DE DOMICILIO SOLICITADO';
}

function pintarFila(p) {
  const pill = textoPill(p);
  const plazo = p.plazo || {};
  const plazoHtml = !plazo.inicio
    ? '<span class="plazo-txt text-muted">El reloj parte al enviar</span>'
    : `<div class="plazo ${plazo.vencido ? 'plazo--bad' : plazo.diasRestantes <= 3 ? 'plazo--warn' : 'plazo--ok'}">
         <span class="plazo-txt">${plazo.vencido ? `Vencido hace ${-plazo.diasRestantes} d.` : `Quedan ${plazo.diasRestantes} d.`}</span>
       </div>`;

  const opciones = OPCIONES_CARPETA.map(
    (o) => `<option value="${o.valor}" ${opcionActual(p.estado_carpeta) === o.valor ? 'selected' : ''}>${o.etiqueta}</option>`,
  ).join('');

  const tr = document.createElement('tr');
  tr.id = `fila-${p.id}`;
  tr.className = claseFila(p);
  tr.dataset.pendiente = p.marcada && !p.enviada_en ? '1' : p.estado !== 'Enviada' ? '1' : '0';
  tr.dataset.nombre = fold(p.nombre_completo);
  tr.dataset.rut = String(p.rut || '').replace(/[^0-9kK]/g, '').toLowerCase();

  tr.innerHTML = `
    <td class="text-center"><input type="checkbox" class="chk-marcar" ${p.marcada ? 'checked' : ''} /></td>
    <td class="dato">${p.nombre_completo}</td>
    <td class="dato num">${p.rut} ${p.rut_invalido ? '⚠' : ''}</td>
    <td class="text-center"><span class="comuna-chip">${p.comuna}</span></td>
    <td class="num">${formatearFecha(p.enviada_en)}</td>
    <td><span class="pill ${pill.clase}">${pill.texto}</span></td>
    <td>${plazoHtml}</td>
    <td>
      <select class="carpeta-select">${opciones}</select>
    </td>
    <td class="text-muted" style="font-size:.78rem;">${p.oficina || ''}</td>
  `;

  tr.querySelector('.chk-marcar').addEventListener('change', (ev) => marcar(p.id, ev.target.checked));
  tr.querySelector('.carpeta-select').addEventListener('change', (ev) => cambiarEstadoCarpeta(p.id, ev.target.value));

  return tr;
}

function pintarTabla() {
  tbody.innerHTML = '';
  if (peticiones.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-4">Sin peticiones. Agregá una manualmente o esperá la sincronización automática.</td></tr>';
  } else {
    for (const p of peticiones) tbody.appendChild(pintarFila(p));
  }
  aplicarFiltro();
  actualizarResumen();
}

function actualizarResumen() {
  const total = peticiones.length;
  const enviadas = peticiones.filter((p) => p.estado === 'Enviada').length;
  const pendientes = total - enviadas;
  const vencidas = peticiones.filter((p) => p.plazo && p.plazo.vencido).length;
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-pendientes').textContent = pendientes;
  document.getElementById('stat-enviadas').textContent = enviadas;
  document.getElementById('stat-vencidas').textContent = vencidas;

  const marcadas = peticiones.filter((p) => p.marcada && p.estado !== 'Enviada').length;
  nMarcadas.textContent = marcadas;
  btnEnviar.disabled = marcadas === 0;
}

function aplicarFiltro() {
  const q = fold(buscador.value);
  const palabras = q.split(/\s+/).filter(Boolean);
  const rutQ = q.replace(/[^0-9k]/g, '');
  let visibles = 0;
  tbody.querySelectorAll('tr[data-nombre]').forEach((tr) => {
    const ok = palabras.length === 0
      || (rutQ && tr.dataset.rut.includes(rutQ))
      || palabras.every((w) => tr.dataset.nombre.includes(w));
    tr.hidden = !ok;
    if (ok) visibles++;
  });
  buscadorInfo.textContent = palabras.length === 0 ? '' : `${visibles} de ${peticiones.length}`;
}

async function cargar() {
  peticiones = await api('/api/peticiones');
  pintarTabla();
}

async function marcar(id, marcada) {
  await api(`/api/peticiones/${id}`, { method: 'PATCH', body: JSON.stringify({ marcada }) });
  const p = peticiones.find((x) => x.id === id);
  if (p) p.marcada = marcada ? 1 : 0;
  pintarTabla();
}

async function cambiarEstadoCarpeta(id, estadoCarpeta) {
  await api(`/api/peticiones/${id}`, { method: 'PATCH', body: JSON.stringify({ estado_carpeta: estadoCarpeta }) });
  await cargar();
}

buscador.addEventListener('input', aplicarFiltro);

chkTodas.addEventListener('change', async () => {
  const deseada = chkTodas.checked;
  const idsVisibles = [...tbody.querySelectorAll('tr[data-nombre]:not([hidden])')]
    .map((tr) => Number(tr.id.replace('fila-', '')))
    .filter((id) => {
      const p = peticiones.find((x) => x.id === id);
      return p && p.estado !== 'Enviada';
    });
  if (idsVisibles.length === 0) return;
  await api('/api/peticiones/marcar-todas', { method: 'POST', body: JSON.stringify({ ids: idsVisibles, marcada: deseada }) });
  await cargar();
});

btnEnviar.addEventListener('click', async () => {
  if (!confirm('Se envía UN correo por comuna con las personas MARCADAS de esa comuna. ¿Continuar?')) return;
  btnEnviar.disabled = true;
  btnEnviar.textContent = 'Enviando… puede tardar unos segundos';
  try {
    const resumen = await api('/api/peticiones/enviar', { method: 'POST' });
    mostrarMensaje(`Encolados ${resumen.encolados} correo(s)${resumen.sinCorreo ? `; ${resumen.sinCorreo} comuna(s) sin correo` : ''}.`, 'info');
  } catch (err) {
    mostrarMensaje(err.message, 'danger');
  } finally {
    btnEnviar.textContent = 'Enviar marcadas (0)';
    await cargar();
  }
});

document.getElementById('form-manual').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const datos = Object.fromEntries(new FormData(form));
  try {
    await api('/api/peticiones', { method: 'POST', body: JSON.stringify(datos) });
    form.reset();
    await cargar();
  } catch (err) {
    mostrarMensaje(err.message, 'danger');
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

cargar().catch((err) => mostrarMensaje(err.message, 'danger'));
