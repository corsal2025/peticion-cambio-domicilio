using PeticionCambioDomicilio;
using PeticionCambioDomicilio.Comunas;
using PeticionCambioDomicilio.Data;
using PeticionCambioDomicilio.Domain;
using PeticionCambioDomicilio.Excel;
using PeticionCambioDomicilio.Ews;

var builder = WebApplication.CreateBuilder(args);

builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

var options = builder.Configuration.GetSection(AppOptions.SectionName).Get<AppOptions>() ?? new AppOptions();
builder.Services.AddSingleton(options);

var contentRoot = builder.Environment.ContentRootPath;

var comunaCsv = !string.IsNullOrWhiteSpace(options.ComunaDirectoryCsvPath)
    ? options.ComunaDirectoryCsvPath
    : Path.Combine(contentRoot, "data", "comunas.csv");
builder.Services.AddSingleton(new ComunaDirectory(comunaCsv));

var dbPath = Path.Combine(contentRoot, "data", "peticiones.db");
builder.Services.AddSingleton(new PeticionRepository(dbPath));

builder.Services.AddSingleton<IMailSender, EwsMailSender>();
builder.Services.AddSingleton<ExcelPeticionImporter>();
builder.Services.AddSingleton<PeticionSender>();

builder.Services.AddRazorPages();

var app = builder.Build();

// Importación headless: dotnet run -- --import ["ruta.xlsx"]
if (args.Contains("--import"))
{
    var idx = Array.IndexOf(args, "--import");
    var path = idx + 1 < args.Length && !args[idx + 1].StartsWith("--") ? args[idx + 1] : options.ExcelPath;
    if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
    {
        Console.Error.WriteLine($"Excel no encontrado: '{path}'. Pasá la ruta o configurá Peticion:ExcelPath.");
        return;
    }

    var repo = app.Services.GetRequiredService<PeticionRepository>();
    var importer = app.Services.GetRequiredService<ExcelPeticionImporter>();
    var r = importer.Import(path, repo.AddIfNew);
    Console.WriteLine($"Hojas leídas:          {r.HojasLeidas}");
    Console.WriteLine($"Filas leídas:          {r.FilasLeidas}");
    Console.WriteLine($"Filas CAMBIO DE DOM.:  {r.FilasCambioDomicilio}");
    Console.WriteLine($"Peticiones nuevas:     {r.Nuevas}");
    Console.WriteLine($"Duplicadas (ya había): {r.Duplicadas}");
    Console.WriteLine($"RUT inválidos:         {r.RutInvalidos}");
    Console.WriteLine($"Comuna no reconocida:  {r.ComunaNoReconocida}");
    foreach (var aviso in r.Avisos.Take(40))
    {
        Console.WriteLine($"  - {aviso}");
    }

    if (r.Avisos.Count > 40)
    {
        Console.WriteLine($"  ... y {r.Avisos.Count - 40} avisos más.");
    }

    return;
}

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
}

app.UseStaticFiles();
app.UseRouting();
app.MapRazorPages();

app.Run();
