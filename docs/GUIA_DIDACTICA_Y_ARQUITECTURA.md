# Sistema de Petición de Cambio de Domicilio
## Manual Didáctico de Uso y Arquitectura Técnica Integral

---

### 1. ¿Qué es este sistema y para qué sirve?

Cuando un ciudadano solicita su licencia de conducir en Valparaíso habiendo obtenido previamente licencia en otra comuna, la ley chilena (**Decreto Supremo 170, Artículo 14**) exige que la Municipalidad receptora (Valparaíso) solicite formalmente la carpeta de antecedentes del conductor a la municipalidad de origen antes de otorgar el documento.

Este sistema automatiza, centraliza y controla todo ese ciclo de trabajo:
1. **Detecta y extrae** automáticamente los casos marcados como `CAMBIO DE DOMICILIO` desde el libro Excel maestro departamental.
2. **Normaliza y valida** los datos del solicitante (RUT con dígito verificador chileno, nombres y comuna de origen).
3. **Mapea y ubica** el correo electrónico municipal oficial de las más de 340 comunas del país registradas en su directorio.
4. **Permite el control de carpetas físicas y digitales** (Borrador, En trámite, Escaneada, Recibida, En revisión).
5. **Gestiona el despacho masivo e individual** de las peticiones vía correo institucional Exchange / EWS con plantilla legal formal.
6. **Funciona en red local compartida** permitiendo que múltiples funcionarios trabajen simultáneamente sobre una base de datos central única y protegida sin duplicar envíos.

---

### 2. Flujo Operativo Paso a Paso (Guía del Usuario)

```
┌─────────────────────────┐
│   Excel Maestro 2026    │
│  (Google Drive / Disco) │
└───────────┬─────────────┘
            │
            ▼ [1. Cargar cambios de domicilio]
┌─────────────────────────┐
│  Peticiones Nuevas en   │ <─── [O Agregar Manualmente por Pantalla]
│  Estado "Borrador"      │
└───────────┬─────────────┘
            │
            ▼ [2. Verificación de Comuna y Correo]
┌─────────────────────────┐
│ Directorio de Comunas   │ ── Si la comuna no tiene correo ──> Pantalla "Comunas"
│ (Asigna correo oficial) │                                    (Permite agregar/editar)
└───────────┬─────────────┘
            │
            ▼ [3. Gestión de Carpetas / Escaneos]
┌─────────────────────────┐
│  Estado de la Carpeta   │ ── Actualización de estado en lote o individual
│  (Física / Escaneada)   │    (Sincronización con "Actualizar estado solicitud")
└───────────┬─────────────┘
            │
            ▼ [4. Selección y Despacho]
┌─────────────────────────┐
│ Marcado de Peticiones   │ ── [Enviar Marcadas] ──> Correo Exchange EWS Oficial
│ Pendientes (Casillas)   │                         (Buzón cambiodedomicilio@munivalpo.cl)
└───────────┬─────────────┘
            │
            ▼ [5. Trazabilidad y Respaldos]
┌─────────────────────────┐
│ Registro de Envío       │ ── Estado "Enviada" con fecha y hora exacta
│ Base de Datos SQLite    │ ── Respaldos automáticos en publish/data/backups/
└─────────────────────────┘
```

#### Paso 1: Carga o Importación de Datos
- **Desde el Excel Maestro:** Al hacer clic en el botón superior **"Cargar cambios de domicilio"**, el sistema lee el libro Excel departamental configurado en `appsettings.Local.json`.
  - Lee todas las hojas mensuales de las oficinas (Av. Argentina, Placilla, Mercado Puerto).
  - Identifica las filas cuyo `ESTADO DE LA CARPETA` sea `CAMBIO DE DOMICILIO`.
  - Omite automáticamente los casos que ya existen en la base para no duplicar.
  - Genera un respaldo automático de seguridad de la base antes de aplicar cualquier importación.
- **Carga Manual:** Si llega un caso prioritario que aún no está en el Excel, se puede registrar directamente desde el formulario **"Nueva petición manual"** indicando RUT, Nombre, Comuna de procedencia y Oficina.

#### Paso 2: Validación y Asignación de Comuna
- El sistema limpia el texto de la comuna (remueve tildes, caracteres extraños y errores tipográficos comunes).
- Si la comuna de origen es reconocida y tiene casilla de correo registrada, la petición queda lista para ser enviada.
- Si la comuna no tiene correo registrado o el nombre no coincide:
  - Aparece resaltada en color amarillo con el aviso *“Sin correo de comuna”*.
  - En la pestaña superior **"Comunas"**, el operador puede buscar la comuna y asignarle el correo correspondiente. Una vez guardado, todas las peticiones de esa comuna se habilitan automáticamente.

#### Paso 3: Gestión del Estado de las Carpetas y Escaneos
- En la tabla principal, cada fila tiene un selector de **Estado de Carpeta**:
  - `PENDIENTE` / `NO REGISTRA`
  - `SUBIDA` / `ESCANEADA`
  - `CON DOCUMENTOS`
- Al pulsar **"Actualizar estado solicitud"**, el sistema compara las fechas y estados de escaneo del Excel con la base de datos local y actualiza de inmediato el registro sin alterar las marcas de envío.

#### Paso 4: Selección y Despacho de Correos
- Cada fila cuenta con un botón de marcado rápido `[ + ]` / `[ ✓ ]` y un checkbox en la cabecera para marcar todas las pendientes visibles.
- Un buscador instantáneo por RUT o Nombre permite filtrar la lista en milisegundos.
- Al pulsar **"Enviar marcadas (N)"**:
  - Se valida la conexión con el servidor de correo institucional EWS Exchange.
  - Se genera el cuerpo del mensaje legal con el nombre y RUT del conductor.
  - Se despachan los correos con pausas de seguridad entre municipios.
  - La fila pasa de *Pendiente* a **Enviada**, registrando la fecha y hora exacta del despacho.

---

### 3. Arquitectura Técnica y Componentes

El sistema está construido bajo principios de **arquitectura limpia, resiliente y de alto desempeño on-premise**:

| Componente | Rol Técnico | Ubicación en el Código |
| --- | --- | --- |
| **PeticionRepository** | Capa de persistencia SQLite sin ORM. Conexiones limpias, transaccionales y con generación de backups automáticos con timestamp. | `src/PeticionCambioDomicilio/data/PeticionRepository.cs` |
| **ExcelPeticionImporter** | Motor de ingesta y desinfección de hojas Excel mediante `ClosedXML`. Elimina validaciones corruptas y sanitiza celdas antes de leer. | `src/PeticionCambioDomicilio/Excel/ExcelPeticionImporter.cs` |
| **ComunaDirectory** | Catálogo oficial de más de 340 comunas de Chile con matching tolerante a fallas (distancia Levenshtein / edición). | `src/PeticionCambioDomicilio/Comunas/ComunaDirectory.cs` |
| **EwsMailSender** | Cliente SOAP directo sobre Exchange Web Services (EWS) autenticado bajo credenciales institucionales de dominio. | `src/PeticionCambioDomicilio/Ews/EwsMailSender.cs` |
| **Razor Pages & Site CSS** | Interfaz de usuario responsiva, accesible, optimizada con atajos de teclado, preservación de scroll y estilo visual municipal. | `src/PeticionCambioDomicilio/Pages/` |

---

### 4. Funcionamiento en Red Local (Servidor y Puestos de Trabajo)

La solución fue diseñada para trabajar en la red de la oficina mediante el instalador incluido:
- **PC Principal (Servidor Central):**
  - Ejecuta la aplicación escuchando en el puerto `5020`.
  - Aloja la base de datos central en `publish\data\peticiones.db`.
  - Posee la regla en el Firewall de Windows para permitir acceso LAN seguro.
- **Puestos de Trabajo (Compañeros):**
  - No requieren instalar motores de bases de datos ni configuraciones complejas.
  - Se conectan vía navegador a la IP del Servidor Central (`http://192.168.x.x:5020`).
  - Todo cambio, marca o envío realizado por un compañero se refleja en tiempo real para todos los demás.

---

### 5. Respaldo y Seguridad de la Información

- **Ubicación de la Base de Datos:** `publish\data\peticiones.db`.
- **Copias de Seguridad Automáticas:** Cada vez que se importa el Excel o se sincronizan estados, el repositorio crea una copia íntegra con fecha y hora en `publish\data\backups\peticiones-YYYYMMDD-HHMMSS-*.db`.
- **Modo Seguro de Pruebas:** El archivo `appsettings.Local.json` soporta la directiva `"TestModeEmail": "correo@ejemplo.com"`. Si está presente, ningún correo sale hacia otras municipalidades, sino que todos son desviados a esa casilla de prueba con un encabezado explicativo.
