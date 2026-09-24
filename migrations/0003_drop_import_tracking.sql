-- Elimina el tracking de progreso de import por syncId (import_vistos /
-- import_lotes). Ya no se usan: worker/lib/importar.js dejo de escribirlas en
-- CADA lote (una fila de import_vistos por clave + un upsert de import_lotes
-- por lote) porque, con ~4600 filas relevantes sincronizadas cada 15 min,
-- esas escrituras extra agotaban el limite diario de D1 free tier (100k rows
-- written/dia) sin aportar nada al negocio. El acumulado de claves CD
-- vigentes ahora viaja en memoria en Apps Script y se manda completo en el
-- body de POST /api/import/finalizar (clavesCD), y la completitud de lotes ya
-- la garantiza Apps Script (aborta antes de finalizar si un lote falla), asi
-- que no hace falta un tracking de progreso persistido en el worker.
DROP TABLE IF EXISTS import_vistos;
DROP TABLE IF EXISTS import_lotes;
