import test from 'node:test';
import assert from 'node:assert/strict';
import { agruparPorComuna, construirCorreo } from '../worker/lib/plantilla.js';

test('agruparPorComuna agrupa peticiones marcadas y pendientes en un solo grupo por comuna', () => {
  const peticiones = [
    { id: 1, comuna: 'VALPARAISO', rut: '18.785.387-7', nombreCompleto: 'Ana Soto' },
    { id: 2, comuna: 'VALPARAISO', rut: '15.000.005-K', nombreCompleto: 'Beto Diaz' },
    { id: 3, comuna: 'VIÑA DEL MAR', rut: '11.111.111-1', nombreCompleto: 'Cata Rojas' },
  ];

  const grupos = agruparPorComuna(peticiones);

  assert.equal(grupos.length, 2);
  const valpo = grupos.find((g) => g.comuna === 'VALPARAISO');
  assert.equal(valpo.peticiones.length, 2);
});

test('construirCorreo arma asunto fijo y cuerpo con los datos de la persona (singular)', () => {
  const correo = construirCorreo([{ rut: '18.785.387-7', nombreCompleto: 'Ana Soto', clases: 'B' }], 'Firma');

  assert.equal(correo.asunto, 'Solicitud de cambio de domicilio');
  assert.match(correo.cuerpo, /Ana Soto/);
  assert.match(correo.cuerpo, /18\.785\.387-7/);
  assert.match(correo.cuerpo, /Clase B/);
});

test('construirCorreo lista numerada cuando hay varias personas', () => {
  const correo = construirCorreo(
    [
      { rut: '18.785.387-7', nombreCompleto: 'Ana Soto' },
      { rut: '15.000.005-K', nombreCompleto: 'Beto Diaz' },
    ],
    'Firma',
  );

  assert.match(correo.cuerpo, /1\. Nombre: Ana Soto/);
  assert.match(correo.cuerpo, /2\. Nombre: Beto Diaz/);
});

test('construirCorreo exige al menos una peticion', () => {
  assert.throws(() => construirCorreo([], 'Firma'));
});
