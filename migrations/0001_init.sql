-- Esquema D1 de peticiones de cambio de domicilio.
-- Reemplaza la persistencia SQLite (data/peticiones.db) del .exe .NET.
-- Clave natural de deduplicacion: (rut_norm, comuna_norm), igual que Peticion.cs (AddIfNew).

CREATE TABLE IF NOT EXISTS peticiones (
  id                    INTEGER PRIMARY KEY,
  nombre_completo       TEXT NOT NULL,
  rut                   TEXT NOT NULL,
  rut_norm              TEXT NOT NULL,
  comuna                TEXT NOT NULL,
  comuna_norm           TEXT NOT NULL,
  clases                TEXT,
  fecha_solicitud       TEXT,
  oficina               TEXT,
  origen                TEXT,
  orden_importacion     INTEGER NOT NULL DEFAULT 0,
  marcada               INTEGER NOT NULL DEFAULT 0,
  rut_invalido          INTEGER NOT NULL DEFAULT 0,
  estado                TEXT NOT NULL DEFAULT 'Borrador'
                          CHECK (estado IN ('Borrador','EnCola','Enviada','SinCorreoComuna','Error')),
  detalle_estado        TEXT,
  creada_en             TEXT NOT NULL DEFAULT (datetime('now')),
  enviada_en            TEXT,
  destinatarios_correo  TEXT,
  estado_carpeta        TEXT NOT NULL DEFAULT 'CAMBIO DE DOMICILIO',
  subida_en             TEXT,
  UNIQUE (rut_norm, comuna_norm)
);

CREATE INDEX IF NOT EXISTS idx_peticiones_comuna_norm ON peticiones (comuna_norm);
CREATE INDEX IF NOT EXISTS idx_peticiones_estado ON peticiones (estado);

CREATE TABLE IF NOT EXISTS comunas (
  id             INTEGER PRIMARY KEY,
  nombre         TEXT NOT NULL,
  nombre_norm    TEXT NOT NULL UNIQUE,
  correos        TEXT,
  contacto       TEXT,
  telefono       TEXT,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id         INTEGER PRIMARY KEY,
  usuario    TEXT NOT NULL UNIQUE,
  nombre     TEXT,
  rol        TEXT NOT NULL DEFAULT 'staff' CHECK (rol IN ('admin','staff')),
  hash       TEXT,
  salt       TEXT,
  activo     INTEGER NOT NULL DEFAULT 1,
  creado_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS envios (
  id             INTEGER PRIMARY KEY,
  peticion_id    INTEGER REFERENCES peticiones(id),
  para           TEXT NOT NULL,
  asunto         TEXT NOT NULL,
  cuerpo_html    TEXT NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'pendiente'
                   CHECK (estado IN ('pendiente','tomado','enviado','error')),
  intentos       INTEGER NOT NULL DEFAULT 0,
  tomado_en      TEXT,
  resultado      TEXT,
  creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
  enviado_en     TEXT
);

CREATE INDEX IF NOT EXISTS idx_envios_estado ON envios (estado);

CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT
);

INSERT OR IGNORE INTO config (clave, valor) VALUES
  ('mail.mode', 'relay'),
  ('mail.test_email', ''),
  ('mail.send_as', '');

CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY,
  fuente      TEXT NOT NULL,
  recibidas   INTEGER NOT NULL DEFAULT 0,
  insertadas  INTEGER NOT NULL DEFAULT 0,
  actualizadas INTEGER NOT NULL DEFAULT 0,
  errores     INTEGER NOT NULL DEFAULT 0,
  en          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Feriados chilenos: vacia por defecto (paridad con DeadlineCalculator.cs, que NO
-- descuenta feriados). Se puede poblar despues sin cambiar codigo (ver plazos.js).
CREATE TABLE IF NOT EXISTS feriados (
  fecha  TEXT PRIMARY KEY,
  nombre TEXT
);

-- Claves (rut_norm|comuna_norm) vistas por cada lote de un import por batches
-- (Apps Script parte el libro en lotes de 500 filas via POST /api/import). La
-- limpieza de obsoletas NO corre por lote: se acumulan aca hasta que llega
-- POST /api/import/finalizar con el mismo syncId, que recien ahi calcula el
-- set completo de claves vigentes y ejecuta el borrado (una sola vez). Se
-- limpian las filas de un syncId al finalizar (ok o rechazado).
CREATE TABLE IF NOT EXISTS import_vistos (
  sync_id TEXT NOT NULL,
  clave   TEXT NOT NULL,
  PRIMARY KEY (sync_id, clave)
);

-- Progreso de lotes recibidos por syncId, para que /api/import/finalizar
-- pueda rechazar si aun faltan lotes por llegar.
CREATE TABLE IF NOT EXISTS import_lotes (
  sync_id      TEXT PRIMARY KEY,
  total_lotes  INTEGER,
  lotes_vistos INTEGER NOT NULL DEFAULT 0,
  hojas_leidas INTEGER,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
