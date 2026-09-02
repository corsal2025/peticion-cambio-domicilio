using Microsoft.AspNetCore.Mvc.RazorPages;
using PeticionCambioDomicilio;
using PeticionCambioDomicilio.Comunas;
using PeticionCambioDomicilio.Ews;

namespace PeticionCambioDomicilio.Pages;

public sealed class ConfiguracionModel : PageModel
{
    private readonly AppOptions _options;
    private readonly IMailSender _mail;
    private readonly ComunaDirectory _directory;

    public ConfiguracionModel(AppOptions options, IMailSender mail, ComunaDirectory directory)
    {
        _options = options;
        _mail = mail;
        _directory = directory;
    }

    public AppOptions Options => _options;
    public bool MailListo => _mail.IsConfigured;
    public bool ExcelExiste => !string.IsNullOrWhiteSpace(_options.ExcelPath) && System.IO.File.Exists(_options.ExcelPath);
    public int ComunasCount => _directory.Count;
    public string? ModoPruebaEmail => string.IsNullOrWhiteSpace(_options.TestModeEmail) ? null : _options.TestModeEmail;

    public void OnGet() { }
}
