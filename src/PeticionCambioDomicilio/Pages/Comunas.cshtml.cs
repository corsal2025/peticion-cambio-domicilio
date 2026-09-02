using Microsoft.AspNetCore.Mvc.RazorPages;
using PeticionCambioDomicilio.Comunas;

namespace PeticionCambioDomicilio.Pages;

public sealed class ComunasModel : PageModel
{
    private readonly ComunaDirectory _directory;

    public ComunasModel(ComunaDirectory directory) => _directory = directory;

    public IReadOnlyList<ComunaContact> Contactos { get; private set; } = Array.Empty<ComunaContact>();
    public string? Filtro { get; private set; }

    public void OnGet(string? q)
    {
        Filtro = q;
        var all = _directory.All();
        Contactos = string.IsNullOrWhiteSpace(q)
            ? all
            : all.Where(c => c.Comuna.Contains(q, StringComparison.OrdinalIgnoreCase)
                          || c.Email.Contains(q, StringComparison.OrdinalIgnoreCase)).ToList();
    }
}
