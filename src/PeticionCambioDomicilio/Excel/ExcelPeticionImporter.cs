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

    public ImportResult Import(string excelPath, Func<Peticion, bool> addIfNew)
    {
        var avisos = new List<string>();

        // El libro real trae listas desplegables > 255 chars que ClosedXML rechaza: se lee una
        // copia temporal sin esos nodos. El original nunca se toca.
        string? sanitizedPath = null;
        XLWorkbook workbook;
        try
        {
            workbook = new XLWorkbook(excelPath);
        }
        catch (ArgumentOutOfRangeException)
        {
            sanitizedPath = WorkbookSanitizer.CreateCopyWithoutDataValidations(excelPath);
            workbook = new XLWorkbook(sanitizedPath);
        }

        try
        {
            return ImportCore(workbook, avisos, addIfNew);
        }
        finally
        {
            workbook.Dispose();
            if (sanitizedPath is not null)
            {
                try { File.Delete(sanitizedPath); } catch { /* archivo temporal */ }
            }
        }
    }

    private ImportResult ImportCore(XLWorkbook workbook, List<string> avisos, Func<Peticion, bool> addIfNew)
    {

        var ordenObjetivo = TextNormalization.Fold(_options.EstadoCambioDomicilio);
        var ignoradas = _options.HojasIgnoradas.Select(TextNormalization.Fold).ToArray();

        int hojas = 0, filas = 0, cd = 0, nuevas = 0, dup = 0, rutInv = 0, comunaNo = 0;

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
                    RutInvalido = rutInvalido,
                    Estado = comunaCanonica is null ? EstadoPeticion.SinCorreoComuna : EstadoPeticion.Borrador,
                    DetalleEstado = comunaCanonica is null ? $"Comuna del Excel: \"{comunaRaw}\"" : null,
                };

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

        return new ImportResult(hojas, filas, cd, nuevas, dup, rutInv, comunaNo, avisos);
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
