// D1 fake para tests: SQLite real en memoria (node:sqlite, Node >=22.5) cargado
// con la migracion 0001_init.sql, envuelto en una API compatible con el
// binding D1 de Cloudflare (prepare().bind().run()/first()/all(), batch()).
// Evita reimplementar un parser SQL a mano para probar worker/lib/*.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRACION = path.join(__dirname, '..', '..', 'migrations', '0001_init.sql');

export function crearD1Fake() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(MIGRACION, 'utf8'));
  return wrap(sqlite);
}

function wrap(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      let boundArgs = [];
      return {
        bind(...args) {
          boundArgs = args;
          return this;
        },
        async run() {
          const info = stmt.run(...boundArgs);
          return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } };
        },
        async first() {
          return stmt.get(...boundArgs) ?? null;
        },
        async all() {
          return { results: stmt.all(...boundArgs) };
        },
      };
    },
    async batch(statements) {
      const resultados = [];
      for (const stmt of statements) {
        resultados.push(await stmt.run());
      }
      return resultados;
    },
    exec(sql) {
      sqlite.exec(sql);
    },
  };
}
