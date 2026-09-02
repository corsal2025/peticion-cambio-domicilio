namespace PeticionCambioDomicilio.Domain;

/// <summary>
/// Texto fijo del correo de solicitud, con cita legal del artículo 14 del Decreto 170 (MTT).
/// Nombre, RUT y clases son lo único que cambia por persona.
/// Alineado con LicenciasCarpetas OutboundRequestSender.BuildBody().
/// </summary>
public static class EmailTemplate
{
    public static string Subject(Peticion p) =>
        $"Solicitud de cambio de domicilio — {p.NombreCompleto} ({p.Rut})";

    public static string Body(Peticion p, string firmaCorreo)
    {
        var claseFrase = string.IsNullOrWhiteSpace(p.Clases)
            ? "para la correspondiente emisión de su licencia de conducir."
            : $"para la correspondiente emisión de su licencia de conducir clase {p.Clases}.";

        var lines = new List<string>
        {
            "Estimados,",
            "",
            "Junto con saludar, y conforme a lo establecido en el artículo 14 del Decreto N.º 170 del " +
                "Ministerio de Transportes y Telecomunicaciones, \"Reglamento para el Otorgamiento de " +
                "Licencias de Conducir\", solicito a ustedes tengan a bien hacer llegar, a través de la " +
                "Plataforma SGL, la carpeta con los antecedentes del siguiente conductor, " + claseFrase,
            "",
            $"Nombre: {p.NombreCompleto}",
            $"RUT: {p.Rut}",
            "",
            "Quedamos atentos a su respuesta.",
            "",
            "Saludos cordiales,",
            "Departamento de Licencias de Conducir",
            "Municipalidad de Valparaíso",
            firmaCorreo
        };

        return string.Join("\n", lines);
    }
}
