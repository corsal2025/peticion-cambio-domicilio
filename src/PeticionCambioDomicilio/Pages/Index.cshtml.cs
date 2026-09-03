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
    private readonly PeticionRepository _repository;
    private readonly ExcelPeticionImporter _importer;
    private readonly PeticionSender _sender;
    private readonly ComunaDirectory _directory;
    private readonly IMailSender _mail;
    private readonly AppOptions _options;
    private readonly EmlWriter _eml;

    public IndexModel(
        PeticionRepository repository,
        ExcelPeticionImporter importer,
        PeticionSender sender,
        ComunaDirectory directory,
        IMailSender mail,
        AppOptions options,
        EmlWriter eml)
    {
        _repository = repository;
        _importer = importer;
        _sender = sender;
        _directory = directory;
        _mail = mail;
        _options = options;
        _eml = eml;
    }

    public IReadOnlyList<Peticion> Peticiones { get; private set; } = Array.Empty<Peticion>();
    public bool MailListo => _mail.IsConfigured;
    public bool ExcelConfigurado => !string.IsNullOrWhiteSpace(_options.ExcelPath) && System.IO.File.Exists(_options.ExcelPath);
    public string? ExcelPath => _options.ExcelPath;
    public int ComunasEnDirectorio => _directory.Count;
    public string? ModoPruebaEmail => string.IsNullOrWhiteSpace(_options.TestModeEmail) ? null : _options.TestModeEmail;

    public void OnGet() => Peticiones = _repository.All();

    public IActionResult OnPostImportar()
    {
        if (!ExcelConfigurado)
        {
            TempData["Flash"] = "Configura la ruta del Excel en Configuración antes de importar.";
            return RedirectToPage();
        }

        try
        {
            var result = _importer.Import(_options.ExcelPath!, _repository.AddIfNew);
            var msg = $"Hojas: {result.HojasLeidas} · Filas: {result.FilasLeidas} · " +
                      $"Cambio de domicilio: {result.FilasCambioDomicilio} · Nuevas: {result.Nuevas} · " +
                      $"Duplicadas: {result.Duplicadas} · RUT inválidos: {result.RutInvalidos} · " +
                      $"Comuna no reconocida: {result.ComunaNoReconocida}";
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

    public async Task<IActionResult> OnPostEnviar(long id)
    {
        var result = await _sender.SendAsync(id, HttpContext.RequestAborted);
        TempData["Flash"] = result.Mensaje;
        return RedirectToPage();
    }

    public async Task<IActionResult> OnPostEnviarTodas()
    {
        var pendientes = _repository.All()
            .Where(p => p.Estado is EstadoPeticion.Borrador or EstadoPeticion.SinCorreoComuna or EstadoPeticion.Error)
            .ToList();

        int ok = 0, fail = 0;
        foreach (var p in pendientes)
        {
            var result = await _sender.SendAsync(p.Id, HttpContext.RequestAborted);
            if (result.Estado == EstadoPeticion.Enviada)
            {
                ok++;
            }
            else
            {
                fail++;
            }
        }

        TempData["Flash"] = $"Enviadas: {ok} · Con problema: {fail}.";
        return RedirectToPage();
    }

    /// <summary>Descarga el correo como .eml: doble clic y Outlook lo abre listo para enviar.
    /// No usa EWS ni credenciales.</summary>
    public IActionResult OnPostBorrador(long id)
    {
        var p = _repository.Get(id);
        if (p is null)
        {
            TempData["Flash"] = "La peticion ya no existe.";
            return RedirectToPage();
        }

        var bytes = _eml.Build(p);
        if (bytes is null)
        {
            TempData["Flash"] = $"No hay correo registrado para la comuna \"{p.Comuna}\". Agregalo en Comunas.";
            return RedirectToPage();
        }

        return File(bytes, "message/rfc822", _eml.FileNameFor(p));
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

    /// <summary>Borra TODAS las peticiones. La confirmacion la hace la pantalla.</summary>
    public IActionResult OnPostBorrarTodo()
    {
        var n = _repository.DeleteAll();
        TempData["Flash"] = $"Se borraron {n} peticion(es). El Excel no se toca; podes reimportar cuando quieras.";
        return RedirectToPage();
    }

    public IActionResult OnPostEliminar(long id)
    {
        _repository.Delete(id);
        TempData["Flash"] = "Petición eliminada.";
        return RedirectToPage();
    }
}
