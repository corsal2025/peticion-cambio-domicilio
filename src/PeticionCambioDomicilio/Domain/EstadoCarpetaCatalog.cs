namespace PeticionCambioDomicilio.Domain;

/// <summary>
/// Los mismos valores del desplegable "ESTADO DE LA CARPETA" del libro DETALLE CARPETAS
/// (hojas de agenda mensual). El operador mueve la carpeta por estos estados desde el
/// dashboard, sin volver al Excel. Al importar, una fila nueva entra como "CAMBIO DE DOMICILIO".
/// </summary>
public static class EstadoCarpetaCatalog
{
    public const string CambioDeDomicilio = "CAMBIO DE DOMICILIO";

    public static readonly IReadOnlyList<string> Valores = new[]
    {
        "CAMBIO DE DOMICILIO",
        "CAMBIO DE DOMICILIO SOLICITADO",
        "CAMBIO DOM. SUBIDO A CONASET",
        "CAMBIO DOM. SUBIDO CON CORREO",
        "SUBIDA A CONASET",
        "SUBIDA CON F8",
        "SUBIDA CON OFICIO",
        "SE ENCUENTRA EN ARCHIVOS",
        "SE ENCUENTRA EN OF. 43",
        "NO EXISTE CARPETA",
        "CREAR OFICIO",
        "CREAR CERTIFICADO",
        "CANJE LIC. EXTRANJERA",
        "1° LICENCIA",
    };

    /// <summary>Estados que significan "la carpeta ya se subió / el trámite terminó".</summary>
    public static bool EsFinalizado(string? estado) => estado is
        "CAMBIO DOM. SUBIDO A CONASET" or
        "CAMBIO DOM. SUBIDO CON CORREO" or
        "SUBIDA A CONASET" or
        "SUBIDA CON F8" or
        "SUBIDA CON OFICIO";

    public static string Normalizar(string? crudo)
    {
        var f = TextNormalization.Fold(crudo);
        foreach (var v in Valores)
        {
            if (TextNormalization.Fold(v) == f)
            {
                return v;
            }
        }

        // variantes de tipeo conocidas del libro
        return f switch
        {
            "se encuentra en of 43" or "se encuentra en of43" => "SE ENCUENTRA EN OF. 43",
            "cambio dom subido a conaset" => "CAMBIO DOM. SUBIDO A CONASET",
            "cambio de dom subido con correo" => "CAMBIO DOM. SUBIDO CON CORREO",
            "" => CambioDeDomicilio,
            _ => crudo?.Trim().ToUpperInvariant() ?? CambioDeDomicilio,
        };
    }
}
