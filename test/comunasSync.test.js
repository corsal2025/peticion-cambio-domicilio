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

// Presupuesto de escritura D1 (ver test/d1WriteBudget.test.js para el mismo
// presupuesto en peticiones): re-enviar un directorio de ~500 contactos SIN
// cambios reales no debe reescribir ninguna fila; solo los pares
// (comuna, correo) nuevos/cambiados deben facturar una escritura.
test('sincronizarContactos: re-sincronizar 500 contactos sin cambios reales no escribe ninguna fila', async () => {
  const db = crearD1Fake();
  const contactos = Array.from({ length: 500 }, (_, i) => ({ comuna: `COMUNA${i}`, email: `contacto${i}@muni.cl` }));

  await sincronizarContactos(db, contactos);
  db.resetStats();

  const resumen = await sincronizarContactos(db, contactos);

  assert.equal(resumen.nuevos, 0);
  assert.equal(resumen.actualizados, 500);
  assert.equal(db.stats().rowsWritten, 0, 're-sincronizar contactos sin cambios no debe escribir ninguna fila');
});

test('sincronizarContactos: solo los correos NUEVOS entre 500 contactos generan escrituras', async () => {
  const db = crearD1Fake();
  const contactos = Array.from({ length: 500 }, (_, i) => ({ comuna: `COMUNA${i}`, email: `contacto${i}@muni.cl` }));
  await sincronizarContactos(db, contactos);
  db.resetStats();

  // 3 comunas existentes suman un correo nuevo; el resto no cambia.
  const conTresNuevos = [
    ...contactos,
    { comuna: 'COMUNA0', email: 'nuevo0@muni.cl' },
    { comuna: 'COMUNA1', email: 'nuevo1@muni.cl' },
    { comuna: 'COMUNA2', email: 'nuevo2@muni.cl' },
  ];

  const resumen = await sincronizarContactos(db, conTresNuevos);

  assert.equal(resumen.nuevos, 3);
  assert.ok(
    db.stats().rowsWritten <= 3,
    `se esperaban <= 3 filas escritas (solo las comunas con un correo nuevo), se escribieron ${db.stats().rowsWritten}`,
  );
});
