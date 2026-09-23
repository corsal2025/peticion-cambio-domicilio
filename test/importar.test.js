import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { importarFilas, finalizarImport } from '../worker/lib/importar.js';
import { upsertPeticion, listarPeticiones, marcarPeticion, marcarComoEnviada } from '../worker/lib/peticiones.js';

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

// Import de un solo lote: upsert + finalizar en la misma sincronizacion.
async function importarUnLote(db, filas, opciones = {}) {
  const syncId = opciones.syncId ?? `sync-${Math.random().toString(36).slice(2)}`;
  const r = await importarFilas(db, filas, { ...opciones, syncId, lote: 1, totalLotes: 1 });
  const f = await finalizarImport(db, { syncId, hojasLeidas: opciones.hojasLeidas });
  return { ...r, ...f };
}

test('re-sincronizacion con el mismo JSON no duplica, solo refresca', async () => {
  const db = crearD1Fake();
  const filas = [fila()];

  const r1 = await importarUnLote(db, filas);
  assert.equal(r1.insertadas, 1);
  assert.equal(r1.actualizadas, 0);

  const r2 = await importarUnLote(db, filas);
  assert.equal(r2.insertadas, 0);
  assert.equal(r2.actualizadas, 1);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 1);
});

test('fila que desaparece del Excel se elimina, salvo Oficina=MANUAL', async () => {
  const db = crearD1Fake();
  // Tres filas vigentes en la primera sincronizacion, para que la baja de una
  // sola (33%) quede bajo el umbral de seguridad de borrado masivo.
  await importarUnLote(db, [
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
  const r2 = await importarUnLote(db, [
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
  await assert.rejects(() => importarFilas(db, filas, { syncId: 'x', lote: 1, totalLotes: 1 }));
});

test('finalizar con 0 filas jamas borra: omite limpieza de obsoletas y avisa', async () => {
  const db = crearD1Fake();
  await importarUnLote(db, [fila({ oficina: 'AV. ARGENTINA' })]);

  // Payload vacio (ej. error de red/lectura en Apps Script que perdio las filas
  // extraidas): no debe interpretarse como "todo desaparecio".
  const r2 = await importarUnLote(db, []);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 1, 'con 0 filas recibidas no se borra nada');
  assert.equal(r2.eliminadas, 0);
  assert.ok(Array.isArray(r2.avisos) && r2.avisos.length > 0, 'debe informar que se omitio la limpieza');
});

test('finalizar con 0 hojasLeidas jamas borra aunque lleguen filas vacias', async () => {
  const db = crearD1Fake();
  await importarUnLote(db, [fila({ oficina: 'AV. ARGENTINA' })]);

  const r2 = await importarUnLote(db, [], { hojasLeidas: 0 });

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 1);
  assert.equal(r2.eliminadas, 0);
});

test('finalizar omite la limpieza si borraria mas del 50% de las peticiones Borrador', async () => {
  const db = crearD1Fake();
  await importarUnLote(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '7.654.321-6', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '9.876.543-3', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '11.111.111-1', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);

  // Segunda sincronizacion "sospechosa": solo 1 de 4 filas vigentes (75% se borraria).
  const r2 = await importarUnLote(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 4, 'la limpieza masiva se omite por superar el umbral de seguridad');
  assert.equal(r2.eliminadas, 0);
  assert.ok(Array.isArray(r2.avisos) && r2.avisos.length > 0);
});

test('finalizar NUNCA borra una peticion Enviada/Marcada ausente, aunque no este en Borrador y el umbral lo permita', async () => {
  const db = crearD1Fake();
  // 4 Borrador limpios (quedan vigentes en ambas sincronizaciones) + 1 que
  // pasara a Enviada antes de la segunda sincronizacion.
  await importarUnLote(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '7.654.321-6', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '9.876.543-3', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '11.111.111-1', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '22.222.222-2', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);
  const lista1 = await listarPeticiones(db, {});
  const pEnviada = lista1.find((p) => p.rut === '22.222.222-2');
  await marcarComoEnviada(db, pEnviada.id, new Date().toISOString(), 'valpo@muni.cl');

  // Segunda sincronizacion: SOLO desaparece la que ya esta Enviada (el resto
  // sigue vigente). Con el umbral calculado sobre TODAS las no-manuales
  // (bug), 1 de 5 = 20% queda bajo el umbral y se borraria igual.
  const r2 = await importarUnLote(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '7.654.321-6', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '9.876.543-3', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '11.111.111-1', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);

  const lista2 = await listarPeticiones(db, {});
  assert.equal(lista2.length, 5, 'la peticion Enviada nunca se borra, sin importar el umbral');
  assert.equal(r2.eliminadas, 0);
});

test('el umbral del 50% se calcula solo sobre Borrador limpio, no sobre Enviada/Marcada/error', async () => {
  const db = crearD1Fake();
  await importarUnLote(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '7.654.321-6', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '9.876.543-3', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);
  const [p1, p2, p3] = await listarPeticiones(db, {});
  // p1 pasa a Enviada (no cuenta para el umbral ni se borra); quedan p2 y p3
  // como Borrador limpio candidatas: si ambas desaparecen es 100% de 2, no
  // 66% de 3 — pero igual supera el umbral, asi que se omite el borrado.
  await marcarComoEnviada(db, p1.id, new Date().toISOString(), 'valpo@muni.cl');

  const r2 = await importarUnLote(db, []);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 3, 'se omite: 100% de las Borrador limpias desaparecerian');
  assert.equal(r2.eliminadas, 0);
  assert.ok(r2.avisos.length > 0);
});

test('import por lotes: la limpieza de obsoletas usa el acumulado de TODOS los lotes, no de uno solo', async () => {
  const db = crearD1Fake();
  // Primera sincronizacion completa: 4 filas vigentes en un solo lote.
  await importarUnLote(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '7.654.321-6', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '9.876.543-3', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    fila({ rut: '11.111.111-1', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
  ]);

  // Segunda sincronizacion: las mismas 4 filas, pero repartidas en 2 lotes de 2.
  // Si la limpieza corriera por lote (bug original), el lote 1 borraria las 2
  // filas que solo aparecen en el lote 2 (50%, ademas activaria el umbral).
  const syncId = 'sync-lotes';
  const r1 = await importarFilas(
    db,
    [
      fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
      fila({ rut: '7.654.321-6', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    ],
    { syncId, lote: 1, totalLotes: 2 },
  );
  assert.equal(r1.eliminadas, undefined, 'importarFilas (por lote) nunca borra, esa clave no existe en su resultado');

  const r2 = await importarFilas(
    db,
    [
      fila({ rut: '9.876.543-3', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
      fila({ rut: '11.111.111-1', comuna: 'VALPARAISO', oficina: 'AV. ARGENTINA' }),
    ],
    { syncId, lote: 2, totalLotes: 2 },
  );
  assert.equal(r2.eliminadas, undefined);

  const fin = await finalizarImport(db, { syncId });
  assert.equal(fin.eliminadas, 0, 'las 4 claves llegaron repartidas en 2 lotes, ninguna es obsoleta');

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 4, 'ningun lote parcial debe haber borrado nada');
});

test('finalizar rechaza si no llegaron todos los lotes anunciados', async () => {
  const db = crearD1Fake();
  const syncId = 'sync-incompleto';
  await importarFilas(db, [fila({ rut: '18.785.387-7', comuna: 'VALPARAISO' })], {
    syncId,
    lote: 1,
    totalLotes: 2,
  });

  await assert.rejects(() => finalizarImport(db, { syncId }), /lote/i);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 1, 'el upsert del lote 1 se mantiene, solo se rechaza la limpieza');
});

test('finalizar con syncId desconocido rechaza', async () => {
  const db = crearD1Fake();
  await assert.rejects(() => finalizarImport(db, { syncId: 'no-existe' }), /desconocido/i);
});

// --- Incidente 2026-09: sync real creo 17234 Borrador (esperaba ~5). Causa:
// filas con estado vacio (normalizar('') === 'CAMBIO DE DOMICILIO') y filas
// en etapas posteriores (SUBIDA A CONASET, etc.) sin peticion existente se
// upserteaban como altas nuevas. Paridad con ExcelPeticionImporter.cs
// ImportCore: esCambioDomicilio = fold exacto contra "CAMBIO DE DOMICILIO"
// (vacio NO cuenta); solo esas filas crean/actualizan libremente. El resto
// (rango>=2, no exacto) SOLO puede avanzar el estado_carpeta de una peticion
// YA EXISTENTE con la misma clave (rut|comuna); nunca crea. Rango<2 y no
// exacto se descarta sin tocar nada.

test('fila con estado vacio NUNCA crea una peticion (paridad ExcelPeticionImporter)', async () => {
  const db = crearD1Fake();
  await importarUnLote(db, [fila({ estadoCarpeta: '' })]);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 0, 'una celda de estado vacia no es CAMBIO DE DOMICILIO, no debe crear nada');
});

test('fila SUBIDA A CONASET sin peticion existente NUNCA crea una peticion', async () => {
  const db = crearD1Fake();
  await importarUnLote(db, [fila({ estadoCarpeta: 'SUBIDA A CONASET' })]);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 0, 'una fila en etapa posterior sin peticion existente no debe crear nada');
});

test('fila SUBIDA A CONASET con peticion existente avanza estado_carpeta y subida_en, sin crear otra fila', async () => {
  const db = crearD1Fake();
  // Primero llega la fila real de "CAMBIO DE DOMICILIO" que crea la peticion.
  await importarUnLote(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', estadoCarpeta: 'CAMBIO DE DOMICILIO' }),
  ]);
  const antes = await listarPeticiones(db, {});
  assert.equal(antes.length, 1);
  assert.equal(antes[0].subidaEn ?? antes[0].subida_en ?? null, null);

  // Sincronizacion posterior: la misma persona/comuna ya fue subida a CONASET.
  await importarUnLote(db, [
    fila({ rut: '18.785.387-7', comuna: 'VALPARAISO', estadoCarpeta: 'SUBIDA A CONASET' }),
  ]);

  const despues = await listarPeticiones(db, {});
  assert.equal(despues.length, 1, 'no debe crear una segunda fila, solo avanza la existente');
  assert.equal(despues[0].estadoCarpeta ?? despues[0].estado_carpeta, 'SUBIDA A CONASET');
  assert.ok(despues[0].subidaEn ?? despues[0].subida_en, 'subida_en debe quedar seteada al alcanzar rango 3');
});

test('fila con estado exacto CAMBIO DE DOMICILIO SI crea/refresca la peticion', async () => {
  const db = crearD1Fake();
  const r = await importarUnLote(db, [fila({ estadoCarpeta: 'CAMBIO DE DOMICILIO' })]);

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 1);
  assert.equal(r.insertadas, 1);
});

test('un lote que insertaria mas de 200 peticiones nuevas es rechazado (guardia de seguridad)', async () => {
  const db = crearD1Fake();
  const filas = Array.from({ length: 201 }, (_, i) =>
    fila({ rut: `1${i}-9`, comuna: `COMUNA${i}`, estadoCarpeta: 'CAMBIO DE DOMICILIO' }),
  );

  await assert.rejects(
    () => importarFilas(db, filas, { syncId: 'lote-masivo', lote: 1, totalLotes: 1 }),
    /200|masiv/i,
  );

  const lista = await listarPeticiones(db, {});
  assert.equal(lista.length, 0, 'el rechazo no debe dejar altas parciales');
});
