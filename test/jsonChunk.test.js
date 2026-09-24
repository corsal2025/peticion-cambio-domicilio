import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkPorTamano } from '../worker/lib/jsonChunk.js';

test('chunkPorTamano con arreglo vacio devuelve []', () => {
  assert.deepEqual(chunkPorTamano([]), []);
});

test('chunkPorTamano no parte si todo entra en un chunk', () => {
  const items = [{ a: 1 }, { a: 2 }, { a: 3 }];
  const chunks = chunkPorTamano(items, 1000);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], items);
});

test('chunkPorTamano parte en varios chunks, cada uno bajo el limite de bytes', () => {
  const items = Array.from({ length: 500 }, (_, i) => ({
    nombreCompleto: `Persona Con Nombre Bien Largo Numero ${i}`,
    rut: `${10000000 + i}-K`,
    comuna: 'VALPARAISO',
    clases: 'B',
  }));

  const maxBytes = 2000;
  const chunks = chunkPorTamano(items, maxBytes);

  assert.ok(chunks.length > 1, 'con 500 items y un limite chico debe partir en mas de un chunk');

  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  assert.equal(total, items.length, 'no debe perder ni duplicar items');

  for (const chunk of chunks) {
    assert.ok(chunk.length > 0, 'ningun chunk debe quedar vacio');
    assert.ok(JSON.stringify(chunk).length <= maxBytes, 'cada chunk debe respetar el limite de bytes');
  }
});

test('chunkPorTamano nunca deja un item afuera aunque sea mas grande que el limite', () => {
  const enorme = { nombre: 'x'.repeat(5000) };
  const chunks = chunkPorTamano([{ nombre: 'chico' }, enorme, { nombre: 'chico2' }], 1000);

  const flat = chunks.flat();
  assert.equal(flat.length, 3);
  assert.ok(flat.includes(enorme));
});
