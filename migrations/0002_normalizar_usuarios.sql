-- Normaliza usuarios.usuario (trim + lowercase) para las filas que ya existen
-- en produccion y que fueron creadas ANTES de que worker/lib/usuarios.js
-- normalizara el nombre en alta/edicion/login (ver commit que agrega
-- normalizarUsuario). Motivo: en produccion existen dos filas, "RAUL "
-- (con espacio final) y "Raul", que nunca calzaban entre si ni con el login
-- porque porUsuario comparaba con `WHERE usuario = ?` exacto.
--
-- OJO: esta migracion NO agrega un indice/constraint UNIQUE sobre la forma
-- normalizada, porque en produccion ya existe ese caso de colision ("RAUL "
-- y "Raul" normalizan ambos a "raul") y un UNIQUE fallaria al aplicar la
-- migracion. En vez de eso, la UPDATE de abajo normaliza cada fila SOLO SI
-- ninguna OTRA fila ya normaliza al mismo valor (evita crear una colision
-- nueva contra la columna UNIQUE (usuarios.usuario) que ya existe desde
-- 0001_init.sql). Las filas en colision (como "RAUL "/"Raul") quedan tal cual
-- estan, para que un admin decida cual de las dos borrar desde
-- /configuracion.html (ver worker/routes/usuarios.js, DELETE /usuarios/:id).
UPDATE usuarios
SET usuario = lower(trim(usuario))
WHERE usuario <> lower(trim(usuario))
  AND NOT EXISTS (
    SELECT 1 FROM usuarios AS otro
    WHERE otro.id <> usuarios.id
      AND lower(trim(otro.usuario)) = lower(trim(usuarios.usuario))
  );

-- Indice de expresion (no-unique, a proposito: ver comentario arriba) para
-- que el login y el alta, que ahora consultan por `lower(trim(usuario))`, no
-- hagan table scan en tablas de usuarios grandes.
CREATE INDEX IF NOT EXISTS idx_usuarios_usuario_norm ON usuarios (lower(trim(usuario)));
