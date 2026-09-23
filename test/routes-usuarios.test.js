import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { app } from '../worker/app.js';
import { crearUsuario, porId, verificarClave } from '../worker/lib/usuarios.js';

function env(db) {
  return { DB: db, SESSION_SECRET: 'secreto-test', MASTER_PIN: '1234' };
}

async function cookieAdmin(e) {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', clave: '1234' }),
  }, e);
  return res.headers.get('set-cookie').split(';')[0];
}

async function cookieDe(e, usuario, clave) {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, clave }),
  }, e);
  return res.headers.get('set-cookie').split(';')[0];
}

test('POST /api/usuarios responde 409 si el usuario normalizado ya existe', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };

  await app.request('/api/usuarios', { method: 'POST', headers, body: JSON.stringify({ usuario: 'jperez', clave: 'clave123' }) }, e);
  const res = await app.request('/api/usuarios', { method: 'POST', headers, body: JSON.stringify({ usuario: '  JPerez', clave: 'otra' }) }, e);
  assert.equal(res.status, 409);
});

test('PUT /api/usuarios/:id edita nombre, rol y activo', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const { id } = await crearUsuario(db, { usuario: 'staff1', clave: 'x', rol: 'staff' });

  const res = await app.request(`/api/usuarios/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ nombre: 'Staff Uno', rol: 'admin', activo: false }),
  }, e);
  assert.equal(res.status, 200);

  const u = await porId(db, id);
  assert.equal(u.nombre, 'Staff Uno');
  assert.equal(u.rol, 'admin');
  assert.equal(u.activo, 0);
});

test('PUT /api/usuarios/:id sobre usuario inexistente responde 404', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };

  const res = await app.request('/api/usuarios/9999', { method: 'PUT', headers, body: JSON.stringify({ nombre: 'x' }) }, e);
  assert.equal(res.status, 404);
});

test('PUT /api/usuarios/:id no permite que el admin se desactive a si mismo', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };

  // El PIN maestro crea la sesion 'admin' sin fila propia en la tabla; para
  // probar el auto-bloqueo creamos un admin real con clave.
  const { id } = await crearUsuario(db, { usuario: 'admin1', clave: 'clave-admin', rol: 'admin' });
  const headersAdmin1 = { Cookie: await cookieDe(e, 'admin1', 'clave-admin'), 'Content-Type': 'application/json' };

  const res = await app.request(`/api/usuarios/${id}`, { method: 'PUT', headers: headersAdmin1, body: JSON.stringify({ activo: false }) }, e);
  assert.equal(res.status, 409);
  const u = await porId(db, id);
  assert.equal(u.activo, 1);
});

test('PUT /api/usuarios/:id no permite desactivar/degradar al ultimo admin activo', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const { id } = await crearUsuario(db, { usuario: 'admin1', clave: 'clave-admin', rol: 'admin' });

  const desactivar = await app.request(`/api/usuarios/${id}`, { method: 'PUT', headers, body: JSON.stringify({ activo: false }) }, e);
  assert.equal(desactivar.status, 409);

  const degradar = await app.request(`/api/usuarios/${id}`, { method: 'PUT', headers, body: JSON.stringify({ rol: 'staff' }) }, e);
  assert.equal(degradar.status, 409);
});

test('PUT /api/usuarios/:id permite desactivar a un admin si hay otro admin activo', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const { id: idA } = await crearUsuario(db, { usuario: 'admin1', clave: 'x', rol: 'admin' });
  await crearUsuario(db, { usuario: 'admin2', clave: 'x', rol: 'admin' });

  const res = await app.request(`/api/usuarios/${idA}`, { method: 'PUT', headers, body: JSON.stringify({ activo: false }) }, e);
  assert.equal(res.status, 200);
});

test('POST /api/usuarios/:id/clave (reset de admin) cambia la clave sin pedir la anterior', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const { id } = await crearUsuario(db, { usuario: 'staff1', clave: 'vieja' });

  const res = await app.request(`/api/usuarios/${id}/clave`, { method: 'POST', headers, body: JSON.stringify({ clave: 'clave-nueva' }) }, e);
  assert.equal(res.status, 200);

  const u = await porId(db, id);
  assert.equal(await verificarClave('clave-nueva', u.hash, u.salt), true);
});

test('POST /api/usuarios/:id/clave nunca devuelve hash/salt en la respuesta', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const { id } = await crearUsuario(db, { usuario: 'staff1', clave: 'vieja' });

  const res = await app.request(`/api/usuarios/${id}/clave`, { method: 'POST', headers, body: JSON.stringify({ clave: 'clave-nueva' }) }, e);
  const cuerpo = await res.json();
  assert.equal('hash' in cuerpo, false);
  assert.equal('salt' in cuerpo, false);
});

test('DELETE /api/usuarios/:id elimina un usuario staff', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const { id } = await crearUsuario(db, { usuario: 'staff1', clave: 'x' });

  const res = await app.request(`/api/usuarios/${id}`, { method: 'DELETE', headers }, e);
  assert.equal(res.status, 200);
  assert.equal(await porId(db, id), null);
});

test('DELETE /api/usuarios/:id no permite que el admin se elimine a si mismo', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const { id } = await crearUsuario(db, { usuario: 'admin1', clave: 'clave-admin', rol: 'admin' });
  const headersAdmin1 = { Cookie: await cookieDe(e, 'admin1', 'clave-admin'), 'Content-Type': 'application/json' };

  const res = await app.request(`/api/usuarios/${id}`, { method: 'DELETE', headers: headersAdmin1 }, e);
  assert.equal(res.status, 409);
  assert.ok(await porId(db, id));
});

test('DELETE /api/usuarios/:id no permite eliminar al ultimo admin activo', async () => {
  const db = crearD1Fake();
  const e = env(db);
  const headers = { Cookie: await cookieAdmin(e), 'Content-Type': 'application/json' };
  const { id } = await crearUsuario(db, { usuario: 'admin1', clave: 'x', rol: 'admin' });

  const res = await app.request(`/api/usuarios/${id}`, { method: 'DELETE', headers }, e);
  assert.equal(res.status, 409);
  assert.ok(await porId(db, id));
});

test('rol staff no puede gestionar usuarios (soloAdmin) responde 403', async () => {
  const db = crearD1Fake();
  const e = env(db);
  await crearUsuario(db, { usuario: 'staff1', clave: 'clave123', rol: 'staff' });
  const headers = { Cookie: await cookieDe(e, 'staff1', 'clave123'), 'Content-Type': 'application/json' };

  const res = await app.request('/api/usuarios', { headers }, e);
  assert.equal(res.status, 403);
});
