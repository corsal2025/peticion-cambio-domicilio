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
  // Tres filas vigentes en la primera sincronizacion, para que la baja de una
  // sola (33%) quede bajo el umbral de seguridad de borrado masivo.
  await importarFilas(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '7.654.321-6', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '9.876.543-3', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);

  // Alta manual, no proviene del import.
  await upsertPeticion(db, {
    nombreCompleto: 'Manual Perez',
    rut: '15.000.005-K',
    comuna: 'VIÑA DEL MAR',
    oficina: 'MANUAL',
    estadoCarpeta: 'CAMBIO DE DOMICILIO',
  });

  // Segunda sincronizacion: solo una de las tres filas de AV. ARGENTINA ya no viene en el Excel.
  const r2 = await importarFilas(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '7.654.321-6', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 3, 'la fila de Excel desaparecida se elimina, las demas quedan');
  assert.equal(r2.eliminadas, 1);
  assert.ok(lista.some((p) => p.oficina === 'MANUAL'), 'la fila MANUAL nunca se toca por limpieza de obsoletas');
});

test('importarFilas rechaza mas de 5000 filas', async () => {
  const db = crearD1Fake();
  const filas = Array.from({ length: 5001 }, (_, i) => fila({ rut: `1${i}-9`, comuna: `COMUNA${i}` }));
  await assert.rejects(() => importarFilas(db, filas));
});

test('importarFilas con 0 filas jamas borra: omite limpieza de obsoletas y avisa', async () => {
  const db = crearD1Fake();
  await importarFilas(db, [fila({ oficina: 'AV. ARGENTINA' })]);

  // Payload vacio (ej. error de red/lectura en Apps Script que perdio las filas
  // extraidas): no debe interpretarse como "todo desaparecio".
  const r2 = await importarFilas(db, []);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 1, 'con 0 filas recibidas no se borra nada');
  assert.equal(r2.eliminadas, 0);
  assert.ok(Array.isArray(r2.avisos) && r2.avisos.length > 0, 'debe informar que se omitio la limpieza');
});

test('importarFilas con 0 hojasLeidas jamas borra aunque lleguen filas vacias', async () => {
  const db = crearD1Fake();
  await importarFilas(db, [fila({ oficina: 'AV. ARGENTINA' })]);

  const r2 = await importarFilas(db, [], { hojasLeidas: 0 });

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 1);
  assert.equal(r2.eliminadas, 0);
});

test('importarFilas omite la limpieza si borraria mas del 50% de las peticiones Borrador', async () => {
  const db = crearD1Fake();
  await importarFilas(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '7.654.321-6', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '9.876.543-3', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '11.111.111-1', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);

  // Segunda sincronizacion "sospechosa": solo 1 de 4 filas vigentes (75% se borraria).
  const r2 = await importarFilas(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 4, 'la limpieza masiva se omite por superar el umbral de seguridad');
  assert.equal(r2.eliminadas, 0);
  assert.ok(Array.isArray(r2.avisos) && r2.avisos.length > 0);
});
