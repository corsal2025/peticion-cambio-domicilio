import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Un catch-all en la raiz (functions/[[path]].js) hace que Hono atienda tambien
// /, /index.html, /login.html... y responda 404 en vez de dejar que Pages sirva
// public/. La funcion debe vivir bajo functions/api/ para cubrir solo /api/*.
test('la Pages Function solo atiende /api/* (las paginas las sirve public/)', () => {
  assert.equal(existsSync(new URL('../functions/[[path]].js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../functions/api/[[path]].js', import.meta.url)), true);
});
