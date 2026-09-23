# Despliegue a Cloudflare (pasos manuales)

Todo lo de código ya está hecho (Batches 1-11 de la migración). Esto es lo que
falta hacer a mano — nada de esto lo puede hacer un agente porque toca cuentas
reales de Cloudflare, Google y la red municipal.

Verificado en local antes de este documento: `wrangler d1 migrations apply --local`,
seed de 176 peticiones + 267 comunas, `wrangler pages dev`, login, búsqueda, alta
manual, `/api/import`, `/api/relay/*`, `/api/mail/prueba` — todo contra D1 local,
sin tocar nada remoto. `npm test` (94/94) y `dotnet test` (84/84) en verde.

## 1. Crear la base D1 remota

```bash
npx wrangler d1 create peticion-cambio-domicilio-db
```

Copiar el `database_id` que devuelve y pegarlo en `wrangler.toml`
(reemplaza `REEMPLAZAR-DESPUES-DE-wrangler-d1-create`).

```bash
npx wrangler d1 migrations apply peticion-cambio-domicilio-db --remote
```

## 2. Cargar los datos reales

El seed ya está generado en `migrations/seed/0002_datos.sql` (gitignorado,
tiene PII real — no se sube a git). Si hace falta regenerarlo:

```bash
node scripts/export-d1-seed.js
```

Después subirlo a la base remota:

```bash
npx wrangler d1 execute peticion-cambio-domicilio-db --remote --file=migrations/seed/0002_datos.sql
```

## 3. Crear el proyecto Pages

```bash
npx wrangler pages project create peticion-cambio-domicilio
```

Conectar el repo (o hacer deploy directo la primera vez):

```bash
npx wrangler pages deploy public --project-name=peticion-cambio-domicilio
```

Confirmar en el dashboard de Cloudflare que el binding D1 `DB` (definido en
`wrangler.toml`) quedó asociado al proyecto Pages.

## 4. Secrets del proyecto Pages

Nombres exactos que usa el código (ver `worker/routes/*.js`, `worker/lib/*.js`):

```bash
npx wrangler pages secret put SESSION_SECRET --project-name=peticion-cambio-domicilio
npx wrangler pages secret put MASTER_PIN --project-name=peticion-cambio-domicilio
npx wrangler pages secret put IMPORT_SECRET --project-name=peticion-cambio-domicilio
npx wrangler pages secret put RELAY_SECRET --project-name=peticion-cambio-domicilio
```

`SESSION_SECRET` es obligatorio: si falta, el worker responde 500 (fail
closed) en `/api/auth/*` y en toda ruta protegida — nunca cae a un secreto
por defecto en producción. El único fallback permitido es para desarrollo
local, activándolo explícitamente con `DEV=1` en `.dev.vars`
(`wrangler pages dev` lo carga automáticamente):

```
# .dev.vars (NO commitear)
DEV=1
```

Solo si en algún momento se activa `MAIL_MODE=direct` (envío directo desde el
Worker, sin pasar por el `.exe --relay`):

```bash
npx wrangler pages secret put EWS_URL --project-name=peticion-cambio-domicilio
npx wrangler pages secret put EWS_USER --project-name=peticion-cambio-domicilio
npx wrangler pages secret put EWS_PASS --project-name=peticion-cambio-domicilio
npx wrangler pages secret put EWS_SEND_AS --project-name=peticion-cambio-domicilio
```

Recomendado para partir: dejar `mail.mode = relay` en `/api/config` (es el
default) y NO configurar `EWS_*` en el Worker — el envío real sigue saliendo
desde el `.exe --relay` en una PC municipal con acceso a Exchange, mientras se
confirma que todo lo demás (dashboard, import, D1) funciona bien.

### Login: rate limit de fuerza bruta (dos capas)

`worker/lib/loginRateLimit.js` guarda los fallos en D1 (tabla
`login_intentos`), con dos límites independientes:

1. **Por IP+usuario**: 5 fallos / 15 minutos. Protege un usuario contra fuerza
   bruta desde una misma IP.
2. **Global por usuario** (clave `global:<usuario>`): 20 fallos / 1 hora
   sumando TODAS las IPs. Sin este segundo tope, alguien con acceso a varias
   IPs (proxy rotativo, VPN, etc.) podía evadir el límite (1) probando pocas
   claves por IP y cambiando de IP entre tandas — especialmente peligroso
   contra el usuario `admin` + PIN maestro.

La IP se toma **exclusivamente** de `CF-Connecting-IP` (la cabecera que
Cloudflare setea en el edge y el cliente NO puede falsificar). Ya NO se usa
`x-forwarded-for` como fallback: esa cabecera la puede mandar cualquier
cliente con cualquier valor, así que aceptarla permitía "declarar" una IP
distinta en cada intento y esquivar el límite (1) sin siquiera cambiar de red.

El incremento de cada clave (`fallos = fallos + 1` o reinicio si venció la
ventana) es un único `INSERT ... ON CONFLICT DO UPDATE` (UPSERT atómico), no
un `SELECT` seguido de un `UPDATE` separado — evita perder fallos por una
carrera entre dos intentos fallidos concurrentes contra la misma clave.

### Relay: envíos que quedan en 'revision' (no se re-liberan solos)

Si el `.exe --relay` toma un envío (`estado='tomado'`) y no reporta resultado
en 10 minutos (se cae a mitad de camino, pierde la VPN, etc.), **el envío NO
vuelve solo a `pendiente`**: pasa a `estado='revision'`. Antes sí volvía a
`pendiente` automáticamente, pero eso arriesgaba un correo duplicado real por
EWS si el relay SÍ había alcanzado a enviarlo antes de caerse justo al
reportar el resultado — el correo ya salió, y un segundo poll lo habría
vuelto a tomar y reenviado a la comuna.

Un envío en `revision`:

- Aparece en un banner amarillo ("**Envío sin confirmar — revisar buzón
  enviados antes de reintentar**") en el dashboard (`/index.html`) y en
  Configuración (`/configuracion.html`), visible solo para usuarios `admin`
  (`GET /api/envios/revision`).
- El admin debe revisar el buzón de "Enviados" de Exchange para ese
  destinatario y decidir:
  - **Si el correo NO salió** → botón "Reencolar" (`POST
    /api/envios/:id/reencolar`): vuelve el envío a `pendiente`, el relay lo
    tomará de nuevo en el próximo poll.
  - **Si el correo SÍ salió** → botón "Marcar enviado" (`POST
    /api/envios/:id/confirmar`): marca el envío `enviado` y sus peticiones
    como `Enviada` (arranca el plazo legal de 15 días hábiles), sin volver a
    pasar por el relay.
- Si en cambio el `.exe --relay` manda un reporte **tardío** para ese mismo
  envío (con el `leaseToken` original, p.ej. porque solo se cortó la
  conexión al reportar pero el proceso seguía vivo), `POST
  /api/relay/resultado` lo sigue aceptando y resuelve el envío solo — el
  admin no necesita intervenir en ese caso.

## 5. Crear el primer usuario admin

No hay usuarios en la tabla `usuarios` recién creada la base. Login inicial
con el `MASTER_PIN` configurado arriba (cualquier nombre de usuario, con esa
clave, entra como admin):

```
POST /api/auth/login  { "usuario": "tu-nombre", "clave": "<MASTER_PIN>" }
```

Una vez adentro, crear usuarios reales desde `/configuracion.html` (usa
`/api/usuarios`, solo admin) y dejar de usar el PIN maestro para el día a día.

## 6. Instalar el Apps Script (import automático)

1. Abrir la planilla "DETALLE CARPETAS" en Google Sheets (o `clasp create`
   un proyecto standalone si se prefiere no atarlo a la planilla).
2. `Extensiones > Apps Script`, pegar `apps-script/Code.gs` y
   `apps-script/appsscript.json` (o usar `clasp push` apuntando a esa
   carpeta).
3. `Configuración del proyecto > Propiedades del script`, agregar:
   - `WORKER_URL` → la URL del proyecto Pages (ej.
     `https://peticion-cambio-domicilio.pages.dev`)
   - `IMPORT_SECRET` → el mismo valor puesto en el secret del Worker
   - `SPREADSHEET_ID` → opcional, solo si el script no está bound a la
     planilla (`clasp create --type standalone`)
4. Correr `installTrigger` una vez a mano desde el editor de Apps Script
   (menú Ejecutar) para instalar el disparador cada 30 minutos. Aceptar los
   permisos OAuth que pida (Sheets + `UrlFetchApp`).
5. Recargar la planilla: debería aparecer el menú "Cambio de domicilio >
   Sincronizar ahora" para forzar una sincronización manual.

**Contrato de import por lotes (relevante si se toca el worker o el script):**
el libro real tiene ~4400 filas relevantes, así que Apps Script siempre reparte
el envío en varios `POST /api/import` de hasta `MAX_FILAS_POR_LOTE` (500) filas
cada uno, todos con el mismo `syncId` (UUID generado por sincronización) más
`lote`/`totalLotes`. Cada `POST /api/import` **solo hace upsert, nunca borra**.
Recién al final, después de mandar todos los lotes, Apps Script llama una vez
a `POST /api/import/finalizar {syncId, hojasLeidas}`, que exige que hayan
llegado todos los lotes anunciados y ahí sí ejecuta la limpieza de obsoletas
sobre el acumulado completo de claves (rut|comuna) vistas en esa
sincronización — nunca sobre un lote aislado. `finalizar` además mantiene las
mismas guardas de seguridad: si no llegó ninguna clave, si se informó
`hojasLeidas: 0`, o si la limpieza borraría más del 50% de las peticiones
Borrador no-manuales existentes, se omite el borrado y se devuelve un aviso en
vez de tocar la base. El tracking intermedio vive en las tablas D1
`import_vistos`/`import_lotes` (ver `migrations/0001_init.sql`) y se limpia
solo al finalizar cada `syncId`.

## 7. Arrancar el `.exe --relay` en una PC municipal

En la PC que tiene la red/VPN que ve `mail.munivalpo.cl` (la misma que ya usa
el `.exe` actual):

1. Editar `appsettings.Local.json` (no viaja en git, ver
   `appsettings.Local.Example.json`) y agregar:

   ```json
   {
     "Peticion": {
       "RelayUrl": "https://peticion-cambio-domicilio.pages.dev",
       "RelaySecret": "<mismo valor que RELAY_SECRET del Worker>",
       "Ews": { "...": "igual que hoy" }
     }
   }
   ```

2. Correr:

   ```bash
   PeticionCambioDomicilio.exe --relay
   ```

   Queda haciendo polling cada 30s contra `/api/relay/pendientes`, envía por
   el mismo EWS de siempre y reporta el resultado a `/api/relay/resultado`.
   `Ctrl+C` para detenerlo. Si Exchange rechaza credenciales (401/403) el
   proceso corta el loop solo — no reintenta a ciegas — y hay que revisar
   usuario/clave antes de volver a arrancarlo.

3. Dejarlo corriendo como tarea/servicio (Programador de tareas de Windows,
   "al iniciar sesión" o "al arrancar el equipo") para que sobreviva
   reinicios de esa PC.

## 8. Apagar el `.exe` legado (cuando IT confirme)

Una vez que el dashboard en Cloudflare Pages sea la única fuente de verdad
(el equipo ya no entra al `.exe` viejo para nada salvo `--relay`):

- Se puede dejar el `.exe` legado apagado o solo usarlo con `--relay`.
- Si en el futuro se decide sacar también el `.exe --relay` de la ecuación,
  cambiar `mail.mode` a `direct` en `/api/config` y configurar los secrets
  `EWS_*` del Worker (paso 4) — el envío pasaría a salir directo desde
  Cloudflare, sin pasar por ninguna PC municipal. Requiere que Exchange
  acepte conexiones desde la IP saliente de Cloudflare Workers (validarlo
  con IT antes de cortar el `--relay`).

## Rollback

- Pages: `wrangler pages deployment list` + volver a un deployment anterior,
  o borrar el proyecto Pages.
- D1: Time Travel (`wrangler d1 time-travel`) para restaurar un punto previo
  sin perder los datos migrados.
- El `.exe` original sigue intacto (solo se le agregó la rama `--relay`,
  aditiva) — se puede seguir usando como estaba si hace falta volver atrás
  por completo.
