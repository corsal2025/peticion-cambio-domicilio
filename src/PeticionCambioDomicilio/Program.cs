using PeticionCambioDomicilio;
using PeticionCambioDomicilio.Comunas;
using PeticionCambioDomicilio.Data;
using PeticionCambioDomicilio.Domain;
using PeticionCambioDomicilio.Excel;
using PeticionCambioDomicilio.Ews;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://*:5020");

builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);

var options = builder.Configuration.GetSection(AppOptions.SectionName).Get<AppOptions>() ?? new AppOptions();
builder.Services.AddSingleton(options);

var contentRoot = builder.Environment.ContentRootPath;

var comunaCsv = !string.IsNullOrWhiteSpace(options.ComunaDirectoryCsvPath)
    ? options.ComunaDirectoryCsvPath
    : Path.Combine(contentRoot, "data", "comunas.csv");

// Si el CSV no existe (o quedó vacío) junto al ejecutable, se escribe desde el recurso
// embebido. Asi el directorio de comunas nunca queda vacio en un publish.
if (!File.Exists(comunaCsv) || new FileInfo(comunaCsv).Length == 0)
{
    var asm = System.Reflection.Assembly.GetExecutingAssembly();
    var resName = asm.GetManifestResourceNames()
        .FirstOrDefault(n => n.EndsWith("comunas.seed.csv", StringComparison.OrdinalIgnoreCase));
    if (resName is not null)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(comunaCsv)!);
        using var res = asm.GetManifestResourceStream(resName)!;
        using var outFile = File.Create(comunaCsv);
        res.CopyTo(outFile);
    }
}

builder.Services.AddSingleton(new ComunaDirectory(comunaCsv));

var dbPath = Path.Combine(contentRoot, "data", "peticiones.db");
builder.Services.AddSingleton(new PeticionRepository(dbPath));

builder.Services.AddSingleton<IMailSender, EwsMailSender>();
builder.Services.AddSingleton<ExcelPeticionImporter>();
builder.Services.AddSingleton<PeticionSender>();

builder.Services.AddRazorPages();

var app = builder.Build();

// Los modos CLI necesitan consola: el .exe es WinExe (sin ventana propia).
if (args.Any(a => a.StartsWith("--import") || a == "--send-test" || a == "--test-ews"))
{
    ConsoleAttach.ToParentIfAny();
}

// Diagnostico de la conexion al buzon: dotnet run -- --test-ews
// OJO: cada intento fallido cuenta para el bloqueo de la cuenta en el dominio. No repetir a ciegas.
if (args.Contains("--test-ews"))
{
    var e = options.Ews;
    Console.WriteLine($"Url:      {e?.Url ?? "(sin configurar)"}");
    Console.WriteLine($"Username: {e?.Username ?? "(sin configurar)"}");
    Console.WriteLine($"Password: {(string.IsNullOrEmpty(e?.Password) ? "(sin configurar)" : new string('*', e!.Password!.Length))}");
    Console.WriteLine();

    if (e?.Url is null)
    {
        Console.Error.WriteLine("Falta Peticion:Ews:Url.");
        return;
    }

    using (var probe = new HttpClient { Timeout = TimeSpan.FromSeconds(30) })
    {
        try
        {
            using var anon = await probe.PostAsync(e.Url,
                new StringContent("<x/>", System.Text.Encoding.UTF8, "text/xml"));
            Console.WriteLine($"Sondeo anonimo: HTTP {(int)anon.StatusCode}");
            if (anon.Headers.TryGetValues("WWW-Authenticate", out var schemes))
            {
                Console.WriteLine($"El servidor acepta: {string.Join(" | ", schemes)}");
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"No se pudo alcanzar el servidor: {ex.Message}");
            return;
        }
    }

    Console.WriteLine();
    Console.WriteLine("Probando las credenciales configuradas (UN solo intento)...");
    var sender = app.Services.GetRequiredService<IMailSender>();
    if (!sender.IsConfigured)
    {
        Console.Error.WriteLine("El transporte no esta configurado (faltan Url/Username/Password).");
        return;
    }

    var destino = string.IsNullOrWhiteSpace(options.TestModeEmail) ? options.MailboxAddress : options.TestModeEmail!;
    try
    {
        await sender.SendAsync(destino, "[PRUEBA] Conexion EWS", "Prueba de conexion del dashboard Peticion de Cambio de Domicilio.", CancellationToken.None);
        Console.WriteLine($"OK: credenciales aceptadas. Correo de prueba enviado a {destino}.");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"FALLO: {ex.Message}");
        Console.Error.WriteLine();
        Console.Error.WriteLine("Si dice 401 Unauthorized, probar con sistemas:");
        Console.Error.WriteLine(@"  - Username como DOMINIO\usuario (el que funciona: servervalpo\cambiodedomicilio) en vez del correo.");
        Console.Error.WriteLine("  - Que la cuenta tenga Basic auth habilitado en Exchange para EWS.");
        Console.Error.WriteLine("  - Que la clave sea la vigente (no expirada).");
        Console.Error.WriteLine("NO repetir muchas veces: la cuenta se bloquea por intentos fallidos.");
        Environment.ExitCode = 1;
    }

    return;
}

// Prueba de envio de punta a punta: dotnet run -- --send-test
// Usa una peticion de ejemplo y el mismo camino que el boton "Enviar" del dashboard.
// Con Peticion:TestModeEmail configurado, el correo NO sale hacia ninguna municipalidad.
if (args.Contains("--send-test"))
{
    var repoT = app.Services.GetRequiredService<PeticionRepository>();
    var senderT = app.Services.GetRequiredService<PeticionSender>();
    var dirT = app.Services.GetRequiredService<ComunaDirectory>();

    if (string.IsNullOrWhiteSpace(options.TestModeEmail))
    {
        Console.Error.WriteLine("ABORTADO: Peticion:TestModeEmail esta vacio. No se hacen pruebas con envio real.");
        return;
    }

    var comunaPrueba = dirT.ComunaNames().FirstOrDefault() ?? "VINA DEL MAR";
    var prueba = new Peticion
    {
        NombreCompleto = "PRUEBA INTERNA DEL SISTEMA",
        Rut = "11.111.111-1",
        Comuna = comunaPrueba,
        Origen = "prueba manual (--send-test)",
    };

    repoT.AddIfNew(prueba);
    var creada = repoT.All().FirstOrDefault(x => x.Origen == "prueba manual (--send-test)");
    if (creada is null)
    {
        Console.Error.WriteLine("No se pudo crear la peticion de prueba.");
        return;
    }

    Console.WriteLine($"Enviando prueba -> casilla {options.TestModeEmail} (comuna simulada: {comunaPrueba})...");
    var res = await senderT.SendAsync(creada.Id, CancellationToken.None);
    Console.WriteLine($"Resultado: {res.Estado} - {res.Mensaje}");
    repoT.Delete(creada.Id);
    return;
}

// Importar el directorio de comunas desde el libro: dotnet run -- --import-comunas ["ruta.xlsx"]
if (args.Contains("--import-comunas"))
{
    var i = Array.IndexOf(args, "--import-comunas");
    var path = i + 1 < args.Length && !args[i + 1].StartsWith("--") ? args[i + 1] : options.ExcelPath;
    if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
    {
        Console.Error.WriteLine($"Excel no encontrado: '{path}'.");
        return;
    }

    var dir = app.Services.GetRequiredService<ComunaDirectory>();
    var r = dir.ImportFromWorkbook(path);
    Console.WriteLine($"Comunas leídas: {r.Leidos} · nuevas: {r.Nuevos} · ya estaban: {r.Actualizados} · total ahora: {dir.Count}");
    foreach (var a in r.Avisos) Console.WriteLine($"  - {a}");
    return;
}

// Importación de peticiones headless: dotnet run -- --import ["ruta.xlsx"]
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

    var backup = repo.Backup("import");
    if (backup is not null)
    {
        Console.WriteLine($"Respaldo previo: {backup}");
    }

    var r = importer.Import(path, repo.AddIfNew, repo.All(), repo.Delete, repo.SincronizarCarpetaDesdeExcel);
    Console.WriteLine($"Hojas leídas:          {r.HojasLeidas}");
    Console.WriteLine($"Filas leídas:          {r.FilasLeidas}");
    Console.WriteLine($"Filas CAMBIO DE DOM.:  {r.FilasCambioDomicilio}");
    Console.WriteLine($"Peticiones nuevas:     {r.Nuevas}");
    Console.WriteLine($"Duplicadas (ya había): {r.Duplicadas}");
    Console.WriteLine($"Carpetas sincronizadas: {r.CarpetasSincronizadas}");
    Console.WriteLine($"RUT inválidos:         {r.RutInvalidos}");
    Console.WriteLine($"Comuna no reconocida:  {r.ComunaNoReconocida}");
    Console.WriteLine($"Quitadas (ya no estan): {r.Obsoletas}");
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

// Doble clic en el acceso directo: abre la pestaña sola una vez que Kestrel ya escucha.
if (args.Contains("--open-browser"))
{
    // El endpoint de escucha suele ser http://*:5020 (todas las interfaces, para la LAN).
    // El navegador necesita un host real: se navega SIEMPRE a localhost, tomando solo el puerto.
    var escucha = (app.Configuration["Kestrel:Endpoints:Http:Url"] ?? "http://localhost:5020")
        .Replace("//*", "//localhost").Replace("//+", "//localhost")
        .Replace("//[::]", "//localhost").Replace("//0.0.0.0", "//localhost");
    var puerto = Uri.TryCreate(escucha, UriKind.Absolute, out var u) ? u.Port : 5020;
    var url = $"http://localhost:{puerto}";
    _ = Task.Run(async () =>
    {
        await Task.Delay(TimeSpan.FromSeconds(2));
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Console.WriteLine($"No se pudo abrir el navegador ({url}): {ex.Message}");
        }
    });
}

app.Run();
