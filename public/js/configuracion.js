import { api } from './api.js';
import { esc } from './escape.js';
import { montarBannerRevision } from './revision.js';
import { montarToggleClave } from './passwordToggle.js';

const form = document.getElementById('form-config');
const mensaje = document.getElementById('mensaje');
const tbodyUsuarios = document.getElementById('tbody-usuarios');
const formMiClave = document.getElementById('form-mi-clave');
const formUsuario = document.getElementById('form-usuario');

function mostrar(texto, tipo = 'info') {
  mensaje.textContent = texto;
  mensaje.className = `alert alert-${tipo}`;
  mensaje.style.display = 'block';
}

/** Agrega el boton 👁 a todo input[type=password] dentro de `raiz` que todavia no lo tenga. */
function montarTogglesClave(raiz) {
  raiz.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.toggleClave) return;
    input.dataset.toggleClave = '1';
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'btn btn-outline-secondary btn-toggle-clave';
    input.insertAdjacentElement('afterend', boton);
    montarToggleClave(input, boton);
  });
}

async function cargarConfig() {
  const config = await api('/api/config');
  for (const [clave, valor] of Object.entries(config)) {
    const campo = form.elements.namedItem(clave);
    if (campo) campo.value = valor;
  }
}

/**
 * Pinta la tabla de usuarios (admin only): edicion de nombre/rol/activo,
 * restablecer clave y eliminar. Cada `${...}` de datos va con esc(); los
 * `selected`/`checked` condicionales tambien se envuelven en esc(...) (mismo
 * patron que public/js/dashboard.js) para que sigan siendo texto controlado,
 * no HTML libre.
 */
async function cargarUsuarios() {
  const usuarios = await api('/api/usuarios');
  tbodyUsuarios.innerHTML = usuarios.map((u) => `
    <tr data-id="${esc(u.id)}" data-usuario="${esc(u.usuario)}">
      <td>${esc(u.usuario)}</td>
      <td><input class="form-control form-control-sm campo-nombre" value="${esc(u.nombre || '')}" /></td>
      <td>
        <select class="form-select form-select-sm campo-rol">
          <option value="staff" ${esc(u.rol === 'staff' ? 'selected' : '')}>staff</option>
          <option value="admin" ${esc(u.rol === 'admin' ? 'selected' : '')}>admin</option>
        </select>
      </td>
      <td class="text-center"><input type="checkbox" class="form-check-input campo-activo" ${esc(u.activo ? 'checked' : '')} /></td>
      <td>
        <div class="d-flex gap-1 flex-wrap align-items-center">
          <button type="button" class="btn btn-sm btn-outline-primary btn-guardar">Guardar</button>
          <input type="password" class="form-control form-control-sm campo-clave-nueva" placeholder="clave nueva" style="max-width:110px;" autocomplete="new-password" />
          <button type="button" class="btn btn-sm btn-outline-secondary btn-reset-clave">Restablecer clave</button>
          <button type="button" class="btn btn-sm btn-outline-danger btn-eliminar">Eliminar</button>
        </div>
      </td>
    </tr>
  `).join('');

  montarTogglesClave(tbodyUsuarios);

  tbodyUsuarios.querySelectorAll('tr[data-id]').forEach((fila) => {
    const id = fila.dataset.id;

    fila.querySelector('.btn-guardar').addEventListener('click', async () => {
      const datos = {
        nombre: fila.querySelector('.campo-nombre').value,
        rol: fila.querySelector('.campo-rol').value,
        activo: fila.querySelector('.campo-activo').checked,
      };
      try {
        await api(`/api/usuarios/${id}`, { method: 'PUT', body: JSON.stringify(datos) });
        mostrar('Usuario actualizado.', 'success');
        await cargarUsuarios();
      } catch (err) {
        mostrar(err.message, 'danger');
      }
    });

    fila.querySelector('.btn-reset-clave').addEventListener('click', async () => {
      const claveNueva = fila.querySelector('.campo-clave-nueva').value;
      if (!claveNueva) {
        mostrar('Escribe la clave nueva antes de restablecer.', 'danger');
        return;
      }
      try {
        await api(`/api/usuarios/${id}/clave`, { method: 'POST', body: JSON.stringify({ clave: claveNueva }) });
        mostrar('Clave restablecida.', 'success');
        await cargarUsuarios();
      } catch (err) {
        mostrar(err.message, 'danger');
      }
    });

    fila.querySelector('.btn-eliminar').addEventListener('click', async () => {
      if (!confirm(`¿Eliminar al usuario "${fila.dataset.usuario}"?`)) return;
      try {
        await api(`/api/usuarios/${id}`, { method: 'DELETE' });
        mostrar('Usuario eliminado.', 'success');
        await cargarUsuarios();
      } catch (err) {
        mostrar(err.message, 'danger');
      }
    });
  });
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

formUsuario.addEventListener('submit', async (ev) => {
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

formMiClave.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const datos = Object.fromEntries(new FormData(ev.target));
  try {
    await api('/api/auth/clave', { method: 'POST', body: JSON.stringify(datos) });
    ev.target.reset();
    mostrar('Tu clave fue actualizada.', 'success');
  } catch (err) {
    mostrar(err.message, 'danger');
  }
});

montarTogglesClave(formMiClave);
montarTogglesClave(formUsuario);

// Las secciones de config/usuarios son solo-admin en el backend (soloAdmin);
// si entra un staff a esta pagina esas dos llamadas responden 403 pero el
// formulario "Mi clave" (POST /api/auth/clave, cualquier sesion valida) debe
// seguir funcionando igual.
cargarConfig().catch(() => {});
cargarUsuarios().catch(() => {});
montarBannerRevision(document.getElementById('banner-revision'));
