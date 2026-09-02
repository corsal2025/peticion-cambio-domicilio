namespace PeticionCambioDomicilio.Domain;

public enum EstadoPeticion
{
    Borrador,
    Enviada,
    SinCorreoComuna,
    Error
}

/// <summary>
/// Una petición de carpeta a otra comuna, nacida de una fila "CAMBIO DE DOMICILIO" del Excel.
/// Clave natural de deduplicación: RUT + comuna destino.
/// </summary>
public sealed class Peticion
{
    public long Id { get; set; }
    public required string NombreCompleto { get; set; }
    public required string Rut { get; set; }
    public required string Comuna { get; set; }
    public string? Clases { get; set; }
    public DateOnly? FechaSolicitud { get; set; }

    /// <summary>Hoja + fila del Excel de origen, para trazabilidad.</summary>
    public string? Origen { get; set; }

    /// <summary>Se llena si el RUT del Excel no valida — la fila igual se guarda para revisión manual.</summary>
    public bool RutInvalido { get; set; }

    public EstadoPeticion Estado { get; set; } = EstadoPeticion.Borrador;
    public string? DetalleEstado { get; set; }
    public DateTimeOffset CreadaEn { get; set; } = DateTimeOffset.Now;
    public DateTimeOffset? EnviadaEn { get; set; }

    /// <summary>Direcciones a las que se envió (coma-separadas), para mostrar en la lista.</summary>
    public string? DestinatariosCorreo { get; set; }
}
