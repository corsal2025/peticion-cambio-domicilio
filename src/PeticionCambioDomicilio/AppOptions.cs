namespace PeticionCambioDomicilio;

/// <summary>
/// Configuración de la app. Todo es opcional: sin configurar, la app arranca igual
/// y cada pantalla indica qué falta (mismo patrón que el módulo CambioDomicilio de LicenciasCarpetas).
/// Se lee de la sección "Peticion" de appsettings.json / appsettings.Local.json.
/// </summary>
public sealed class AppOptions
{
    public const string SectionName = "Peticion";

    /// <summary>Ruta al Excel de solicitudes que se importa desde la pantalla Peticiones.</summary>
    public string? ExcelPath { get; set; }

    /// <summary>Nombre de la hoja a leer. Vacío = primera hoja del libro.</summary>
    public string? ExcelSheetName { get; set; }

    /// <summary>Mapeo de columnas del Excel. Se busca por encabezado (sin distinguir mayúsculas/tildes).
    /// Si una columna no aparece, esa dato queda vacío.</summary>
    public ColumnMap Columns { get; set; } = new();

    /// <summary>Valor de la columna "Trámite" que marca una fila como cambio de domicilio.</summary>
    public string OrdenCambioDomicilio { get; set; } = "CAMBIO DE DOMICILIO";

    /// <summary>Ruta al CSV del directorio de comunas. Vacío = data/comunas.csv junto al ejecutable.</summary>
    public string? ComunaDirectoryCsvPath { get; set; }

    /// <summary>Correo institucional (aparece como remitente / firma).</summary>
    public string MailboxAddress { get; set; } = "cambiodedomicilio@munivalpo.cl";

    public EwsOptions? Ews { get; set; }
}

public sealed class ColumnMap
{
    public string Tramite { get; set; } = "TRAMITE";
    public string NombreCompleto { get; set; } = "NOMBRE COMPLETO";
    public string Rut { get; set; } = "RUT";
    public string Comuna { get; set; } = "COMUNA";
    public string FechaSolicitud { get; set; } = "FECHA SOLICITUD";
    public string Clases { get; set; } = "CLASES";
}

public sealed class EwsOptions
{
    public string? Url { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }
}
