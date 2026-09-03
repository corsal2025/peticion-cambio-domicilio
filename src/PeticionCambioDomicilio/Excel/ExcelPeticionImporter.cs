using ClosedXML.Excel;
using PeticionCambioDomicilio.Comunas;
using PeticionCambioDomicilio.Domain;

namespace PeticionCambioDomicilio.Excel;

public sealed record ImportResult(
    int HojasLeidas,
    int FilasLeidas,
    int FilasCambioDomicilio,
    int Nuevas,
    int Duplicadas,
    int RutInvalidos,
    int ComunaNoReconocida,
    int Obsoletas,
    IReadOnlyList<string> Avisos);

/// <summary>
/// Lee el libro DETALLE CARPETAS (todas las hojas de agenda mensual: Av. Argentina, Placilla y
/// Merc. Puerto de cada mes), se queda con las filas cuya columna "Estado de la carpeta" dice
/// "CAMBIO DE DOMICILIO" (configurable) y arma una petición por fila:
///   Nombre  = NOMBRE COMPLETO
///   RUT     = RUT (normalizado y validado)
///   Comuna  = FECHA ULTIMA CARPETA (cuando trae texto de comuna, no fecha) — calzada contra el directorio
///   Fecha   = FECHA DE LA CITACION
/// Los encabezados se ubican por nombre sin distinguir mayúsculas ni tildes; la fila de encabezado
/// se detecta sola (primera que contiene "RUT"). El orden de las columnas no importa.
/// </summary>
public sealed class ExcelPeticionImporter
{
    private readonly AppOptions _options;
    private readonly ComunaDirectory _directory;

    public ExcelPeticionImporter(AppOptions options, ComunaDirectory directory)
    {
        _options = options;
        _directory = directory;
    }

    public ImportResult Import(
        string excelPath,
        Func<Peticion, bool> addIfNew,
        IReadOnlyList<Peticion>? existentes = null,
        Action<long>? borrar = null)
    {
        var avisos = new List<string>();
        using var loaded = LoadedWorkbook.Open(excelPath);
        return ImportCore(loaded.Workbook, avisos, addIfNew, existentes, borrar);
    }

    private ImportResult ImportCore(
        XLWorkbook workbook,
        List<string> avisos,
        Func<Peticion, bool> addIfNew,
        IReadOnlyList<Peticion>? existentes,
        Action<long>? borrar)
    {
        var vistas = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var ordenObjetivo = TextNormalization.Fold(_options.EstadoCambioDomicilio);
        var ignoradas = _options.HojasIgnoradas.Select(TextNormalization.Fold).ToArray();

        int hojas = 0, filas = 0, cd = 0, nuevas = 0, dup = 0, rutInv = 0, comunaNo = 0;
        long orden = 0; // posicion global: hojas en el orden del libro, filas de arriba abajo

        foreach (var sheet in workbook.Worksheets)
        {
            var sheetFolded = TextNormalization.Fold(sheet.Name);
            if (ignoradas.Any(ig => sheetFolded.Contains(ig)))
            {
                continue;
            }

            var used = sheet.RangeUsed();
            if (used is null)
            {
                continue;
            }

            var (headerRowNumber, headers) = FindHeaderRow(used);
            if (headerRowNumber is null)
            {
                avisos.Add($"Hoja \"{sheet.Name}\": no se encontró la fila de encabezados (con \"RUT\"), se omite.");
                continue;
            }

            int? Col(string name) =>
                headers.TryGetValue(TextNormalization.Fold(name), out var c) ? c : null;

            var cNombre = Col(_options.Columns.NombreCompleto);
            var cRut = Col(_options.Columns.Rut);
            var cEstado = Col(_options.Columns.EstadoCarpeta);
            var cComuna = Col(_options.Columns.ComunaOrigen);
            var cFecha = Col(_options.Columns.FechaSolicitud);
            var cClases = Col(_options.Columns.Clases);

            if (cNombre is null || cRut is null || cEstado is null || cComuna is null)
            {
                avisos.Add($"Hoja \"{sheet.Name}\": faltan columnas obligatorias " +
                           $"(Nombre/{cNombre}, RUT/{cRut}, Estado/{cEstado}, Comuna/{cComuna}), se omite.");
                continue;
            }

            hojas++;
            var oficina = OficinaDeHoja(sheet.Name);

            foreach (var row in used.Rows())
            {
                if (row.RowNumber() <= headerRowNumber.Value)
                {
                    continue;
                }

                if (cRut is null || row.Cell(cRut.Value).IsEmpty())
                {
                    continue;
                }

                filas++;
                orden++;

                var estado = TextNormalization.Fold(row.Cell(cEstado.Value).GetString());
                if (estado != ordenObjetivo)
                {
                    continue;
                }

                cd++;

                var nombre = row.Cell(cNombre.Value).GetString().Trim();
                var rutRaw = row.Cell(cRut.Value).GetString().Trim();
                var comunaRaw = row.Cell(cComuna.Value).GetString().Trim();
                var clases = cClases is null ? null : row.Cell(cClases.Value).GetString().Trim();
                var fecha = cFecha is null ? null : ReadDate(row.Cell(cFecha.Value));

                var rutNormalizado = RutValidator.NormalizeAndValidate(rutRaw);
                var rutInvalido = rutNormalizado is null;
                if (rutInvalido)
                {
                    rutInv++;
                    avisos.Add($"{sheet.Name}!fila {row.RowNumber()}: RUT \"{rutRaw}\" no valida — se guarda para revisión.");
                }

                var comunaCanonica = _directory.ResolveComunaName(comunaRaw);
                if (comunaCanonica is null)
                {
                    comunaNo++;
                    avisos.Add($"{sheet.Name}!fila {row.RowNumber()}: comuna \"{comunaRaw}\" no se reconoce en el directorio — se guarda para revisión.");
                }

                var peticion = new Peticion
                {
                    NombreCompleto = nombre.Length > 0 ? nombre : "(sin nombre)",
                    Rut = rutNormalizado ?? (rutRaw.Length > 0 ? rutRaw : "SIN RUT"),
                    Comuna = comunaCanonica ?? (comunaRaw.Length > 0 ? comunaRaw : "(sin comuna)"),
                    Clases = string.IsNullOrWhiteSpace(clases) ? null : clases,
                    FechaSolicitud = fecha,
                    Origen = $"{sheet.Name}!fila {row.RowNumber()}",
                    Oficina = oficina,
                    OrdenImportacion = orden,
                    RutInvalido = rutInvalido,
                    Estado = comunaCanonica is null ? EstadoPeticion.SinCorreoComuna : EstadoPeticion.Borrador,
                    DetalleEstado = comunaCanonica is null ? $"Comuna del Excel: \"{comunaRaw}\"" : null,
                };

                vistas.Add(peticion.Rut + "|" + peticion.Comuna);
                if (addIfNew(peticion))
                {
                    nuevas++;
                }
                else
                {
                    dup++;
                }
            }
        }

        var obsoletas = 0;
        if (existentes is not null && borrar is not null)
        {
            foreach (var vieja in existentes)
            {
                var esBorradorLimpio = vieja.Estado == EstadoPeticion.Borrador && !vieja.Marcada;
                if (esBorradorLimpio && !vistas.Contains(vieja.Rut + "|" + vieja.Comuna))
                {
                    borrar(vieja.Id);
                    obsoletas++;
                }
            }
        }

        return new ImportResult(hojas, filas, cd, nuevas, dup, rutInv, comunaNo, obsoletas, avisos);
    }

    /// <summary>
    /// De "2DO SEM. AV. ARGENTINA" o "ENERO PLACILLA" saca solo la oficina. Son tres y solo tres:
    /// AV. ARGENTINA, PLACILLA y MERC. PUERTO. Es lo unico que se muestra en la columna Origen.
    /// </summary>
    private static string OficinaDeHoja(string sheetName)
    {
        var folded = TextNormalization.Fold(sheetName);
        if (folded.Contains("argentina")) return "AV. ARGENTINA";
        if (folded.Contains("placilla")) return "PLACILLA";
        if (folded.Contains("merc") || folded.Contains("puerto")) return "MERC. PUERTO";
        return sheetName.Trim().ToUpperInvariant();
    }

    private static (int? RowNumber, Dictionary<string, int> Headers) FindHeaderRow(IXLRange used)
    {
        foreach (var row in used.Rows().Take(8))
        {
            var cells = row.Cells().ToList();
            var hasRut = cells.Any(c => TextNormalization.Fold(c.GetString()) == "rut");
            if (!hasRut)
            {
                continue;
            }

            var headers = new Dictionary<string, int>();
            foreach (var cell in cells)
            {
                var key = TextNormalization.Fold(cell.GetString());
                if (key.Length > 0 && !headers.ContainsKey(key))
                {
                    headers[key] = cell.Address.ColumnNumber;
                }
            }

            return (row.RowNumber(), headers);
        }

        return (null, new Dictionary<string, int>());
    }

    private static DateOnly? ReadDate(IXLCell cell)
    {
        if (cell.DataType == XLDataType.DateTime && cell.TryGetValue<DateTime>(out var dt))
        {
            return DateOnly.FromDateTime(dt);
        }

        var text = cell.GetString().Trim();
        return DateOnly.TryParse(text, out var parsed) ? parsed : null;
    }
}
