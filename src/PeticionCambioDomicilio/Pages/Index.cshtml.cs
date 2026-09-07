using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using PeticionCambioDomicilio;
using PeticionCambioDomicilio.Comunas;
using PeticionCambioDomicilio.Data;
using PeticionCambioDomicilio.Domain;
using PeticionCambioDomicilio.Excel;
using PeticionCambioDomicilio.Ews;

namespace PeticionCambioDomicilio.Pages;

public sealed class IndexModel : PageModel
{
    /// <summary>Pausa entre comunas en el envío masivo, para no gatillar el antispam de Exchange.</summary>
    private static readonly TimeSpan PausaEntreComunas = TimeSpan.FromSeconds(2);

    private readonly PeticionRepository _repository;
    private readonly ExcelPeticionImporter _importer;
    private readonly PeticionSender _sender;
    private readonly ComunaDirectory _directory;
    private readonly IMailSender _mail;
    private readonly AppOptions _options;

    public IndexModel(
        PeticionRepository repository,
        ExcelPeticionImporter importer,
        PeticionSender sender,
        ComunaDirectory directory,
        IMailSender mail,
        AppOptions options)
    {
        _repository = repository;
        _importer = importer;
        _sender = sender;
        _directory = directory;
        _mail = mail;
        _options = options;
    }

    public IReadOnlyList<Peticion> Peticiones { get; private set; } = Array.Empty<Peticion>();
    public bool MailListo => _mail.IsConfigured;
    public bool ExcelConfigurado => !string.IsNullOrWhiteSpace(_options.ExcelPath) && System.IO.File.Exists(_options.ExcelPath);
    public string? ExcelPath => _options.ExcelPath;
    public int ComunasEnDirectorio => _directory.Count;
    public string? ModoPruebaEmail => string.IsNullOrWhiteSpace(_options.TestModeEmail) ? null : _options.TestModeEmail;

    /// <summary>Comunas con peticiones pendientes y sin correo en el directorio — hay que cargarlas.</summary>
    public IReadOnlyList<string> ComunasSinCorreo { get; private set; } = Array.Empty<string>();

    /// <summary>Peticiones pendientes (no enviadas) por comuna, para etiquetar el botón "Enviar comuna (N)".</summary>
    public IReadOnlyDictionary<string, int> PendientesPorComuna { get; private set; } =
        new Dictionary<string, int>();

    public void OnGet()
    {
        Peticiones = _repository.All();
        ComunasSinCorreo = _sender.ComunasPendientesSinCorreo();
        PendientesPorComuna = Peticiones
            .Where(p => p.Estado is EstadoPeticion.Borrador or EstadoPeticion.SinCorreoComuna or EstadoPeticion.Error)
            .GroupBy(p => p.Comuna, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Count(), StringComparer.OrdinalIgnoreCase);
    }

    public IActionResult OnPostImportar()
    {
        if (!ExcelConfigurado)
        {
            TempData["Flash"] = "Configura la ruta del Excel en Configuración antes de importar.";
            return RedirectToPage();
        }

        _repository.Backup("import");

        try
        {
            var result = _importer.Import(
                _options.ExcelPath!,
                _repository.AddIfNew,
                _repository.All(),
                _repository.Delete);
            var msg = $"Hojas: {result.HojasLeidas} · Filas: {result.FilasLeidas} · " +
                      $"Cambio de domicilio: {result.FilasCambioDomicilio} · Nuevas: {result.Nuevas} · " +
                      $"Actualizadas: {result.Duplicadas} · Quitadas (ya no están en el Excel): {result.Obsoletas} · " +
                      $"RUT inválidos: {result.RutInvalidos} · Comuna no reconocida: {result.ComunaNoReconocida}";
            if (result.Avisos.Count > 0)
            {
                msg += $" · Avisos ({result.Avisos.Count}): " + string.Join(" | ", result.Avisos.Take(8));
            }

            TempData["Flash"] = msg;
        }
        catch (Exception ex)
        {
            TempData["Flash"] = $"Error leyendo el Excel: {ex.Message}";
        }

        return RedirectToPage();
    }

    /// <summary>Envía en UN correo todas las pendientes de la comuna de esa fila.</summary>
    public async Task<IActionResult> OnPostEnviarComuna(long id)
    {
        var p = _repository.Get(id);
        if (p is null)
        {
            TempData["Flash"] = "La petición ya no existe.";
            return RedirectToPage();
        }

        var result = await _sender.SendComunaAsync(p.Comuna, HttpContext.RequestAborted);
        TempData["Flash"] = result.Mensaje;
        return RedirectToPage();
    }

    public async Task<IActionResult> OnPostEnviarTodas()
    {
        var comunas = _repository.All()
            .Where(p => p.Estado is EstadoPeticion.Borrador or EstadoPeticion.SinCorreoComuna or EstadoPeticion.Error)
            .Select(p => p.Comuna)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(c => c, StringComparer.CurrentCulture)
            .ToList();

        int correos = 0, personas = 0, sinCorreo = 0, conError = 0;
        var primera = true;
        foreach (var comuna in comunas)
        {
            if (!primera)
            {
                await Task.Delay(PausaEntreComunas, HttpContext.RequestAborted);
            }

            primera = false;
            var result = await _sender.SendComunaAsync(comuna, HttpContext.RequestAborted);
            switch (result.Estado)
            {
                case EstadoPeticion.Enviada:
                    correos++;
                    personas += result.Personas;
                    break;
                case EstadoPeticion.SinCorreoComuna:
                    sinCorreo++;
                    break;
                default:
                    conError++;
                    break;
            }
        }

        TempData["Flash"] = $"Correos enviados: {correos} ({personas} persona/s) · " +
                            $"Comunas sin correo: {sinCorreo} · Con error: {conError}.";
        return RedirectToPage();
    }

    public IActionResult OnPostEstadoCarpeta(long id, string estado)
    {
        if (Domain.EstadoCarpetaCatalog.Valores.Contains(estado))
        {
            _repository.SetEstadoCarpeta(id, estado);
        }

        if (Request.Headers["X-Requested-With"] == "fetch")
        {
            return new JsonResult(new { ok = true, finalizado = Domain.EstadoCarpetaCatalog.EsFinalizado(estado) });
        }

        return RedirectToPage();
    }

    public IActionResult OnPostMarcar(long id)
    {
        var marcada = _repository.ToggleMarcada(id);

        // Si vino por fetch (JS), responder JSON y no recargar la pagina.
        if (Request.Headers["X-Requested-With"] == "fetch")
        {
            return new JsonResult(new { marcada });
        }

        return RedirectToPage();
    }

    /// <summary>Borra TODAS las peticiones. La confirmacion la hace la pantalla. Respalda antes.</summary>
    public IActionResult OnPostBorrarTodo()
    {
        var backup = _repository.Backup("borrartodo");
        var n = _repository.DeleteAll();
        TempData["Flash"] = backup is not null
            ? $"Se borraron {n} petición(es). Respaldo guardado en {backup}. Reimportá del Excel cuando quieras."
            : $"Se borraron {n} petición(es). ATENCIÓN: no se pudo guardar respaldo. El historial de envío se perdió.";
        return RedirectToPage();
    }

    public IActionResult OnPostEliminar(long id)
    {
        _repository.Delete(id);
        TempData["Flash"] = "Petición eliminada.";
        return RedirectToPage();
    }
}
