import test from 'node:test';
import assert from 'node:assert/strict';
import { batch } from '../worker/lib/db.js';

// D1 fake minimo: registra el orden de ejecucion de prepare/bind/run y agrupa
// las sentencias que llegan a batch() en una sola "transaccion" simulada.
function crearDbFake() {
  const ejecutadas = [];
  const llamadasBatch = [];
  return {
    ejecutadas,
    llamadasBatch,
    prepare(sql) {
      return {
        sql,
        _args: [],
        bind(...args) {
          this._args = args;
          return this;
        },
        async run() {
          ejecutadas.push({ sql: this.sql, args: this._args });
          return { success: true };
        },
      };
    },
    async batch(statements) {
      llamadasBatch.push(statements.length);
      const resultados = [];
      for (const stmt of statements) {
        resultados.push(await stmt.run());
      }
      return resultados;
    },
  };
}

test('batch ejecuta statements en orden dentro de una sola llamada a db.batch', async () => {
  const db = crearDbFake();
  const s1 = db.prepare('INSERT INTO peticiones (nombre_completo) VALUES (?)').bind('Ana');
  const s2 = db.prepare('INSERT INTO peticiones (nombre_completo) VALUES (?)').bind('Beto');

  const resultados = await batch(db, [s1, s2]);

  assert.equal(db.llamadasBatch.length, 1, 'debe agrupar todo en una sola transaccion logica');
  assert.equal(db.llamadasBatch[0], 2);
  assert.deepEqual(
    db.ejecutadas.map((e) => e.args[0]),
    ['Ana', 'Beto'],
  );
  assert.equal(resultados.length, 2);
});

test('batch con arreglo vacio no llama a db.batch', async () => {
  const db = crearDbFake();
  const resultados = await batch(db, []);
  assert.deepEqual(resultados, []);
  assert.equal(db.llamadasBatch.length, 0);
});
