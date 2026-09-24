// Helper de escape HTML compartido: usar SIEMPRE que se interpole un valor
// dentro de un template literal que termine en innerHTML/insertAdjacentHTML.
// Evita XSS almacenado con datos que vienen de Excel/Apps Script o alta manual.
const MAPA = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/[&<>"']/g, (ch) => MAPA[ch]);
}
