import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, buildSendMailRequest, enviarEws } from '../worker/lib/ews.js';

test('classify: 2xx es accept', () => {
  assert.equal(classify(200), 'accept');
  assert.equal(classify(201), 'accept');
});

test('classify: 401/403 es failAuth', () => {
  assert.equal(classify(401), 'failAuth');
  assert.equal(classify(403), 'failAuth');
});

test('classify: 429/500/502/503/504/408/425 es retry', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classify(s), 'retry');
  }
});

test('classify: otros codigos es failPermanent', () => {
  assert.equal(classify(400), 'failPermanent');
  assert.equal(classify(404), 'failPermanent');
});

test('buildSendMailRequest incluye destinatario, asunto y cuerpo', () => {
  const xml = buildSendMailRequest('comuna@example.com', 'Asunto', 'Cuerpo del correo');
  assert.match(xml, /comuna@example\.com/);
  assert.match(xml, /Asunto/);
  assert.match(xml, /Cuerpo del correo/);
  assert.doesNotMatch(xml, /<t:From>/);
});

test('buildSendMailRequest agrega From cuando hay sendAsAddress', () => {
  const xml = buildSendMailRequest('comuna@example.com', 'Asunto', 'Cuerpo', 'oficina@muni.cl');
  assert.match(xml, /<t:From>/);
  assert.match(xml, /oficina@muni\.cl/);
});

test('enviarEws: exito al primer intento no reintenta', async () => {
  let llamadas = 0;
  const fetchImpl = async () => {
    llamadas++;
    return { status: 200, text: async () => '<Envelope/>' };
  };
  await enviarEws(
    { url: 'https://ews.local', usuario: 'u', clave: 'p' },
    { to: 'a@b.cl', subject: 's', body: 'c' },
    { fetchImpl, sleep: async () => {} },
  );
  assert.equal(llamadas, 1);
});

test('enviarEws: 401 corta de inmediato sin reintentar', async () => {
  let llamadas = 0;
  const fetchImpl = async () => {
    llamadas++;
    return { status: 401, text: async () => '' };
  };
  await assert.rejects(
    enviarEws(
      { url: 'https://ews.local', usuario: 'u', clave: 'p' },
      { to: 'a@b.cl', subject: 's', body: 'c' },
      { fetchImpl, sleep: async () => {} },
    ),
    /credenciales|auth/i,
  );
  assert.equal(llamadas, 1);
});

test('enviarEws: transitorio reintenta hasta 4 veces con backoff creciente', async () => {
  let llamadas = 0;
  const delays = [];
  const fetchImpl = async () => {
    llamadas++;
    return { status: 503, text: async () => '' };
  };
  const sleep = async (ms) => { delays.push(ms); };
  await assert.rejects(
    enviarEws(
      { url: 'https://ews.local', usuario: 'u', clave: 'p' },
      { to: 'a@b.cl', subject: 's', body: 'c' },
      { fetchImpl, sleep },
    ),
  );
  assert.equal(llamadas, 4);
  assert.deepEqual(delays, [2000, 4000, 8000]);
});

test('enviarEws: exito luego de un fallo transitorio', async () => {
  let llamadas = 0;
  const fetchImpl = async () => {
    llamadas++;
    if (llamadas === 1) return { status: 502, text: async () => '' };
    return { status: 200, text: async () => '<Envelope/>' };
  };
  await enviarEws(
    { url: 'https://ews.local', usuario: 'u', clave: 'p' },
    { to: 'a@b.cl', subject: 's', body: 'c' },
    { fetchImpl, sleep: async () => {} },
  );
  assert.equal(llamadas, 2);
});
