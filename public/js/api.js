// Helper fetch compartido: cookies de sesion siempre incluidas, 401 -> login.
export async function api(url, opciones = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opciones.headers || {}) },
    ...opciones,
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Sesion requerida');
  }
  const texto = await res.text();
  const cuerpo = texto ? JSON.parse(texto) : null;
  if (!res.ok) {
    throw new Error((cuerpo && cuerpo.error) || `Error HTTP ${res.status}`);
  }
  return cuerpo;
}

export function fold(value) {
  if (!value) return '';
  return value
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
