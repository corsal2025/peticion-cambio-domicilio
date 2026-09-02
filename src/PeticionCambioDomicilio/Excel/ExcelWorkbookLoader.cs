using ClosedXML.Excel;

namespace PeticionCambioDomicilio.Excel;

/// <summary>
/// Abre un .xlsx tolerando el libro real DETALLE CARPETAS, que trae listas desplegables > 255
/// caracteres que ClosedXML rechaza. Si falla por eso, reintenta sobre una copia temporal sin
/// esos nodos (WorkbookSanitizer). Devolvé el resultado dentro de un <c>using</c>.
/// </summary>
public sealed class LoadedWorkbook : IDisposable
{
    public XLWorkbook Workbook { get; }
    private readonly string? _tempPath;

    private LoadedWorkbook(XLWorkbook workbook, string? tempPath)
    {
        Workbook = workbook;
        _tempPath = tempPath;
    }

    public static LoadedWorkbook Open(string path)
    {
        try
        {
            return new LoadedWorkbook(new XLWorkbook(path), null);
        }
        catch (ArgumentOutOfRangeException)
        {
            var temp = WorkbookSanitizer.CreateCopyWithoutDataValidations(path);
            return new LoadedWorkbook(new XLWorkbook(temp), temp);
        }
    }

    public void Dispose()
    {
        Workbook.Dispose();
        if (_tempPath is not null)
        {
            try { File.Delete(_tempPath); } catch { /* archivo temporal */ }
        }
    }
}
