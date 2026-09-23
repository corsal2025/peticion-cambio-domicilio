import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';
import { crearUsuario, porUsuario } from '../worker/lib/usuarios.js';

function env(db) {
  return { DB: db, SESSION_SECRET: 'secreto-test', MASTER_PIN: '1234' };
}

test('sin SESSION_SECRET y sin DEV, login responde 500 (fail closed)', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'jefe', clave: '1234' }),
  }, { DB: db, MASTER_PIN: '1234' });
  assert.equal(res.status, 500);
});

test('sin SESSION_SECRET y sin DEV, rutas protegidas responden 500 (fail closed) en vez de 401', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/peticiones', {}, { DB: db, MASTER_PIN: '1234' });
  assert.equal(res.status, 500);
});

test('sin SESSION_SECRET pero con DEV=1, usa fallback local y funciona', async () => {
  const db = crearD1Fake();
  const e = { DB: db, MASTER_PIN: '1234', DEV: '1' };
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', clave: '1234' }),
  }, e);
  assert.equal(loginRes.status, 200);
});

test('GET /api/peticiones sin sesion responde 401', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/peticiones', {}, env(db));
  assert.equal(res.status, 401);
});

test('login con PIN maestro y usuario "admin" crea sesion admin y permite acceso', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', clave: '1234' }),
  }, e);
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie');
  assert.ok(cookie);

  const cookieValor = cookie.split(';')[0];
  const protegidaRes = await app.request('/api/peticiones', { headers: { Cookie: cookieValor } }, e);
  assert.equal(protegidaRes.status, 200);
});

test('login con PIN maestro y usuario arbitrario inexistente NO otorga admin', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'quiensea', clave: '1234' }),
  }, env(db));
  assert.equal(res.status, 401);
});

test('login con PIN maestro sobre usuario staff EXISTENTE sin clave le da su propio rol, no admin', async () => {
  const db = crearD1Fake();
  const e = env(db);
  await db.prepare('INSERT INTO usuarios (usuario, nombre, rol) VALUES (?, ?, ?)').bind('staffsinclave', 'staffsinclave', 'staff').run();
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'staffsinclave', clave: '1234' }),
  }, e);
  assert.equal(loginRes.status, 200);
  const cuerpo = await loginRes.json();
  assert.equal(cuerpo.rol, 'staff');
});

test('rate limit: bloquea login tras 5 fallos seguidos con la misma ip+usuario', async () => {
  const db = crearD1Fake();
  const e = env(db);
  for (let i = 0; i < 5; i++) {
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: 'jefe', clave: 'mala' }),
    }, e);
  }
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'jefe', clave: '1234' }),
  }, e);
  assert.equal(res.status, 429);
});

test('rate limit: login exitoso limpia el contador de fallos', async () => {
  const db = crearD1Fake();
  const e = env(db);
  for (let i = 0; i < 4; i++) {
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: 'admin', clave: 'mala' }),
    }, e);
  }
  const ok = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', clave: '1234' }),
  }, e);
  assert.equal(ok.status, 200);
  const siguiente = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', clave: 'mala' }),
  }, e);
  assert.equal(siguiente.status, 401);
});

test('rate limit: x-forwarded-for se ignora, solo CF-Connecting-IP cuenta', async () => {
  const db = crearD1Fake();
  const e = env(db);
  for (let i = 0; i < 5; i++) {
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9', 'x-forwarded-for': `1.1.1.${i}` },
      body: JSON.stringify({ usuario: 'zeta', clave: 'mala' }),
    }, e);
  }
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9', 'x-forwarded-for': 'no-deberia-importar' },
    body: JSON.stringify({ usuario: 'zeta', clave: '1234' }),
  }, e);
  assert.equal(res.status, 429);
});

test('rate limit global: tope por usuario aunque cada intento venga de una CF-Connecting-IP distinta', async () => {
  const db = crearD1Fake();
  const e = env(db);
  for (let i = 0; i < 20; i++) {
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `8.8.8.${i}` },
      body: JSON.stringify({ usuario: 'rotador', clave: 'mala' }),
    }, e);
  }
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '8.8.8.99' },
    body: JSON.stringify({ usuario: 'rotador', clave: '1234' }),
  }, e);
  assert.equal(res.status, 429);
});

test('login matchea el usuario guardado aunque se ingresen espacios/mayusculas distintas', async () => {
  const db = crearD1Fake();
  const e = env(db);
  await crearUsuario(db, { usuario: 'jperez', rol: 'staff', clave: 'clave123' });

  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: '  JPerez ', clave: 'clave123' }),
  }, e);
  assert.equal(res.status, 200);
  const cuerpo = await res.json();
  assert.equal(cuerpo.usuario, 'jperez');
});

test('login con filas duplicadas (mismo nombre normalizado): prueba la clave contra cada candidato', async () => {
  const db = crearD1Fake();
  const e = env(db);
  // Simula el estado de produccion: dos filas que normalizan a "raul", creadas
  // antes de la normalizacion (una con espacio final, otra distinta mayuscula).
  // Insertadas directo por SQL (no via crearUsuario) porque el alta ya
  // rechaza nombres duplicados normalizados; esto reproduce datos viejos.
  const dbTemp = crearD1Fake();
  await crearUsuario(dbTemp, { usuario: 'raul-temp', clave: 'clave-correcta' });
  const { hash, salt } = await porUsuario(dbTemp, 'raul-temp');

  await db.prepare('INSERT INTO usuarios (usuario, nombre, rol) VALUES (?, ?, ?)').bind('RAUL ', 'Raul viejo', 'staff').run();
  await db
    .prepare('INSERT INTO usuarios (usuario, nombre, rol, hash, salt) VALUES (?, ?, ?, ?, ?)')
    .bind('Raul', 'Raul nuevo', 'admin', hash, salt)
    .run();

  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'raul', clave: 'clave-correcta' }),
  }, e);
  assert.equal(res.status, 200);
  const cuerpo = await res.json();
  assert.equal(cuerpo.rol, 'admin');
});

test('login con clave incorrecta responde 401', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'jefe', clave: 'incorrecta' }),
  }, env(db));
  assert.equal(res.status, 401);
});

test('POST /api/auth/clave sin sesion responde 401', async () => {
  const db = crearD1Fake();
  const res = await app.request('/api/auth/clave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actual: 'x', nueva: 'nueva1234' }),
  }, env(db));
  assert.equal(res.status, 401);
});

test('POST /api/auth/clave con clave actual correcta cambia la clave propia', async () => {
  const db = crearD1Fake();
  const e = env(db);
  await crearUsuario(db, { usuario: 'staff1', rol: 'staff', clave: 'clave-vieja' });
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'staff1', clave: 'clave-vieja' }),
  }, e);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const res = await app.request('/api/auth/clave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ actual: 'clave-vieja', nueva: 'clave-nueva' }),
  }, e);
  assert.equal(res.status, 200);

  const relogin = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'staff1', clave: 'clave-nueva' }),
  }, e);
  assert.equal(relogin.status, 200);
});

test('POST /api/auth/clave con clave actual incorrecta responde 401 y no cambia nada', async () => {
  const db = crearD1Fake();
  const e = env(db);
  await crearUsuario(db, { usuario: 'staff1', rol: 'staff', clave: 'clave-vieja' });
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'staff1', clave: 'clave-vieja' }),
  }, e);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const res = await app.request('/api/auth/clave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ actual: 'no-es-esta', nueva: 'clave-nueva' }),
  }, e);
  assert.equal(res.status, 401);
});

test('POST /api/auth/clave sin clave previa (login por PIN maestro) no exige clave actual', async () => {
  const db = crearD1Fake();
  const e = env(db);
  await db.prepare('INSERT INTO usuarios (usuario, nombre, rol) VALUES (?, ?, ?)').bind('staffsinclave', 'staffsinclave', 'staff').run();
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'staffsinclave', clave: '1234' }),
  }, e);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const res = await app.request('/api/auth/clave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ nueva: 'clave-nueva' }),
  }, e);
  assert.equal(res.status, 200);
});

test('rol staff intenta configuracion (soloAdmin) responde 403', async () => {
  const db = crearD1Fake();
  const e = env(db);
  await crearUsuario(db, { usuario: 'staff1', rol: 'staff', clave: 'clave123' });

  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'staff1', clave: 'clave123' }),
  }, e);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const res = await app.request('/api/config', { headers: { Cookie: cookie } }, e);
  assert.equal(res.status, 403);
});
