// D1 free tier: 100k ROWS WRITTEN por dia (distinto del limite de 50
// subrequests/invocacion que cubre d1SubrequestBudget*.test.js). El libro real
// tiene ~4600 filas relevantes (5 "CAMBIO DE DOMICILIO" + el resto en etapas
// posteriores) que Apps Script re-envia COMPLETAS cada 15 min. Si el worker
// reescribiera cada fila matcheada aunque nada haya cambiado, un solo dia de
// sincronizaciones (96 corridas) agotaria el limite diario en un par de horas
// (ver incidente 2026-09: D1_ERROR "exceeded D1's free tier daily row write
// limit"). Estos tests fijan el presupuesto: una re-sincronizacion sin
// cambios reales debe escribir (facturar) practicamente cero filas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { importarFilas, finalizarImport } from '../worker/lib/importar.js';

const N_AVANCE = 4600;
const N_CD = 5;

function rutNormDe(i) {
  return `R${i}`;
}

/** Siembra N_CD peticiones "CAMBIO DE DOMICILIO" + N_AVANCE ya avanzadas a "CAMBIO DE DOMICILIO SOLICITADO", sin pasar por importarFilas (para no contaminar el conteo de rowsWritten del propio test). */
function sembrarEstadoEstable(db) {
  const filasSql = [];
  for (let i = 0; i < N_CD; i++) {
    const clave = `CD${i}`;
    filasSql.push(
      `('Persona CD ${i}', '${clave}', '${clave}', 'COMUNA', 'COMUNA', 'CAMBIO DE DOMICILIO')`,
    );
  }
  for (let i = 0; i < N_AVANCE; i++) {
    const clave = rutNormDe(i);
    filasSql.push(
      `('Persona ${i}', '${clave}', '${clave}', 'COMUNA', 'COMUNA', 'CAMBIO DE DOMICILIO SOLICITADO')`,
    );
  }
  db.exec(
    `INSERT INTO peticiones (nombre_completo, rut, rut_norm, comuna, comuna_norm, estado_carpeta) VALUES ${filasSql.join(',')};`,
  );
}

function filaCD(i) {
  const clave = `CD${i}`;
  return {
    nombreCompleto: `Persona CD ${i}`,
    rut: clave,
    comuna: 'COMUNA',
    estadoCarpeta: 'CAMBIO DE DOMICILIO',
  };
}

function filaAvance(i, estadoCarpeta) {
  const clave = rutNormDe(i);
  return {
    nombreCompleto: `Persona ${i}`,
    rut: clave,
    comuna: 'COMUNA',
    estadoCarpeta,
  };
}

test('re-sincronizacion sin cambios reales (4600 avance + 5 CD, todo igual) escribe <= 5 filas', async () => {
  const db = crearD1Fake();
  sembrarEstadoEstable(db);
  db.resetStats();

  const filas = [
    ...Array.from({ length: N_CD }, (_, i) => filaCD(i)),
    ...Array.from({ length: N_AVANCE }, (_, i) => filaAvance(i, 'CAMBIO DE DOMICILIO SOLICITADO')),
  ];

  const r = await importarFilas(db, filas);
  const f = await finalizarImport(db, { clavesCD: r.clavesCD, hojasLeidas: 1 });

  assert.equal(f.eliminadas, 0);
  assert.ok(
    db.stats().rowsWritten <= N_CD,
    `se esperaban <= ${N_CD} filas escritas (solo el resumen), se escribieron ${db.stats().rowsWritten}`,
  );
});

test('cuando 3 peticiones avanzan de estado, se escriben <= 3 + una pequeña constante', async () => {
  const db = crearD1Fake();
  sembrarEstadoEstable(db);
  db.resetStats();

  const filas = [
    ...Array.from({ length: N_CD }, (_, i) => filaCD(i)),
    // Las primeras 3 SI avanzan (rango 2 -> 3); el resto sigue igual.
    filaAvance(0, 'SUBIDA A CONASET'),
    filaAvance(1, 'SUBIDA A CONASET'),
    filaAvance(2, 'SUBIDA A CONASET'),
    ...Array.from({ length: N_AVANCE - 3 }, (_, i) => filaAvance(i + 3, 'CAMBIO DE DOMICILIO SOLICITADO')),
  ];

  const r = await importarFilas(db, filas);
  const f = await finalizarImport(db, { clavesCD: r.clavesCD, hojasLeidas: 1 });

  assert.equal(f.eliminadas, 0);
  const PEQUENA_CONSTANTE = 5;
  assert.ok(
    db.stats().rowsWritten <= 3 + PEQUENA_CONSTANTE,
    `se esperaban <= ${3 + PEQUENA_CONSTANTE} filas escritas, se escribieron ${db.stats().rowsWritten}`,
  );
});
