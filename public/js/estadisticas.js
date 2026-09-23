import { api } from './api.js';
import { esc } from './escape.js';

const datos = await api('/api/estadisticas');

document.getElementById('s-total').textContent = datos.total;
document.getElementById('s-enplazo').textContent = datos.enPlazo;
document.getElementById('s-vencidas').textContent = datos.vencidas;

document.getElementById('lista-estado').innerHTML = Object.entries(datos.porEstado)
  .map(([estado, n]) => `<li>${esc(estado)}: <b>${esc(n)}</b></li>`)
  .join('');

document.getElementById('lista-comuna').innerHTML = Object.entries(datos.porComuna)
  .map(([comuna, n]) => `<li>${esc(comuna)}: <b>${esc(n)}</b></li>`)
  .join('');
