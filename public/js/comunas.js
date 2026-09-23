import { api } from './api.js';

const tbody = document.getElementById('tbody-comunas');

async function cargar() {
  const comunas = await api('/api/comunas');
  tbody.innerHTML = comunas.map((c) => `
    <tr>
      <td>${c.nombre}</td>
      <td>${c.correos || '<span class="text-muted">sin correo</span>'}</td>
      <td>${c.contacto || ''}</td>
      <td><button class="btn btn-sm btn-outline-danger" data-id="${c.id}">Eliminar</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/comunas/${btn.dataset.id}`, { method: 'DELETE' });
      await cargar();
    });
  });
}

document.getElementById('form-alta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const datos = Object.fromEntries(new FormData(ev.target));
  await api('/api/comunas', { method: 'POST', body: JSON.stringify(datos) });
  ev.target.reset();
  await cargar();
});

document.getElementById('form-import').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const archivo = document.getElementById('csv-file').files[0];
  const info = document.getElementById('import-info');
  if (!archivo) return;
  const csv = await archivo.text();
  const resumen = await api('/api/comunas/import', { method: 'POST', body: JSON.stringify({ csv }) });
  info.textContent = `${resumen.insertadas} nuevas, ${resumen.actualizadas} actualizadas`;
  await cargar();
});

cargar();
