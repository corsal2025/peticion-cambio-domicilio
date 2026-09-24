import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAZO_DIAS_HABILES, addBusinessDays, businessDaysBetween, plazoInfo } from '../worker/lib/plazos.js';

test('addBusinessDays salta fines de semana', () => {
  // viernes 2026-01-02 + 1 dia habil -> lunes 2026-01-05
  assert.equal(addBusinessDays('2026-01-02', 1), '2026-01-05');
});

test('addBusinessDays con 15 dias habiles desde un lunes', () => {
  // lunes 2026-01-05 + 15 dias habiles (3 semanas completas) -> lunes 2026-01-26
  assert.equal(addBusinessDays('2026-01-05', PLAZO_DIAS_HABILES), '2026-01-26');
});

test('addBusinessDays sin pasar feriados no descuenta ninguno (paridad con .NET, tabla feriados vacia)', () => {
  const sinFeriados = addBusinessDays('2026-01-05', 5);
  assert.equal(sinFeriados, '2026-01-12');
});

test('addBusinessDays con feriados explicitos SI los descuenta (activable sin cambiar codigo)', () => {
  const feriados = new Set(['2026-01-06']); // martes feriado, dentro del rango
  const conFeriados = addBusinessDays('2026-01-05', 5, feriados);
  assert.equal(conFeriados, '2026-01-13', 'con el feriado explicito, se corre un dia mas');
});

test('businessDaysBetween cuenta dias habiles excluyendo el de inicio', () => {
  assert.equal(businessDaysBetween('2026-01-05', '2026-01-09'), 4); // lun a vie
  assert.equal(businessDaysBetween('2026-01-05', '2026-01-05'), 0);
});

test('plazoInfo sin enviar: 15 dias restantes, sin vencer', () => {
  const info = plazoInfo({ enviadaEn: null }, new Date('2026-01-10'));
  assert.equal(info.inicio, null);
  assert.equal(info.vence, null);
  assert.equal(info.diasRestantes, 15);
  assert.equal(info.vencido, false);
});

test('plazoInfo vencida cuando pasaron mas de 15 dias habiles', () => {
  const info = plazoInfo({ enviadaEn: '2025-12-01T00:00:00' }, new Date('2026-01-15'));
  assert.equal(info.vencido, true);
  assert.ok(info.diasRestantes < 0);
});

test('plazoInfo usa la fecha local de Chile para "inicio", no el dia UTC', () => {
  // 2026-01-06T02:30:00Z = 2026-01-05 23:30 hora de Chile (UTC-3 en verano).
  // Truncar el ISO en UTC daria inicio=2026-01-06 (un dia adelantado).
  const info = plazoInfo({ enviadaEn: '2026-01-06T02:30:00.000Z' }, new Date('2026-01-10'));
  assert.equal(info.inicio, '2026-01-05');
});

test('plazoInfo usa la fecha local de Chile para "hoy", no el dia UTC', () => {
  // 2026-01-10T02:00:00Z = 2026-01-09 23:00 hora de Chile: "hoy" debe ser
  // 2026-01-09, no 2026-01-10 (que contaria un dia habil de mas).
  const info = plazoInfo({ enviadaEn: '2026-01-05T12:00:00.000Z' }, new Date('2026-01-10T02:00:00.000Z'));
  const esperado = plazoInfo({ enviadaEn: '2026-01-05T12:00:00.000Z' }, new Date('2026-01-09T15:00:00.000Z'));
  assert.equal(info.diasTranscurridos, esperado.diasTranscurridos);
});

test('plazoInfo en plazo cuando aun quedan dias', () => {
  const info = plazoInfo({ enviadaEn: '2026-01-05T00:00:00' }, new Date('2026-01-06'));
  assert.equal(info.vencido, false);
  assert.ok(info.diasRestantes > 0);
});
