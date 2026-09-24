# Despliegue a Cloudflare (pasos manuales)
n> Atajo: `powershell -ExecutionPolicy Bypass -File deploy/cloudflare-deploy.ps1` hace los pasos 1-5 solo (la base D1 ya esta creada, id en wrangler.toml).

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
npx wrangler pages secret put APPS_SCRIPT_URL --project-name=peticion-cambio-domicilio
```

`APPS_SCRIPT_URL` es la URL del deployment "Aplicacion web" del proyecto
Apps Script (`https://script.google.com/macros/s/AKfycb.../exec`, ver sección
6 "Camino A" paso 8 más abajo). La usan los DOS botones del dashboard
(paridad con el .NET viejo, ver `Index.cshtml`): "Cargar cambios de
domicilio" (`POST /api/sincronizar {accion:'cargar'}`, procesa SOLO filas
exactamente "CAMBIO DE DOMICILIO" + comunas) y "Actualizar estado solicitud"
(`{accion:'actualizar'}`, SOLO avanza el estado de peticiones ya existentes,
rango >= 2) — ambos fuerzan una sincronización sin esperar el trigger de 15
minutos, que reenvía el mismo `IMPORT_SECRET` en el body junto a `accion`.
Apps Script (`doPost`) enruta segun `accion` a `extraerFilas_` (ver
`apps-script/Code.gs`), que solo construye las filas de ESE flujo. Si falta
esta secret, ambos botones responden 503 pero el resto del sitio funciona
igual (el time trigger de Apps Script — que corre AMBOS flujos, `cargar` y
`actualizar` — sigue corriendo solo).

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
con el usuario fijo `admin` y el `MASTER_PIN` configurado arriba (otro nombre
no sirve):

```
POST /api/auth/login  { "usuario": "admin", "clave": "<MASTER_PIN>" }
```

Una vez adentro, crear usuarios reales desde `/configuracion.html` (usa
`/api/usuarios`, solo admin) y dejar de usar el PIN maestro para el día a día.

## 6. Instalar el Apps Script (import automático)

El archivo real, **"DETALLE CARPETAS DEPTO. LICENCIAS DE CONDUCIR
2026.xlsx"**, es un `.xlsx` (no un Google Sheet nativo) guardado en una
carpeta de un Drive compartido. `SpreadsheetApp` no puede abrir un `.xlsx`
directamente ni un script puede quedar "bound" a un `.xlsx`, así que
`apps-script/` es un script **standalone**: en cada corrida usa el servicio
avanzado de Drive para copiar el `.xlsx` convirtiéndolo a Google Sheet
nativo, lo procesa, y **siempre** borra (trashea) esa copia temporal al
terminar (haya ido bien o mal el envío).

### Obtener el `XLSX_FILE_ID`

Abrir el archivo en la web de Drive (buscarlo dentro de "DEPTO. LICENCIAS DE
CONDUCIR/2026/") y copiar el id de la URL:

```
https://drive.google.com/file/d/ESTE_ES_EL_ID/view
```

### Camino A: `clasp` (recomendado)

1. Instalar clasp (global o con `npx`): `npm i -g @google/clasp`.
2. Habilitar la Apps Script API una vez para tu cuenta:
   https://script.google.com/home/usersettings (toggle "activada").
3. `clasp login` — abre el navegador para autorizar la cuenta que va a ser
   dueña del script (y de las copias temporales que crea en su Drive).
4. Crear el proyecto standalone apuntando a la carpeta `apps-script/`:
   ```
   cd apps-script
   clasp create --type standalone --title "Sync Peticion Cambio Domicilio" --rootDir .
   ```
   Esto genera `apps-script/.clasp.json` (gitignorado; tiene el `scriptId`,
   es per-usuario).
5. (Opcional pero recomendado) Copiar `Config.example.gs` a `Config.gs` en la
   misma carpeta y completar `WORKER_URL`, `IMPORT_SECRET` y `XLSX_FILE_ID`.
   `Config.gs` está gitignorado — así `clasp push` entrega los secrets al
   editor sin comitearlos, y `.claspignore` excluye `Config.example.gs` del
   push (no tiene sentido subir la plantilla).
6. `clasp push` — sube `Code.gs`, `appsscript.json` y, si existe,
   `Config.gs`.
7. Abrir el proyecto en el editor (`clasp open`) y correr, en este orden,
   cada función desde el menú "Ejecutar":
   - `configurar()` — si subiste `Config.gs`, vuelca sus valores a Script
     Properties (revisar "Registros de ejecución": debe loguear `OK: Script
     properties actualizadas (...)`). Si no usaste `Config.gs`, cargar
     `WORKER_URL` / `IMPORT_SECRET` / `XLSX_FILE_ID` a mano en
     `Configuración del proyecto > Propiedades del script`.
   - `installTrigger()` — instala el disparador cada 15 minutos
     (`sincronizarProgramada`). La primera vez pedirá aceptar los permisos
     OAuth (Drive + Sheets + `UrlFetchApp`); aceptar todos.
   - `sincronizarAhora()` — fuerza una sincronización manual completa (no
     respeta el chequeo de "sin cambios"), útil para validar que todo quedó
     bien configurado antes de esperar al trigger.
8. Publicar el web app (para que los botones "Cargar cambios de domicilio" /
   "Actualizar estado solicitud" del dashboard puedan llamarlo): `Implementar
   > Nueva implementación > tipo "Aplicación
   web"`, con "Ejecutar como" = tu cuenta y "Quién tiene acceso" = "Cualquier
   usuario" (ya viene precargado desde `appsscript.json`, sección `webapp`).
   Copiar la URL `.../exec` que entrega Google y guardarla como el secret
   `APPS_SCRIPT_URL` del Worker (paso 4 de este documento). Cada vez que se
   suba código nuevo con `clasp push` hay que crear una nueva versión
   (`Implementar > Gestionar implementaciones > editar > Nueva versión`) para
   que el web app la tome; la URL `.../exec` no cambia entre versiones.

### Camino B: copiar y pegar a mano

1. En https://script.google.com, crear un proyecto nuevo (queda standalone
   por defecto).
2. Pegar el contenido de `apps-script/Code.gs` en `Code.gs`.
3. `Configuración del proyecto > Editor de appsscript.json` (activar "Mostrar
   archivo de manifiesto") y reemplazar su contenido por el de
   `apps-script/appsscript.json` (habilita el servicio avanzado de Drive v3 y
   declara los scopes).
4. `Configuración del proyecto > Propiedades del script`, agregar:
   - `WORKER_URL` → la URL del proyecto Pages (ej.
     `https://peticion-cambio-domicilio.pages.dev`)
   - `IMPORT_SECRET` → el mismo valor puesto en el secret del Worker (se usa
     tanto para `/api/import` como para `/api/comunas/sync`)
   - `XLSX_FILE_ID` → el id obtenido arriba
   - `SPREADSHEET_ID` → opcional; solo si preferís convertir el `.xlsx` a
     Google Sheet una vez a mano y apuntar el script directo a esa copia
     permanente en lugar de copiar/trashear en cada corrida
5. Correr `installTrigger` una vez a mano desde el editor (menú Ejecutar)
   para instalar el disparador cada 15 minutos. Aceptar los permisos OAuth
   que pida (Drive + Sheets + `UrlFetchApp`).
6. Correr `sincronizarAhora` una vez a mano para validar la configuración.

### Troubleshooting general

Las ejecuciones (manuales y del trigger) quedan en "Ver > Registros de
ejecución" del editor de Apps Script — ahí aparecen tanto los `Logger.log`
propios (`configurar()`, fallos al trashear la copia temporal) como
cualquier excepción no capturada.

**Contrato de import por lotes (relevante si se toca el worker o el script):**
el libro real tiene ~4400 filas relevantes, así que Apps Script siempre reparte
el envío en varios `POST /api/import` de hasta `MAX_FILAS_POR_LOTE` (200) filas
cada uno. Cada `POST /api/import` **solo hace upsert, nunca borra**, y devuelve
`clavesCD` (las claves `rut_norm|comuna_norm` de las filas exactamente "CAMBIO
DE DOMICILIO" de ESE lote). Apps Script acumula ese arreglo en memoria a lo
largo de todos los lotes y, recién al final, llama una vez a `POST
/api/import/finalizar {clavesCD, hojasLeidas, recibidas, insertadas,
actualizadas}` con el acumulado completo, que ahí sí ejecuta la limpieza de
obsoletas sobre ese set — nunca sobre un lote aislado. `finalizar` además
mantiene las mismas guardas de seguridad: si no llegó ninguna clave, si se
informó `hojasLeidas: 0`, o si la limpieza borraría más del 50% de las
peticiones Borrador no-manuales existentes, se omite el borrado y se devuelve
un aviso en vez de tocar la base. `finalizar` también escribe la **única** fila
de `sync_log` de toda la sincronización (antes se escribía una por lote).
Si algún `POST /api/import` de un lote falla, Apps Script lanza y **nunca**
llega a llamar a `finalizar` — por eso el worker ya no necesita rastrear
"cuántos lotes llegaron" por su cuenta.

> **Incidente 2026-09 (D1 free tier "exceeded daily row write limit"):** con
> ~4600 filas relevantes sincronizadas cada 15 min, la versión anterior
> reescribía (facturaba) TODAS las filas matcheadas en cada corrida aunque no
> hubiera cambiado nada, además de insertar una fila en `import_vistos` por
> cada clave vista y una fila en `import_lotes`/`sync_log` por cada lote —
> eso solo ya agotaba las 100k filas escritas/día del plan free en pocas
> horas. La corrección: (1) `UPSERT_SQL`/`UPDATE_AVANCE_SQL` en
> `worker/lib/importar.js` ahora llevan un `WHERE` que hace que SQLite/D1 NO
> cuente como escrita una fila cuyo contenido no cambió (usando `IS NOT` para
> comparar bien columnas nulleables) ni cuyo rango no avanza; (2) se eliminó
> el tracking `import_vistos`/`import_lotes` (migración
> `migrations/0003_drop_import_tracking.sql`, que dropea ambas tablas — ya
> no se persiste nada por lote, ver arriba); (3) `sync_log` pasó de una fila
> por lote a una sola fila por sincronización completa, escrita en
> `/api/import/finalizar`. Con esto, una re-sincronización sin cambios reales
> de ~4600 filas escribe a lo sumo un puñado de filas (ver
> `test/d1WriteBudget.test.js`), en vez de ~4600 + tracking por lote.

**Matching de avance por RUT (paridad `ExcelPeticionImporter.cs
ActualizarEstadosCarpeta`):** las filas en etapa posterior a "CAMBIO DE
DOMICILIO" (rango >= 2) avanzan peticion(es) existentes matcheando por RUT
normalizado, **sin mirar la comuna** — si la misma persona tiene peticiones
en más de una comuna, todas avanzan juntas. Si el RUT es inválido, el match
cae a nombre completo folded (sin tildes/mayúsculas). Cuando la misma persona
aparece más de una vez en la sincronización (varias hojas, o repartida en
varios lotes), se aplica el estado MÁS avanzado de todos los que aparezcan
para ella. Ver `worker/lib/importar.js` (`UPDATE_AVANCE_SQL` para el caso
RUT válido, set-based vía `json_each`; `actualizarAvancePorNombre` para el
caso RUT inválido, resuelto en JS porque SQLite/D1 no tiene una función de
fold-accents nativa — el set de peticiones con `rut_invalido = 1` es chico,
así que esto no compromete el presupuesto de escritura).

**Sincronización de correos de comunas:** en la misma corrida de
`sincronizarAhora`/`sincronizarProgramada` (la que dispara el trigger cada 15
minutos), Apps Script también lee la hoja cuyo
nombre contiene "correos cambio de dom" (la hoja "CORREOS CAMBIO DE
DOMICLIO" del libro real, con columnas Municipio/Correo — mismo formato que
lee `ComunaDirectory.ImportFromWorkbook` en el `.exe` legado) y hace `POST
/api/comunas/sync {contactos: [{comuna, email}, ...]}`, autenticado con el
mismo `IMPORT_SECRET`. El worker hace upsert por (comuna, correo) — agrega
comunas/correos nuevos y cuenta los que ya existían, pero **nunca borra** un
contacto que haya desaparecido de la hoja (a diferencia de
`/api/import/finalizar`, que sí limpia peticiones obsoletas). Si un contacto
se da de baja hay que borrarlo a mano desde `/comunas.html`. Cada
sincronización deja un renglón en `sync_log` con `fuente =
'apps-script-comunas'`.

> **Troubleshooting:** si la tabla `sync_log` está vacía (ni `fuente =
> 'apps-script'` ni `'apps-script-comunas'`), Apps Script nunca llegó a
> alcanzar al worker. Revisar, en ese orden: (1) `WORKER_URL` apunta a la URL
> real del proyecto Pages (sin `/` final ni typos); (2) `IMPORT_SECRET` en
> las Script Properties es exactamente el mismo valor que el secret
> `IMPORT_SECRET` del Worker (`npx wrangler pages secret put IMPORT_SECRET
> ...`); (3) `XLSX_FILE_ID` apunta al archivo `.xlsx` correcto y la cuenta
> dueña del script tiene acceso a la carpeta del Drive compartido (o, si se
> usó `SPREADSHEET_ID` en su lugar, que apunte al libro correcto). Después de
> corregir, correr `sincronizarAhora()` a mano desde el editor de Apps Script
> — el valor de retorno (visible en "Ejecución > Ver registros de
> ejecución") muestra hojas leídas, filas de peticiones enviadas, contactos
> de comunas nuevos/actualizados y la cantidad de avisos; y cualquier error
> de red o de la copia/trasheo del `.xlsx` queda además ahí mismo.

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
