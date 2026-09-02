# Petición de Cambio de Domicilio

Dashboard standalone para **pedir carpetas a otras comunas** cuando un conductor llega a
Valparaíso desde otra comuna (flujo saliente del trámite Decreto 170, art. 14).

Independiente de `LicenciasCarpetas` a propósito: ese modelo todavía no está terminado y esto
tiene que funcionar ya. Reusa por copia lo que ya estaba probado ahí: validador de RUT,
directorio oficial de comunas (`data/comunas.csv`, 513 comunas) y el transporte EWS.

## Qué hace

1. **Importar Excel** — lee el `.xlsx` de solicitudes, se queda con las filas cuya columna
   *Trámite* dice `CAMBIO DE DOMICILIO` y extrae **Nombre completo, RUT, Comuna, Fecha de
   solicitud** (y Clases si existe). RUT normalizado y validado con dígito verificador; los que
   no validan se guardan igual, marcados para revisión.
2. **Deduplicar** — clave `RUT + Comuna`. Reimportar no duplica.
3. **Enviar correo** — por cada petición busca el correo municipal de esa comuna en el directorio
   y manda, vía EWS (buzón `cambiodedomicilio@munivalpo.cl`), el texto fijo con la cita del
   art. 14 del Decreto 170 y Plataforma SGL. Nombre y RUT son lo único que cambia.
4. **Estado por petición** — Borrador / Enviada / Sin correo de comuna / Error, con reintento.

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
| `Peticion:ExcelPath` | ruta absoluta al `.xlsx` de solicitudes |
| `Peticion:ExcelSheetName` | hoja a leer (vacío = primera) |
| `Peticion:Ews:Url` | `https://mail.munivalpo.cl/EWS/Exchange.asmx` |
| `Peticion:Ews:Username` / `Password` | credenciales del buzón institucional |
| `Peticion:Columns:*` | nombre de cada encabezado en tu Excel (ver abajo) |

Los encabezados se buscan **sin distinguir mayúsculas ni tildes**; el orden de las columnas en
el Excel no importa. Defaults en `appsettings.json`:
`TRAMITE`, `NOMBRE COMPLETO`, `RUT`, `COMUNA`, `FECHA SOLICITUD`, `CLASES`.

## Pendiente

- **Confirmar los encabezados reales del Excel** y ajustar `Peticion:Columns` — hoy son una
  suposición. Pasá el archivo (o la foto que quedó pendiente) y se calzan.
- Cargar `Peticion:Ews:Username` / `Password`.
- Pruebas automatizadas (proyecto de tests aún no creado).
- Empaquetado `.exe` autocontenido + acceso directo, como en LicenciasCarpetas, si se quiere.

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
