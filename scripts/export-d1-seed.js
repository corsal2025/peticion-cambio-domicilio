#!/usr/bin/env node
// Migracion unica de datos: lee publish/data/peticiones.db (SQLite, tabla
// Peticion del .exe .NET) + publish/data/comunas.csv y genera un seed SQL
// (migrations/seed/0002_datos.sql, gitignorado) listo para
// `wrangler d1 execute --file`. Preserva Marcada/Estado/EnviadaEn/
// DestinatariosCorreo tal cual estan en SQLite y corrige nombres de comuna
// conocidos (CONCECPION -> CONCEPCION).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Estado enum del .NET (Domain/Peticion.cs): 0=Borrador,1=Enviada,2=SinCorreoComuna,3=Error.
const ESTADOS = ['Borrador', 'Enviada', 'SinCorreoComuna', 'Error'];

// Nombres de comuna conocidos con error de tipeo en los datos originales.
const CORRECCIONES_COMUNA = {
  CONCECPION: 'CONCEPCION',
};

function corregirComuna(nombre) {
  const n = String(nombre ?? '').trim().toUpperCase();
  return CORRECCIONES_COMUNA[n] ?? n;
}

function rutNorm(rut) {
  return String(rut ?? '').toUpperCase().replace(/[^0-9K]/g, '');
}

function fold(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function sqlValor(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Parser CSV minimo (comillas dobles, coma como separador) para comunas.csv. */
function parseCsv(texto) {
  const limpio = texto.replace(/^﻿/, '');
  const lineas = limpio.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lineas.length === 0) return [];
  const parseLinea = (linea) => {
    const cols = [];
    let actual = '';
    let dentroComillas = false;
    for (let i = 0; i < linea.length; i++) {
      const ch = linea[i];
      if (ch === '"') {
        dentroComillas = !dentroComillas;
      } else if (ch === ',' && !dentroComillas) {
        cols.push(actual);
        actual = '';
      } else {
        actual += ch;
      }
    }
    cols.push(actual);
    return cols.map((c) => c.trim());
  };
  const cabecera = parseLinea(lineas[0]).map((h) => h.toLowerCase());
  const idxNombre = cabecera.indexOf('comuna');
  const idxCorreo = cabecera.indexOf('contactemail');
  return lineas.slice(1).map((linea) => {
    const cols = parseLinea(linea);
    return { nombre: cols[idxNombre], correo: cols[idxCorreo] };
  });
}

/**
 * Genera el seed SQL a partir de la base SQLite y el CSV de comunas.
 * @param {{dbPath:string, csvPath:string, outPath:string}} opciones
 * @returns {Promise<{peticiones:number, comunas:number}>}
 */
export async function generarSeed({ dbPath, csvPath, outPath }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const filas = db.prepare('SELECT * FROM Peticion ORDER BY Id').all();
  db.close();

  const csvTexto = readFileSync(csvPath, 'utf8');
  const comunasCsv = parseCsv(csvTexto);

  const statements = [];

  // ---------- comunas ----------
  const comunasVistas = new Set();
  for (const fila of comunasCsv) {
    const nombre = corregirComuna(fila.nombre);
    const norm = fold(nombre);
    if (!nombre || comunasVistas.has(norm)) continue;
    comunasVistas.add(norm);
    statements.push(
      `INSERT INTO comunas (nombre, nombre_norm, correos) VALUES (${sqlValor(nombre)}, ${sqlValor(norm)}, ${sqlValor(fila.correo || null)}) ON CONFLICT(nombre_norm) DO UPDATE SET correos = excluded.correos;`,
    );
  }

  // ---------- peticiones ----------
  for (const p of filas) {
    const comuna = corregirComuna(p.Comuna);
    const estado = ESTADOS[p.Estado] ?? 'Borrador';
    statements.push(
      `INSERT INTO peticiones (id, nombre_completo, rut, rut_norm, comuna, comuna_norm, clases, fecha_solicitud, ` +
        `oficina, origen, orden_importacion, marcada, rut_invalido, estado, detalle_estado, creada_en, enviada_en, ` +
        `destinatarios_correo, estado_carpeta, subida_en) VALUES (` +
        [
          sqlValor(p.Id),
          sqlValor(p.NombreCompleto),
          sqlValor(p.Rut),
          sqlValor(rutNorm(p.Rut)),
          sqlValor(comuna),
          sqlValor(fold(comuna)),
          sqlValor(p.Clases),
          sqlValor(p.FechaSolicitud),
          sqlValor(p.Oficina),
          sqlValor(p.Origen),
          sqlValor(p.OrdenImportacion ?? 0),
          sqlValor(p.Marcada ? 1 : 0),
          sqlValor(p.RutInvalido ? 1 : 0),
          sqlValor(estado),
          sqlValor(p.DetalleEstado),
          sqlValor(p.CreadaEn),
          sqlValor(p.EnviadaEn),
          sqlValor(p.DestinatariosCorreo),
          sqlValor(p.EstadoCarpeta),
          sqlValor(p.SubidaEn),
        ].join(', ') +
        `) ON CONFLICT(id) DO NOTHING;`,
    );
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, statements.join('\n') + '\n', 'utf8');

  return { peticiones: filas.length, comunas: comunasVistas.size };
}

// Ejecucion directa: node scripts/export-d1-seed.js
const esEjecutadoDirectamente = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (esEjecutadoDirectamente || (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))) {
  const dbPath = process.argv[2] || path.join(__dirname, '..', 'publish', 'data', 'peticiones.db');
  const csvPath = process.argv[3] || path.join(__dirname, '..', 'publish', 'data', 'comunas.csv');
  const outPath = process.argv[4] || path.join(__dirname, '..', 'migrations', 'seed', '0002_datos.sql');
  generarSeed({ dbPath, csvPath, outPath }).then((resumen) => {
    console.log(`Seed generado en ${outPath}: ${resumen.peticiones} peticiones, ${resumen.comunas} comunas.`);
  });
}
