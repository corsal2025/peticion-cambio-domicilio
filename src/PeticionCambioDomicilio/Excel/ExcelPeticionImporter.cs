using ClosedXML.Excel;
using PeticionCambioDomicilio.Domain;

namespace PeticionCambioDomicilio.Excel;

public sealed record ImportResult(
    int FilasLeidas,
    int FilasCambioDomicilio,
    int Nuevas,
    int Duplicadas,
    int RutInvalidos,
    IReadOnlyList<string> Avisos);

/// <summary>
/// Lee el Excel de solicitudes, se queda con las filas cuya columna "Trámite" dice
/// "CAMBIO DE DOMICILIO" (configurable), y extrae Nombre / RUT / Comuna / Fecha / Clases.
/// Los encabezados se ubican por nombre sin distinguir mayúsculas ni tildes, así que el
/// orden de las columnas en el Excel no importa.
/// </summary>
public sealed class ExcelPeticionImporter
{
    private readonly AppOptions _options;

    public ExcelPeticionImporter(AppOptions options) => _options = options;

    public ImportResult Import(string excelPath, Func<Peticion, bool> addIfNew)
    {
        var avisos = new List<string>();
        using var workbook = new XLWorkbook(excelPath);

        var sheet = string.IsNullOrWhiteSpace(_options.ExcelSheetName)
            ? workbook.Worksheets.First()
            : workbook.Worksheets.Worksheet(_options.ExcelSheetName);

        var used = sheet.RangeUsed();
        if (used is null)
        {
            return new ImportResult(0, 0, 0, 0, 0, new[] { "La hoja está vacía." });
        }

        var headerRow = used.FirstRow();
        var headers = new Dictionary<string, int>();
        foreach (var cell in headerRow.Cells())
        {
            var key = TextNormalization.Fold(cell.GetString());
            if (key.Length > 0 && !headers.ContainsKey(key))
            {
                headers[key] = cell.Address.ColumnNumber;
            }
        }

        int? Col(string configured)
        {
            var key = TextNormalization.Fold(configured);
            return headers.TryGetValue(key, out var c) ? c : null;
        }

        var cTramite = Col(_options.Columns.Tramite);
        var cNombre = Col(_options.Columns.NombreCompleto);
        var cRut = Col(_options.Columns.Rut);
        var cComuna = Col(_options.Columns.Comuna);
        var cFecha = Col(_options.Columns.FechaSolicitud);
        var cClases = Col(_options.Columns.Clases);

        foreach (var (label, col, name) in new[]
                 {
                     ("Trámite", cTramite, _options.Columns.Tramite),
                     ("Nombre", cNombre, _options.Columns.NombreCompleto),
                     ("RUT", cRut, _options.Columns.Rut),
                     ("Comuna", cComuna, _options.Columns.Comuna),
                 })
        {
            if (col is null)
            {
                avisos.Add($"No se encontró la columna de {label} (encabezado esperado: \"{name}\").");
            }
        }

        if (cTramite is null || cNombre is null || cRut is null || cComuna is null)
        {
            return new ImportResult(0, 0, 0, 0, 0, avisos);
        }

        var ordenObjetivo = TextNormalization.Fold(_options.OrdenCambioDomicilio);
        int filasLeidas = 0, filasCd = 0, nuevas = 0, duplicadas = 0, rutInvalidos = 0;

        foreach (var row in used.RowsUsed().Skip(1))
        {
            filasLeidas++;

            var tramite = TextNormalization.Fold(row.Cell(cTramite.Value).GetString());
            if (tramite != ordenObjetivo)
            {
                continue;
            }

            filasCd++;

            var nombre = row.Cell(cNombre.Value).GetString().Trim();
            var rutRaw = row.Cell(cRut.Value).GetString().Trim();
            var comuna = row.Cell(cComuna.Value).GetString().Trim();
            var clases = cClases is null ? null : row.Cell(cClases.Value).GetString().Trim();
            var fecha = cFecha is null ? null : ReadDate(row.Cell(cFecha.Value));

            if (string.IsNullOrWhiteSpace(nombre) && string.IsNullOrWhiteSpace(rutRaw))
            {
                avisos.Add($"Fila {row.RowNumber()}: sin nombre ni RUT, se omite.");
                continue;
            }

            var rutNormalizado = RutValidator.NormalizeAndValidate(rutRaw);
            var rutInvalido = rutNormalizado is null;
            if (rutInvalido)
            {
                rutInvalidos++;
                avisos.Add($"Fila {row.RowNumber()}: RUT \"{rutRaw}\" no valida — se guarda para revisión.");
            }

            var peticion = new Peticion
            {
                NombreCompleto = nombre,
                Rut = rutNormalizado ?? (rutRaw.Length > 0 ? rutRaw : "SIN RUT"),
                Comuna = comuna,
                Clases = string.IsNullOrWhiteSpace(clases) ? null : clases,
                FechaSolicitud = fecha,
                Origen = $"{sheet.Name}!fila {row.RowNumber()}",
                RutInvalido = rutInvalido,
            };

            if (addIfNew(peticion))
            {
                nuevas++;
            }
            else
            {
                duplicadas++;
            }
        }

        return new ImportResult(filasLeidas, filasCd, nuevas, duplicadas, rutInvalidos, avisos);
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
