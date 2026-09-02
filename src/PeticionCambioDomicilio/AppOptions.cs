namespace PeticionCambioDomicilio;

/// <summary>
/// Configuración de la app. Todo es opcional: sin configurar, la app arranca igual
/// y cada pantalla indica qué falta. Se lee de la sección "Peticion" de
/// appsettings.json / appsettings.Local.json.
/// </summary>
public sealed class AppOptions
{
    public const string SectionName = "Peticion";

    /// <summary>Ruta al libro Excel (DETALLE CARPETAS ... .xlsx) que se importa desde la pantalla Peticiones.</summary>
    public string? ExcelPath { get; set; }

    /// <summary>Mapeo de columnas del Excel. Se busca por encabezado (sin distinguir mayúsculas/tildes),
    /// así que el orden de las columnas en la hoja no importa. La fila de encabezado se detecta sola
    /// (primera fila que contiene "RUT").</summary>
    public ColumnMap Columns { get; set; } = new();

    /// <summary>Valor de la columna "Estado de la carpeta" que marca una fila como
    /// "hay que pedir la carpeta a la otra comuna". Comparación sin distinguir mayúsculas ni tildes.</summary>
    public string EstadoCambioDomicilio { get; set; } = "CAMBIO DE DOMICILIO";

    /// <summary>Nombres de hoja que se ignoran (no son agenda mensual).</summary>
    public string[] HojasIgnoradas { get; set; } =
        ["PLANTILLA", "HOJA ESTADISTICAS", "CORREOS CAMBIO DE DOMICLIO", "CORREOS CAMBIO DE DOMICILIO"];

    /// <summary>Ruta al CSV del directorio de comunas. Vacío = data/comunas.csv junto al ejecutable.</summary>
    public string? ComunaDirectoryCsvPath { get; set; }

    /// <summary>Correo institucional (aparece como firma / remitente).</summary>
    public string MailboxAddress { get; set; } = "cambiodedomicilio@munivalpo.cl";

    public EwsOptions? Ews { get; set; }
}

public sealed class ColumnMap
{
    public string NombreCompleto { get; set; } = "NOMBRE COMPLETO";
    public string Rut { get; set; } = "RUT";
    public string EstadoCarpeta { get; set; } = "ESTADO DE LA CARPETA";

    /// <summary>Columna que, cuando trae texto en vez de fecha, contiene la comuna de origen de la persona.</summary>
    public string ComunaOrigen { get; set; } = "FECHA ULTIMA CARPETA";

    /// <summary>Columna de la que sale la "fecha de solicitud" de la petición.</summary>
    public string FechaSolicitud { get; set; } = "FECHA DE LA CITACION";

    /// <summary>Opcional: clases de licencia. El libro DETALLE CARPETAS no la trae; queda vacía.</summary>
    public string Clases { get; set; } = "CLASES";
}

public sealed class EwsOptions
{
    public string? Url { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }
}
