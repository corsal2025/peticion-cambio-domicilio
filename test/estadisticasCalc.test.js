// Paridad con PeticionCambioDomicilio.Pages.EstadisticasModel (C#): mismas
// formulas de demora habil, ranking de volumen y tabla por comuna.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularEstadisticas } from '../worker/lib/estadisticasCalc.js';

function fila(overrides = {}) {
  return {
    comuna: 'Valparaiso',
    enviada_en: '2026-01-05T12:00:00',
    subida_en: null,
    estado_carpeta: 'CAMBIO DE DOMICILIO SOLICITADO',
    ...overrides,
  };
}

test('sin filas: todo en cero', () => {
  const r = calcularEstadisticas([]);
  assert.equal(r.totalEnviadas, 0);
  assert.equal(r.comunasConEnvios, 0);
  assert.equal(r.cerradas, 0);
  assert.equal(r.abiertas, 0);
  assert.equal(r.demoraPromedio, null);
  assert.equal(r.porcentajeEnPlazo, null);
  assert.deepEqual(r.rankingVolumen, []);
  assert.equal(r.volumenMaximo, 1);
  assert.deepEqual(r.porComuna, []);
});

test('cuenta comunas distintas ignorando mayusculas/tildes', () => {
  const r = calcularEstadisticas([
    fila({ comuna: 'Valparaiso' }),
    fila({ comuna: 'VALPARAISO' }),
    fila({ comuna: 'Viña del Mar' }),
  ]);
  assert.equal(r.totalEnviadas, 3);
  assert.equal(r.comunasConEnvios, 2);
});

test('cerradas/abiertas y clasificacion subio comuna vs subimos nosotros', () => {
  const r = calcularEstadisticas([
    fila({ subida_en: '2026-01-10', estado_carpeta: 'SUBIDA A CONASET' }),
    fila({ subida_en: '2026-01-12', estado_carpeta: 'SUBIDA CON F8' }),
    fila({ subida_en: null }),
  ]);
  assert.equal(r.cerradas, 2);
  assert.equal(r.abiertas, 1);
  assert.equal(r.subioComuna, 1);
  assert.equal(r.subimosNosotros, 1);
});

test('demora habil se cuenta desde el envio (lunes) hasta la subida, excluye fines de semana', () => {
  // enviada lunes 2026-01-05, subida lunes 2026-01-12 -> 5 dias habiles (mar..lun)
  const r = calcularEstadisticas([
    fila({
      enviada_en: '2026-01-05T09:00:00',
      subida_en: '2026-01-12',
      estado_carpeta: 'SUBIDA A CONASET',
    }),
  ]);
  assert.equal(r.demoraPromedio, 5);
  assert.equal(r.dentroDePlazo, 1);
  assert.equal(r.porcentajeEnPlazo, 100);
});

test('subida antes o el mismo dia del envio cuenta demora 0', () => {
  const r = calcularEstadisticas([
    fila({ enviada_en: '2026-01-05T09:00:00', subida_en: '2026-01-05', estado_carpeta: 'SUBIDA A CONASET' }),
  ]);
  assert.equal(r.demoraPromedio, 0);
});

test('demora fuera de plazo (mas de 15 dias habiles) no cuenta como dentro de plazo', () => {
  // lunes 2026-01-05 + 16 dias habiles -> martes 2026-01-27
  const r = calcularEstadisticas([
    fila({ enviada_en: '2026-01-05T09:00:00', subida_en: '2026-01-27', estado_carpeta: 'SUBIDA A CONASET' }),
  ]);
  assert.equal(r.demoraPromedio, 16);
  assert.equal(r.dentroDePlazo, 0);
  assert.equal(r.porcentajeEnPlazo, 0);
});

test('ranking de volumen: top 12 por cantidad desc, empate por nombre asc, y volumenMaximo', () => {
  const filas = [];
  for (let i = 0; i < 3; i++) filas.push(fila({ comuna: 'Valparaiso' }));
  for (let i = 0; i < 5; i++) filas.push(fila({ comuna: 'Viña del Mar' }));
  filas.push(fila({ comuna: 'Quilpue' }));
  const r = calcularEstadisticas(filas);
  assert.deepEqual(
    r.rankingVolumen.map((x) => x.comuna),
    ['Viña del Mar', 'Valparaiso', 'Quilpue'],
  );
  assert.equal(r.rankingVolumen[0].cantidad, 5);
  assert.equal(r.volumenMaximo, 5);
});

test('porComuna: ordena por demora promedio desc (sin cerrar al final), luego solicitadas desc, luego nombre', () => {
  const r = calcularEstadisticas([
    fila({ comuna: 'A', enviada_en: '2026-01-05T09:00:00', subida_en: '2026-01-06', estado_carpeta: 'SUBIDA A CONASET' }), // demora 1
    fila({ comuna: 'B', enviada_en: '2026-01-05T09:00:00', subida_en: '2026-01-12', estado_carpeta: 'SUBIDA CON F8' }), // demora 5
    fila({ comuna: 'C', subida_en: null }), // sin cerrar
  ]);
  assert.deepEqual(
    r.porComuna.map((x) => x.comuna),
    ['B', 'A', 'C'],
  );
  assert.equal(r.porComuna[2].demoraPromedio, null);
  assert.equal(r.porComuna[2].porcentajeEnPlazo, null);
});
