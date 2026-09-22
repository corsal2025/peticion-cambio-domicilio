import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { importarFilas } from '../worker/lib/importar.js';
import { upsertPeticion, listarPeticiones } from '../worker/lib/peticiones.js';

function fila(overrides = {}) {
  return {
    nombreCompleto: 'Ana Soto',
    rut: '18.785.387-7',
    comuna: 'VALPARAISO',
    clases: 'B',
    fechaSolicitud: '2026-01-05',
    oficina: 'AV. ARGENTINA',
    origen: 'Hoja1!5',
    ordenImportacion: 1,
    estadoCarpeta: 'CAMBIO DE DOMICILIO',
    ...overrides,
  };
}

test('re-sincronizacion con el mismo JSON no duplica, solo refresca', async () => {
  const db = crearD1Fake();
  const filas = [fila()];

  const r1 = await importarFilas(db, filas);
  assert.equal(r1.insertadas, 1);
  assert.equal(r1.actualizadas, 0);

  const r2 = await importarFilas(db, filas);
  assert.equal(r2.insertadas, 0);
  assert.equal(r2.actualizadas, 1);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 1);
});

test('fila que desaparece del Excel se elimina, salvo Oficina=MANUAL', async () => {
  const db = crearD1Fake();
  await importarFilas(db, [fila({ oficina: 'AV. ARGENTINA' })]);

  // Alta manual, no proviene del import.
  await upsertPeticion(db, {
    nombreCompleto: 'Manual Perez',
    rut: '15.000.005-K',
    comuna: 'VIÑA DEL MAR',
    oficina: 'MANUAL',
    estadoCarpeta: 'CAMBIO DE DOMICILIO',
  });

  // Segunda sincronizacion: la fila de AV. ARGENTINA ya no viene en el Excel.
  const r2 = await importarFilas(db, []);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 1, 'la fila de Excel desaparecida se elimina');
  assert.equal(lista[0].oficina, 'MANUAL', 'la fila MANUAL nunca se toca por limpieza de obsoletas');
  assert.equal(r2.eliminadas, 1);
});

test('importarFilas rechaza mas de 5000 filas', async () => {
  const db = crearD1Fake();
  const filas = Array.from({ length: 5001 }, (_, i) => fila({ rut: `1${i}-9`, comuna: `COMUNA${i}` }));
  await assert.rejects(() => importarFilas(db, filas));
});
