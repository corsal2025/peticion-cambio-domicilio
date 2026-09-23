import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { sincronizarContactos, listarComunas } from '../worker/lib/comunas.js';

// Paridad con ComunaDirectory.AddOrUpdate / ImportFromWorkbook: upsert por
// (comuna, correo). Contactos nuevos se agregan, los que ya existian solo se
// cuentan (no se pisan), y nunca se borra nada aunque el contacto no venga en
// esta sincronizacion (a diferencia de /api/import de peticiones, que si
// limpia obsoletas).

test('sincronizarContactos crea una comuna nueva con su primer correo', async () => {
  const db = crearD1Fake();
  const resumen = await sincronizarContactos(db, [{ comuna: 'Valparaiso', email: 'contacto@valpo.cl' }]);

  assert.equal(resumen.leidos, 1);
  assert.equal(resumen.nuevos, 1);
  assert.equal(resumen.actualizados, 0);

  const lista = await listarComunas(db);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].correos, 'contacto@valpo.cl');
});

test('sincronizarContactos agrega un segundo correo a una comuna existente sin perder el primero', async () => {
  const db = crearD1Fake();
  await sincronizarContactos(db, [{ comuna: 'Valparaiso', email: 'uno@valpo.cl' }]);
  const resumen = await sincronizarContactos(db, [{ comuna: 'Valparaiso', email: 'dos@valpo.cl' }]);

  assert.equal(resumen.nuevos, 1);
  const lista = await listarComunas(db);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].correos, 'uno@valpo.cl,dos@valpo.cl');
});

test('sincronizarContactos no duplica el mismo (comuna, correo) en una segunda pasada', async () => {
  const db = crearD1Fake();
  await sincronizarContactos(db, [{ comuna: 'Valparaiso', email: 'uno@valpo.cl' }]);
  const resumen = await sincronizarContactos(db, [{ comuna: 'Valparaiso', email: 'uno@valpo.cl' }]);

  assert.equal(resumen.nuevos, 0);
  assert.equal(resumen.actualizados, 1);
  const lista = await listarComunas(db);
  assert.equal(lista[0].correos, 'uno@valpo.cl');
});

test('sincronizarContactos matchea la comuna por nombre normalizado (tildes/mayusculas/espacios)', async () => {
  const db = crearD1Fake();
  await sincronizarContactos(db, [{ comuna: 'Viña del Mar', email: 'a@vina.cl' }]);
  const resumen = await sincronizarContactos(db, [{ comuna: '  VINA DEL MAR ', email: 'b@vina.cl' }]);

  assert.equal(resumen.nuevos, 1);
  const lista = await listarComunas(db);
  assert.equal(lista.length, 1, 'no debe crear una comuna duplicada por variacion de tilde/mayuscula');
  assert.equal(lista[0].correos, 'a@vina.cl,b@vina.cl');
});

test('sincronizarContactos nunca borra comunas/correos que no vienen en la sincronizacion actual', async () => {
  const db = crearD1Fake();
  await sincronizarContactos(db, [{ comuna: 'Valparaiso', email: 'valpo@muni.cl' }]);
  await sincronizarContactos(db, [{ comuna: 'Concepcion', email: 'concepcion@muni.cl' }]);

  const lista = await listarComunas(db);
  assert.equal(lista.length, 2, 'la comuna que no vino en la segunda pasada debe seguir existiendo');
});

test('sincronizarContactos ignora filas sin comuna, sin correo o con correo invalido', async () => {
  const db = crearD1Fake();
  const resumen = await sincronizarContactos(db, [
    { comuna: '', email: 'a@x.cl' },
    { comuna: 'Valparaiso', email: '' },
    { comuna: 'Valparaiso', email: 'sin-arroba' },
  ]);

  assert.equal(resumen.leidos, 0);
  assert.equal((await listarComunas(db)).length, 0);
});
