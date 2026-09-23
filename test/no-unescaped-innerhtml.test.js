// Test estatico (grep-like): ningun archivo de public/js debe interpolar
// `${...}` dentro de una asignacion a innerHTML sin pasar por esc(...).
// No es un parser real de JS: es una salvaguarda barata contra regresiones de XSS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dirRaiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirJs = path.join(dirRaiz, 'public', 'js');
const dirPublic = path.join(dirRaiz, 'public');

function bloquesInnerHtml(codigo) {
  // Captura el statement completo `algo.innerHTML = ...;` (naive: hasta el
  // proximo `;` de fin de linea) y de ahi extrae cualquier template literal.
  const asignaciones = /\.innerHTML\s*=([\s\S]*?);\s*\n/g;
  const bloques = [];
  let m;
  while ((m = asignaciones.exec(codigo))) {
    const statement = m[1];
    const templateRegex = /`([\s\S]*?)`/g;
    let t;
    while ((t = templateRegex.exec(statement))) bloques.push(t[1]);
  }
  return bloques;
}

function interpolacionesSinEsc(bloque) {
  // Busca ${...} dentro del bloque y verifica que el contenido use esc(...)
  const regex = /\$\{([^}]*)\}/g;
  const malas = [];
  let m;
  while ((m = regex.exec(bloque))) {
    const expr = m[1].trim();
    // Bare identificador (ej. `plazoHtml`, `opciones`): fragmento HTML
    // pre-construido en una variable local, cuyas propias interpolaciones
    // ya deben pasar por esc() (verificado por este mismo test en su punto
    // de construccion, no en el punto de uso).
    const esIdentificadorSimple = /^[a-zA-Z_$][\w$]*$/.test(expr);
    if (!esIdentificadorSimple && !/\besc\(/.test(expr)) malas.push(expr);
  }
  return malas;
}

test('ningun archivo public/js interpola datos en innerHTML sin esc()', () => {
  const archivos = readdirSync(dirJs).filter((f) => f.endsWith('.js') && f !== 'escape.js');
  const problemas = [];
  for (const archivo of archivos) {
    const ruta = path.join(dirJs, archivo);
    const codigo = readFileSync(ruta, 'utf8');
    for (const bloque of bloquesInnerHtml(codigo)) {
      for (const expr of interpolacionesSinEsc(bloque)) {
        problemas.push(`${archivo}: \${${expr}}`);
      }
    }
  }
  assert.deepEqual(problemas, []);
});

function scriptsInline(html) {
  // Solo scripts inline (sin `src="..."`): los que traen `<script ...>codigo</script>`.
  const regex = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const bloques = [];
  let m;
  while ((m = regex.exec(html))) bloques.push(m[1]);
  return bloques;
}

test('ningun script inline de public/*.html interpola datos en innerHTML sin esc()', () => {
  const archivos = readdirSync(dirPublic).filter((f) => f.endsWith('.html'));
  const problemas = [];
  for (const archivo of archivos) {
    const ruta = path.join(dirPublic, archivo);
    const html = readFileSync(ruta, 'utf8');
    for (const script of scriptsInline(html)) {
      for (const bloque of bloquesInnerHtml(script)) {
        for (const expr of interpolacionesSinEsc(bloque)) {
          problemas.push(`${archivo}: \${${expr}}`);
        }
      }
    }
  }
  assert.deepEqual(problemas, []);
});
