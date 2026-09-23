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
