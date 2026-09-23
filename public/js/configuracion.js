import { api } from './api.js';
import { esc } from './escape.js';

const form = document.getElementById('form-config');
const mensaje = document.getElementById('mensaje');

function mostrar(texto, tipo = 'info') {
  mensaje.textContent = texto;
  mensaje.className = `alert alert-${tipo}`;
  mensaje.style.display = 'block';
}

async function cargarConfig() {
  const config = await api('/api/config');
  for (const [clave, valor] of Object.entries(config)) {
    const campo = form.elements.namedItem(clave);
    if (campo) campo.value = valor;
  }
}

async function cargarUsuarios() {
  const usuarios = await api('/api/usuarios');
  document.getElementById('lista-usuarios').innerHTML = usuarios
    .map((u) => `<li>${esc(u.usuario)} — ${esc(u.rol)}${u.nombre ? ` (${esc(u.nombre)})` : ''}</li>`)
    .join('');
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const datos = Object.fromEntries(new FormData(form));
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(datos) });
    mostrar('Configuración guardada.', 'success');
  } catch (err) {
    mostrar(err.message, 'danger');
  }
});

document.getElementById('btn-prueba').addEventListener('click', async () => {
  try {
    const res = await api('/api/mail/prueba', { method: 'POST' });
    mostrar(res.mensaje || `Prueba enviada a ${res.destinatario}.`, 'success');
  } catch (err) {
    mostrar(err.message, 'danger');
  }
});

document.getElementById('form-usuario').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const datos = Object.fromEntries(new FormData(ev.target));
  try {
    await api('/api/usuarios', { method: 'POST', body: JSON.stringify(datos) });
    ev.target.reset();
    await cargarUsuarios();
  } catch (err) {
    mostrar(err.message, 'danger');
  }
});

cargarConfig();
cargarUsuarios();
