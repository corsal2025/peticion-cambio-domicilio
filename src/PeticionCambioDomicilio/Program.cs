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

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
}

app.UseStaticFiles();
app.UseRouting();
app.MapRazorPages();

app.Run();
