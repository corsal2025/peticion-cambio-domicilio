import test from 'node:test';
import assert from 'node:assert/strict';
import { crearD1Fake } from './support/d1Fake.js';
import {
  crearUsuario,
  porUsuario,
  porUsuarioTodos,
  verificarClave,
  listarUsuarios,
  normalizarUsuario,
  actualizarUsuario,
  actualizarClave,
  eliminarUsuario,
  contarAdminsActivos,
  porId,
} from '../worker/lib/usuarios.js';

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

test('listarUsuarios incluye tambien a los usuarios inactivos (para poder reactivarlos)', async () => {
  const db = crearD1Fake();
  const { id } = await crearUsuario(db, { usuario: 'staff1', clave: 'x', rol: 'staff' });
  await actualizarUsuario(db, id, { activo: false });

  const lista = await listarUsuarios(db);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].activo, 0);
});

test('normalizarUsuario recorta espacios y pasa a minusculas', () => {
  assert.equal(normalizarUsuario('  JPerez '), 'jperez');
  assert.equal(normalizarUsuario('RAUL '), 'raul');
  assert.equal(normalizarUsuario(null), '');
});

test('crearUsuario normaliza el nombre de usuario (trim + lowercase)', async () => {
  const db = crearD1Fake();
  await crearUsuario(db, { usuario: '  JPerez ', clave: 'clave-secreta' });

  const u = await porUsuario(db, 'jperez');
  assert.ok(u);
  assert.equal(u.usuario, 'jperez');
});

test('crearUsuario responde con status 409 si el nombre normalizado ya existe', async () => {
  const db = crearD1Fake();
  await crearUsuario(db, { usuario: 'jperez', clave: 'clave-secreta' });

  await assert.rejects(
    () => crearUsuario(db, { usuario: '  JPEREZ', clave: 'otra-clave' }),
    (err) => {
      assert.equal(err.status, 409);
      return true;
    },
  );
});

test('porUsuario matchea filas existentes sin normalizar (usuario con espacios/mayusculas)', async () => {
  const db = crearD1Fake();
  await db.prepare('INSERT INTO usuarios (usuario, nombre, rol) VALUES (?, ?, ?)').bind('RAUL ', 'Raul', 'staff').run();

  const u = await porUsuario(db, 'raul');
  assert.ok(u);
  assert.equal(u.usuario, 'RAUL ');
});

test('porUsuarioTodos retorna todas las filas duplicadas que matchean el nombre normalizado', async () => {
  const db = crearD1Fake();
  await db.prepare('INSERT INTO usuarios (usuario, nombre, rol) VALUES (?, ?, ?)').bind('RAUL ', 'Raul viejo', 'staff').run();
  await db.prepare('INSERT INTO usuarios (usuario, nombre, rol) VALUES (?, ?, ?)').bind('Raul', 'Raul nuevo', 'admin').run();

  const candidatos = await porUsuarioTodos(db, ' raul');
  assert.equal(candidatos.length, 2);
});

test('actualizarUsuario modifica nombre, rol y activo', async () => {
  const db = crearD1Fake();
  const { id } = await crearUsuario(db, { usuario: 'staff1', clave: 'x', rol: 'staff' });
  await actualizarUsuario(db, id, { nombre: 'Nuevo Nombre', rol: 'admin', activo: false });

  const u = await porId(db, id);
  assert.equal(u.nombre, 'Nuevo Nombre');
  assert.equal(u.rol, 'admin');
  assert.equal(u.activo, 0);
});

test('actualizarClave cambia el hash/salt del usuario', async () => {
  const db = crearD1Fake();
  const { id } = await crearUsuario(db, { usuario: 'staff1', clave: 'vieja' });
  const antes = await porId(db, id);

  await actualizarClave(db, id, 'nueva-clave');
  const despues = await porId(db, id);

  assert.notEqual(despues.hash, antes.hash);
  assert.equal(await verificarClave('nueva-clave', despues.hash, despues.salt), true);
  assert.equal(await verificarClave('vieja', despues.hash, despues.salt), false);
});

test('eliminarUsuario borra la fila', async () => {
  const db = crearD1Fake();
  const { id } = await crearUsuario(db, { usuario: 'staff1', clave: 'x' });
  await eliminarUsuario(db, id);
  assert.equal(await porId(db, id), null);
});

test('contarAdminsActivos cuenta admins activos excluyendo un id dado', async () => {
  const db = crearD1Fake();
  const { id: idA } = await crearUsuario(db, { usuario: 'admin1', clave: 'x', rol: 'admin' });
  await crearUsuario(db, { usuario: 'admin2', clave: 'x', rol: 'admin' });

  assert.equal(await contarAdminsActivos(db, idA), 1);
  assert.equal(await contarAdminsActivos(db), 2);
});
