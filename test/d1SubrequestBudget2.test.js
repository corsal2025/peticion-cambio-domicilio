// Mismo presupuesto de subrequests D1 que d1SubrequestBudget.test.js, pero
// para los otros paths que loopeaban D1 por item: marcar-todas, encolar
// envios (un envio con muchas peticiones de una misma comuna) y el marcado
// masivo de "enviada"/"SinCorreoComuna" tras un envio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';
import { upsertPeticion, marcarTodas, marcarPeticion } from '../worker/lib/peticiones.js';
import { encolarEnvios } from '../worker/lib/mail.js';
import { obtenerPendientes, reportarResultado } from '../worker/lib/relay.js';

const MAX_CALLS = 6;
const MAX_STATEMENTS = 45;

async function crearPeticiones(db, n, comuna = 'CONCEPCION') {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const { id } = await upsertPeticion(db, {
      nombreCompleto: `Persona ${i}`,
      rut: `${20000000 + i}-K`,
      comuna,
    });
    ids.push(id);
  }
  return ids;
}

test('marcarTodas con 300 ids usa pocos D1 calls/statements', async () => {
  const db = crearD1Fake();
  const ids = await crearPeticiones(db, 300);

  db.resetStats();
  await marcarTodas(db, ids, true);

  const { calls, statements } = db.stats();
  assert.ok(calls <= MAX_CALLS, `esperaba <= ${MAX_CALLS} D1 calls, uso ${calls}`);
  assert.ok(statements <= MAX_STATEMENTS, `esperaba <= ${MAX_STATEMENTS} statements, uso ${statements}`);
});

test('encolarEnvios con un envio de 300 peticiones (misma comuna) usa pocos D1 calls/statements', async () => {
  const db = crearD1Fake();
  const ids = await crearPeticiones(db, 300, 'CONCEPCION');
  for (const id of ids) await marcarPeticion(db, id, true);

  db.resetStats();
  await encolarEnvios(db, [{ para: 'concepcion@muni.cl', asunto: 'S', cuerpo: 'C', peticionIds: ids }]);

  const { calls, statements } = db.stats();
  assert.ok(calls <= MAX_CALLS, `esperaba <= ${MAX_CALLS} D1 calls, uso ${calls}`);
  assert.ok(statements <= MAX_STATEMENTS, `esperaba <= ${MAX_STATEMENTS} statements, uso ${statements}`);
});

test('reportarResultado(ok) de un envio con 300 peticiones marca todas usando pocos D1 calls', async () => {
  const db = crearD1Fake();
  const ids = await crearPeticiones(db, 300, 'CONCEPCION');
  for (const id of ids) await marcarPeticion(db, id, true);
  await encolarEnvios(db, [{ para: 'concepcion@muni.cl', asunto: 'S', cuerpo: 'C', peticionIds: ids }]);

  const [envio] = await obtenerPendientes(db, 10);

  db.resetStats();
  const r = await reportarResultado(db, envio.id, true, 'ok', envio.lease_token);
  assert.equal(r.ok, true);

  const { calls, statements } = db.stats();
  assert.ok(calls <= MAX_CALLS, `esperaba <= ${MAX_CALLS} D1 calls, uso ${calls}`);
  assert.ok(statements <= MAX_STATEMENTS, `esperaba <= ${MAX_STATEMENTS} statements, uso ${statements}`);
});

test('POST /peticiones/enviar con muchas peticiones SinCorreoComuna usa pocos D1 calls', async () => {
  const db = crearD1Fake();
  // Comuna sin correo registrado en el directorio: todas las peticiones de
  // esa comuna terminan en el grupo "sinCorreo".
  const ids = await crearPeticiones(db, 200, 'COMUNA-SIN-CORREO');
  for (const id of ids) await marcarPeticion(db, id, true);

  const env = { DB: db, SESSION_SECRET: 'secreto-test', MASTER_PIN: '1234' };
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', clave: '1234' }),
  }, env);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  db.resetStats();
  const res = await app.request('/api/peticiones/enviar', { method: 'POST', headers: { Cookie: cookie } }, env);
  assert.equal(res.status, 200);

  const { calls, statements } = db.stats();
  assert.ok(calls <= MAX_CALLS, `esperaba <= ${MAX_CALLS} D1 calls, uso ${calls}`);
  assert.ok(statements <= MAX_STATEMENTS, `esperaba <= ${MAX_STATEMENTS} statements, uso ${statements}`);
});
