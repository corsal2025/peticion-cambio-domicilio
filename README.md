# Petición de Cambio de Domicilio

Dashboard standalone para **pedir carpetas a otras comunas** cuando un conductor llega a
Valparaíso desde otra comuna (flujo saliente del trámite Decreto 170, art. 14).

Independiente de `LicenciasCarpetas` a propósito: ese modelo todavía no está terminado y esto
tiene que funcionar ya. Reusa por copia lo que ya estaba probado ahí: validador de RUT,
directorio oficial de comunas (`data/comunas.csv`, 513 comunas) y el transporte EWS.

## Qué hace

1. **Importar Excel** — lee el libro `DETALLE CARPETAS ... .xlsx` completo (todas las hojas de
   agenda mensual: Av. Argentina, Placilla y Merc. Puerto de cada mes; ignora `PLANTILLA*`,
   `HOJA ESTADISTICAS`, `CORREOS CAMBIO DE DOMICLIO`). Se queda con las filas cuya columna
   **`ESTADO DE LA CARPETA` == `CAMBIO DE DOMICILIO`** y arma una petición por fila:
   - **Nombre** ← `NOMBRE COMPLETO`
   - **RUT** ← `RUT` (normalizado y validado con dígito verificador; los inválidos se guardan marcados)
   - **Comuna de origen** ← `FECHA ULTIMA CARPETA` cuando trae texto de comuna en vez de fecha,
     calzada contra el directorio con tolerancia a tipeos (distancia de edición ≤ 2). Si no calza,
     la petición queda en estado *Sin correo de comuna* para revisión manual.
   - **Fecha de solicitud** ← `FECHA DE LA CITACION`
   La fila de encabezado se detecta sola (primera con "RUT"); el orden de columnas no importa.
   El libro trae listas desplegables > 255 caracteres que ClosedXML rechaza: se lee una copia
   temporal sin esos nodos (`Excel/WorkbookSanitizer.cs`), el original nunca se toca.
2. **Deduplicar** — clave `RUT + Comuna`. Reimportar no duplica.
3. **Enviar correo** — por cada petición busca el correo municipal de esa comuna en el directorio
   y manda, vía EWS (buzón `cambiodedomicilio@munivalpo.cl`), el texto fijo con la cita del
   art. 14 del Decreto 170 y Plataforma SGL. Nombre y RUT son lo único que cambia.
4. **Estado por petición** — Borrador / Enviada / Sin correo de comuna / Error, con reintento.
5. **Columna Marcar** — casilla por fila para el seguimiento del operador. La fila marcada se pinta.
6. **Orden del Excel** — la lista respeta el orden del libro (hojas en su orden, filas de arriba
   abajo), no se dispersa por estado ni por fecha de importación.
7. **Columna Origen** — muestra solo la oficina: `AV. ARGENTINA`, `PLACILLA` o `MERC. PUERTO`.
   El detalle de hoja y fila queda guardado para trazabilidad, pero no ensucia la tabla.

## Stack

.NET 10 · Razor Pages · SQLite (sin ORM) · ClosedXML · EWS SOAP directo. Mismo stack que
LicenciasCarpetas. Corre **on-premise** (necesita red municipal para llegar a Exchange).

## Puesta en marcha

```powershell
cd src\PeticionCambioDomicilio
copy appsettings.Local.Example.json appsettings.Local.json   # y completá los valores
dotnet run -c Release
```

Abre `http://localhost:5020`.

### `appsettings.Local.json` (no viaja en git)

| Clave | Para qué |
| --- | --- |
| `Peticion:ExcelPath` | ruta absoluta al libro `DETALLE CARPETAS ... .xlsx` |
| `Peticion:TestModeEmail` | **modo prueba**: si tiene una dirección, todo se desvía ahí y nada llega a las municipalidades. Vacío = envío real |
| `Peticion:Ews:Url` | `https://mail.munivalpo.cl/EWS/Exchange.asmx` |
| `Peticion:Ews:Username` / `Password` | credenciales del buzón institucional |
| `Peticion:EstadoCambioDomicilio` | valor que dispara (por defecto `CAMBIO DE DOMICILIO`) |
| `Peticion:Columns:*` | nombre de cada encabezado en el libro |

Los encabezados se buscan **sin distinguir mayúsculas ni tildes**; el orden de las columnas en
el Excel no importa. Defaults en `appsettings.json`:
`ESTADO DE LA CARPETA`, `NOMBRE COMPLETO`, `RUT`, `FECHA ULTIMA CARPETA`, `FECHA DE LA CITACION`.

## Importación headless

```powershell
dotnet run -c Release -- --import "C:\...\DETALLE CARPETAS DEPTO. LICENCIAS DE CONDUCIR 2026.xlsx"
```

Corrida real contra el libro 2026 (02-09-2026):

```
Hojas leídas:          18
Filas leídas:          22978
Filas CAMBIO DE DOM.:  33
Peticiones nuevas:     32
Duplicadas (ya había): 1
RUT inválidos:         0
Comuna no reconocida:  2   (ALGORROBO, LLAYLLAY — no están en comunas.csv)
```

## Despliegue

```powershell
.\deploy\publish.ps1 -Shortcut
```

Publica un `.exe` autocontenido (no necesita el SDK) en `publish\` y crea el acceso directo
**"Peticion Cambio Domicilio - Dashboard"** en el Escritorio. El `.exe` es `WinExe`: corre sin
ventana de consola y no aparece en la barra de tareas.

## Diagnóstico del correo

```powershell
dotnet run -c Release -- --test-ews
```

Muestra qué métodos de autenticación ofrece el servidor y hace **un solo** intento con las
credenciales configuradas. No repetir a ciegas: cada fallo suma al bloqueo de la cuenta.

Estado al 02-09-2026: el servidor responde y ofrece `Negotiate | NTLM | Basic`, pero devuelve
**401 Unauthorized** con las credenciales actuales. Falta confirmar con sistemas el formato del
usuario (`DOMINIO\usuario` en vez del correo), si Basic está habilitado para esa cuenta, y si
la clave está vigente.

## Pendiente

- Credenciales EWS válidas (ver arriba).
- Algarrobo y Llay-Llay no tienen correo ni en `comunas.csv` ni en la hoja `CORREOS` del libro:
  agregarlas desde la pantalla **Comunas**.
- Pruebas automatizadas (proyecto de tests aún no creado).

## Estructura

```
src/PeticionCambioDomicilio/
  AppOptions.cs             configuración (sección "Peticion")
  Domain/                   Peticion, RutValidator, EmailTemplate, PeticionSender, TextNormalization
  Excel/ExcelPeticionImporter.cs   lectura del .xlsx y filtro por la orden
  Comunas/ComunaDirectory.cs       directorio de correos municipales (data/comunas.csv)
  Ews/EwsMailSender.cs             envío SOAP contra Exchange
  Data/PeticionRepository.cs       SQLite (data/peticiones.db)
  Pages/                    Index (peticiones), Comunas, Configuracion
```
