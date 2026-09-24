import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generarSeed } from '../scripts/export-d1-seed.js';
import { crearD1Fake } from './support/d1Fake.js';

function crearSqliteFixture(dir) {
  const dbPath = path.join(dir, 'peticiones.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE Peticion (
      Id INTEGER PRIMARY KEY, NombreCompleto TEXT, Rut TEXT, Comuna TEXT, Clases TEXT,
      FechaSolicitud TEXT, Origen TEXT, RutInvalido INTEGER, Estado INTEGER, DetalleEstado TEXT,
      CreadaEn TEXT, EnviadaEn TEXT, DestinatariosCorreo TEXT, Oficina TEXT, OrdenImportacion INTEGER,
      Marcada INTEGER, EstadoCarpeta TEXT, SubidaEn TEXT
    );
  `);
  db.prepare(`INSERT INTO Peticion
    (Id, NombreCompleto, Rut, Comuna, Clases, FechaSolicitud, Origen, RutInvalido, Estado, DetalleEstado,
     CreadaEn, EnviadaEn, DestinatariosCorreo, Oficina, OrdenImportacion, Marcada, EstadoCarpeta, SubidaEn)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 'Juan Perez', '18.785.387-7', 'CONCECPION', null, '2026-01-01', 'Hoja!fila1', 0, 1, null,
    '2026-01-01T00:00:00', '2026-01-02T00:00:00', 'concepcion@muni.cl', 'AV ARGENTINA', 10, 1, 'CAMBIO DOM. SUBIDO A CONASET', '2026-01-05',
  );
  db.prepare(`INSERT INTO Peticion
    (Id, NombreCompleto, Rut, Comuna, Clases, FechaSolicitud, Origen, RutInvalido, Estado, DetalleEstado,
     CreadaEn, EnviadaEn, DestinatariosCorreo, Oficina, OrdenImportacion, Marcada, EstadoCarpeta, SubidaEn)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    2, 'Ana Soto', '22.222.222-2', 'VALPARAISO', null, '2026-01-01', 'Hoja!fila2', 0, 0, null,
    '2026-01-01T00:00:00', null, null, 'MANUAL', 0, 0, 'CAMBIO DE DOMICILIO', null,
  );
  db.close();
  return dbPath;
}

function crearCsvFixture(dir) {
  const csvPath = path.join(dir, 'comunas.csv');
  writeFileSync(csvPath, '﻿Comuna,ContactEmail,Domain\n"CONCEPCION","concepcion@muni.cl","muni.cl"\n"VALPARAISO","valpo@muni.cl","muni.cl"\n', 'utf8');
  return csvPath;
}

test('generarSeed produce SQL que preserva estado operativo y corrige CONCECPION', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-test-'));
  try {
    const dbPath = crearSqliteFixture(dir);
    const csvPath = crearCsvFixture(dir);
    const outPath = path.join(dir, '0002_datos.sql');

    const resumen = await generarSeed({ dbPath, csvPath, outPath });
    assert.equal(resumen.peticiones, 2);
    assert.equal(resumen.comunas, 2);

    const sql = readFileSync(outPath, 'utf8');
    assert.match(sql, /CONCEPCION/);
    assert.doesNotMatch(sql, /CONCECPION/);

    const db = crearD1Fake();
    db.exec(sql);
    const filas = (await db.prepare('SELECT * FROM peticiones ORDER BY id').all()).results;
    assert.equal(filas.length, 2);
    assert.equal(filas[0].comuna, 'CONCEPCION');
    assert.equal(filas[0].marcada, 1);
    assert.equal(filas[0].estado, 'Enviada');
    assert.ok(filas[0].enviada_en);
    assert.equal(filas[1].oficina, 'MANUAL');
    assert.equal(filas[1].estado, 'Borrador');

    const comunas = (await db.prepare('SELECT * FROM comunas ORDER BY nombre').all()).results;
    assert.equal(comunas.length, 2);
    assert.equal(comunas[0].correos, 'concepcion@muni.cl');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
