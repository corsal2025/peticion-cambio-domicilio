import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import { crearUsuario, porUsuario, verificarClave, listarUsuarios } from '../worker/lib/usuarios.js';

test('crearUsuario guarda hash+salt, nunca la clave en texto plano', async () => {
  const db = crearD1Fake();
  await crearUsuario(db, { usuario: 'jperez', nombre: 'Juan Perez', rol: 'admin', clave: 'clave-secreta' });

  const u = await porUsuario(db, 'jperez');
  assert.ok(u.hash);
  assert.ok(u.salt);
  assert.notEqual(u.hash, 'clave-secreta');
  assert.equal(u.rol, 'admin');
});

test('verificarClave valida correctamente la clave correcta e incorrecta', async () => {
  const db = crearD1Fake();
  await crearUsuario(db, { usuario: 'jperez', clave: 'clave-secreta', rol: 'staff' });
  const u = await porUsuario(db, 'jperez');

  assert.equal(await verificarClave('clave-secreta', u.hash, u.salt), true);
  assert.equal(await verificarClave('clave-incorrecta', u.hash, u.salt), false);
});

test('porUsuario retorna null si no existe', async () => {
  const db = crearD1Fake();
  assert.equal(await porUsuario(db, 'no-existe'), null);
});

test('listarUsuarios retorna todos los usuarios activos', async () => {
  const db = crearD1Fake();
  await crearUsuario(db, { usuario: 'admin1', clave: 'x', rol: 'admin' });
  await crearUsuario(db, { usuario: 'staff1', clave: 'x', rol: 'staff' });

  const lista = await listarUsuarios(db);
  assert.equal(lista.length, 2);
});
