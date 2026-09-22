import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { crearComuna, listarComunas, actualizarComuna, eliminarComuna, importarCsv } from '../worker/lib/comunas.js';

test('crearComuna crea un contacto nuevo', async () => {
  const db = crearD1Fake();
  const { id } = await crearComuna(db, { nombre: 'VALPARAISO', correos: 'a@muni.cl', contacto: 'Juan', telefono: '123' });

  const lista = await listarComunas(db);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, id);
  assert.equal(lista[0].nombre, 'VALPARAISO');
});

test('actualizarComuna modifica los datos de contacto', async () => {
  const db = crearD1Fake();
  const { id } = await crearComuna(db, { nombre: 'VALPARAISO', correos: 'a@muni.cl' });
  await actualizarComuna(db, id, { correos: 'nuevo@muni.cl', contacto: 'Pedro' });

  const lista = await listarComunas(db);
  assert.equal(lista[0].correos, 'nuevo@muni.cl');
  assert.equal(lista[0].contacto, 'Pedro');
});

test('eliminarComuna la quita del directorio', async () => {
  const db = crearD1Fake();
  const { id } = await crearComuna(db, { nombre: 'VALPARAISO' });
  await eliminarComuna(db, id);
  assert.deepEqual(await listarComunas(db), []);
});

test('importarCsv agrega comunas nuevas sin duplicar por nombre normalizado', async () => {
  const db = crearD1Fake();
  await crearComuna(db, { nombre: 'Concepcion', correos: 'viejo@muni.cl' });

  const csv = 'nombre,correo\nCONCEPCION,nuevo@muni.cl\nViña del Mar,vina@muni.cl\n';
  const resultado = await importarCsv(db, csv);

  const lista = await listarComunas(db);
  assert.equal(lista.length, 2, 'no debe duplicar Concepcion por nombre normalizado');
  const concepcion = lista.find((c) => c.nombre_norm === 'concepcion');
  assert.equal(concepcion.correos, 'nuevo@muni.cl', 'el import actualiza el correo existente');
  assert.equal(resultado.actualizadas, 1);
  assert.equal(resultado.insertadas, 1);
});
