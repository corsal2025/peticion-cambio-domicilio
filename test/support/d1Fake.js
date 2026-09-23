// D1 fake para tests: SQLite real en memoria (node:sqlite, Node >=22.5) cargado
// con la migracion 0001_init.sql, envuelto en una API compatible con el
// binding D1 de Cloudflare (prepare().bind().run()/first()/all(), batch()).
// Evita reimplementar un parser SQL a mano para probar worker/lib/*.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR_MIGRACIONES = path.join(__dirname, '..', '..', 'migrations');
const MIGRACIONES = ['0001_init.sql', '0002_normalizar_usuarios.sql'];

export function crearD1Fake() {
  const sqlite = new DatabaseSync(':memory:');
  for (const archivo of MIGRACIONES) {
    sqlite.exec(readFileSync(path.join(DIR_MIGRACIONES, archivo), 'utf8'));
  }
  return wrap(sqlite);
}

// Contador de "subrequests" D1 para tests de presupuesto (Cloudflare Workers
// FREE plan: 50 subrequests por invocacion; cada .run()/.first()/.all() Y cada
// .batch() cuentan como UN subrequest, pero cada statement DENTRO de un
// batch tambien cuenta contra el limite de 50 queries por invocacion). Ver
// test/d1SubrequestBudget.test.js.
function wrap(sqlite) {
  const stats = { calls: 0, statements: 0 };

  function crearStatement(sql) {
    const stmt = sqlite.prepare(sql);
    let boundArgs = [];
    const obj = {
      bind(...args) {
        boundArgs = args;
        return obj;
      },
      // Ejecucion real sin contar como subrequest aparte: la usa batch(),
      // que ya contabiliza 1 llamada + N statements por su cuenta.
      _runRaw() {
        const info = stmt.run(...boundArgs);
        return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } };
      },
      async run() {
        stats.calls++;
        stats.statements++;
        return obj._runRaw();
      },
      async first() {
        stats.calls++;
        stats.statements++;
        return stmt.get(...boundArgs) ?? null;
      },
      async all() {
        stats.calls++;
        stats.statements++;
        return { results: stmt.all(...boundArgs) };
      },
    };
    return obj;
  }

  return {
    prepare(sql) {
      return crearStatement(sql);
    },
    async batch(statements) {
      stats.calls++;
      stats.statements += statements.length;
      const resultados = [];
      for (const stmt of statements) {
        resultados.push(stmt._runRaw());
      }
      return resultados;
    },
    exec(sql) {
      sqlite.exec(sql);
    },
    // --- instrumentacion para tests de presupuesto de subrequests D1 ---
    stats() {
      return { calls: stats.calls, statements: stats.statements };
    },
    resetStats() {
      stats.calls = 0;
      stats.statements = 0;
    },
  };
}
