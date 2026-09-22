import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VALORES,
  CAMBIO_DE_DOMICILIO,
  rango,
  normalizar,
  opcionDashboard,
  esFinalizado,
} from '../worker/lib/estadoCarpeta.js';

test('catalogo tiene los 14 valores fijos', () => {
  assert.equal(VALORES.length, 14);
  assert.ok(VALORES.includes(CAMBIO_DE_DOMICILIO));
});

test('rango asigna 1/2/3 segun etapa del flujo', () => {
  assert.equal(rango('CAMBIO DE DOMICILIO'), 1);
  assert.equal(rango('CAMBIO DE DOMICILIO SOLICITADO'), 2);
  assert.equal(rango('CAMBIO DOM. SUBIDO A CONASET'), 3);
  assert.equal(rango('CREAR OFICIO'), 0);
});

test('normalizar corrige variantes de tipeo conocidas', () => {
  assert.equal(normalizar('se encuentra en of 43'), 'SE ENCUENTRA EN OF. 43');
  assert.equal(normalizar('cambio dom subido a conaset'), 'CAMBIO DOM. SUBIDO A CONASET');
  assert.equal(normalizar(''), CAMBIO_DE_DOMICILIO);
});

test('normalizar hace match case-insensitive contra el catalogo', () => {
  assert.equal(normalizar('cambio de domicilio solicitado'), 'CAMBIO DE DOMICILIO SOLICITADO');
});

test('opcionDashboard colapsa a las 3 opciones del dashboard', () => {
  assert.equal(opcionDashboard('CREAR OFICIO'), 'CAMBIO DE DOMICILIO SOLICITADO');
  assert.equal(opcionDashboard('CAMBIO DOM. SUBIDO A CONASET'), 'CAMBIO DOM. SUBIDO A CONASET');
  assert.equal(opcionDashboard('SUBIDA CON F8'), 'CAMBIO DOM. SUBIDO CON CORREO');
});

test('esFinalizado identifica estados de cierre', () => {
  assert.equal(esFinalizado('CAMBIO DOM. SUBIDO A CONASET'), true);
  assert.equal(esFinalizado('CAMBIO DE DOMICILIO'), false);
});
