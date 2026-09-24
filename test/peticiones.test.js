import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { upsertPeticion, listarPeticiones, marcarPeticion, marcarTodas } from '../worker/lib/peticiones.js';

function datosBase(overrides = {}) {
  return {
    nombreCompleto: 'Ana Soto',
    rut: '18.785.387-7',
    comuna: 'VALPARAISO',
    clases: 'B',
    fechaSolicitud: '2026-01-05',
    oficina: 'AV. ARGENTINA',
    origen: 'Hoja1!5',
    ordenImportacion: 1,
    rutInvalido: false,
    estadoCarpeta: 'CAMBIO DE DOMICILIO',
    ...overrides,
  };
}

test('petición nueva se crea con Borrador, marcada=false y estado_carpeta inicial', async () => {
  const db = crearD1Fake();
  const { id, creada } = await upsertPeticion(db, datosBase());

  assert.equal(creada, true);
  const { results } = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(id).all();
  assert.equal(results.length, 1);
  assert.equal(results[0].estado, 'Borrador');
  assert.equal(results[0].marcada, 0);
  assert.equal(results[0].estado_carpeta, 'CAMBIO DE DOMICILIO');
  assert.equal(results[0].rut_norm, '187853877');
});

test('petición existente se refresca sin perder marcada/estado/enviada_en', async () => {
  const db = crearD1Fake();
  const { id } = await upsertPeticion(db, datosBase());

  await marcarPeticion(db, id, true);
  await db.prepare("UPDATE peticiones SET estado = 'Enviada', enviada_en = '2026-01-10T10:00:00' WHERE id = ?").bind(id).run();

  const { id: idRefrescada, creada } = await upsertPeticion(db, datosBase({ nombreCompleto: 'Ana Soto Reyes' }));

  assert.equal(creada, false);
  assert.equal(idRefrescada, id);

  const fila = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(id).first();
  assert.equal(fila.nombre_completo, 'Ana Soto Reyes');
  assert.equal(fila.marcada, 1, 'no debe perder la marca');
  assert.equal(fila.estado, 'Enviada', 'no debe perder el estado');
  assert.ok(fila.enviada_en, 'no debe perder enviada_en');
});

test('estado_carpeta solo avanza, nunca retrocede', async () => {
  const db = crearD1Fake();
  const { id } = await upsertPeticion(db, datosBase({ estadoCarpeta: 'CAMBIO DE DOMICILIO SOLICITADO' }));

  await upsertPeticion(db, datosBase({ estadoCarpeta: 'CAMBIO DE DOMICILIO' }));
  let fila = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(id).first();
  assert.equal(fila.estado_carpeta, 'CAMBIO DE DOMICILIO SOLICITADO', 'no retrocede con un rango menor');

  await upsertPeticion(db, datosBase({ estadoCarpeta: 'CAMBIO DOM. SUBIDO A CONASET' }));
  fila = await db.prepare('SELECT * FROM peticiones WHERE id = ?').bind(id).first();
  assert.equal(fila.estado_carpeta, 'CAMBIO DOM. SUBIDO A CONASET', 'avanza con un rango mayor');
});

test('listarPeticiones filtra por rut o nombre (buscador)', async () => {
  const db = crearD1Fake();
  await upsertPeticion(db, datosBase({ nombreCompleto: 'Ana Soto', rut: '18.785.387-7', comuna: 'VALPARAISO' }));
  await upsertPeticion(db, datosBase({ nombreCompleto: 'Beto Diaz', rut: '15.000.005-K', comuna: 'VIÑA DEL MAR' }));

  const porNombre = await listarPeticiones(db, { busqueda: 'soto' });
  assert.equal(porNombre.length, 1);
  assert.equal(porNombre[0].nombre_completo, 'Ana Soto');

  const porRut = await listarPeticiones(db, { busqueda: '187853877' });
  assert.equal(porRut.length, 1);
  assert.equal(porRut[0].rut, '18.785.387-7');
});

test('marcarTodas marca o desmarca todas las peticiones visibles', async () => {
  const db = crearD1Fake();
  const p1 = await upsertPeticion(db, datosBase({ rut: '18.785.387-7', comuna: 'VALPARAISO' }));
  const p2 = await upsertPeticion(db, datosBase({ rut: '15.000.005-K', comuna: 'VIÑA DEL MAR' }));

  await marcarTodas(db, [p1.id, p2.id], true);
  let filas = await listarPeticiones(db, {});
  assert.ok(filas.every((f) => f.marcada === 1));

  await marcarTodas(db, [p1.id, p2.id], false);
  filas = await listarPeticiones(db, {});
  assert.ok(filas.every((f) => f.marcada === 0));
});
