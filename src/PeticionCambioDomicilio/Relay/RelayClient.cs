using System.Text;
using System.Text.Json;
using PeticionCambioDomicilio.Ews;

namespace PeticionCambioDomicilio.Relay;

/// <summary>Un envio pendiente que devolvio GET /api/relay/pendientes.</summary>
public sealed record RelayEnvio(long Id, string Para, string Asunto, string CuerpoHtml, string? LeaseToken);

/// <summary>Resumen de un ciclo de polling.</summary>
public sealed record RelayCycleResult(int Procesados, int Enviados, int Fallidos, bool CredencialesRechazadas);

/// <summary>
/// Cliente aditivo (modo `--relay` de <c>Program.cs</c>): hace polling sobre
/// <c>GET /api/relay/pendientes</c> del worker Cloudflare, envia cada correo con el
/// <see cref="IMailSender"/> local (mismo EWS on-premises de siempre) y reporta el
/// resultado con <c>POST /api/relay/resultado</c>. Nada de esto toca el .exe existente:
/// es un modo alternativo que se agrega, no reemplaza el flujo de la Razor Page.
///
/// Un <see cref="EwsAuthException"/> (401/403 contra Exchange) corta el ciclo de inmediato
/// sin seguir con los demas pendientes del lote: reintentar con credenciales rechazadas
/// solo acelera el bloqueo de la cuenta de dominio (mismo criterio que EwsMailSender).
/// </summary>
public sealed class RelayClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http;
    private readonly IMailSender _mailSender;

    public RelayClient(HttpClient http, IMailSender mailSender)
    {
        _http = http;
        _mailSender = mailSender;
    }

    /// <summary>Un ciclo: pide hasta <paramref name="limite"/> pendientes, los envia y reporta cada resultado.</summary>
    public async Task<RelayCycleResult> RunOnceAsync(int limite, CancellationToken cancellationToken)
    {
        var pendientes = await ObtenerPendientesAsync(limite, cancellationToken);

        var enviados = 0;
        var fallidos = 0;

        foreach (var envio in pendientes)
        {
            try
            {
                await _mailSender.SendAsync(envio.Para, envio.Asunto, envio.CuerpoHtml, cancellationToken);
                await ReportarResultadoAsync(envio.Id, ok: true, detalle: null, envio.LeaseToken, cancellationToken);
                enviados++;
            }
            catch (EwsAuthException ex)
            {
                await ReportarResultadoAsync(envio.Id, ok: false, ex.Message, envio.LeaseToken, cancellationToken);
                return new RelayCycleResult(pendientes.Count, enviados, fallidos + 1, CredencialesRechazadas: true);
            }
            catch (Exception ex)
            {
                await ReportarResultadoAsync(envio.Id, ok: false, ex.Message, envio.LeaseToken, cancellationToken);
                fallidos++;
            }
        }

        return new RelayCycleResult(pendientes.Count, enviados, fallidos, CredencialesRechazadas: false);
    }

    /// <summary>
    /// Loop indefinido: un ciclo cada <paramref name="intervalo"/>. Se detiene solo si
    /// <paramref name="cancellationToken"/> se cancela o si Exchange rechaza credenciales
    /// (hay que revisar usuario/clave a mano, no tiene sentido seguir insistiendo).
    /// </summary>
    public async Task RunAsync(int limite, TimeSpan intervalo, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var resultado = await RunOnceAsync(limite, cancellationToken);
            if (resultado.CredencialesRechazadas)
            {
                break;
            }

            try
            {
                await Task.Delay(intervalo, cancellationToken);
            }
            catch (TaskCanceledException)
            {
                break;
            }
        }
    }

    private async Task<List<RelayEnvio>> ObtenerPendientesAsync(int limite, CancellationToken cancellationToken)
    {
        using var response = await _http.GetAsync($"api/relay/pendientes?limit={limite}", cancellationToken);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadAsStringAsync(cancellationToken);
        using var doc = JsonDocument.Parse(json);

        var lista = new List<RelayEnvio>();
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            lista.Add(new RelayEnvio(
                item.GetProperty("id").GetInt64(),
                item.GetProperty("para").GetString() ?? "",
                item.GetProperty("asunto").GetString() ?? "",
                item.GetProperty("cuerpo_html").GetString() ?? "",
                item.TryGetProperty("lease_token", out var lease) ? lease.GetString() : null));
        }

        return lista;
    }

    private async Task ReportarResultadoAsync(long id, bool ok, string? detalle, string? leaseToken, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.Serialize(new { id, ok, detalle, leaseToken }, JsonOptions);
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync("api/relay/resultado", content, cancellationToken);
        response.EnsureSuccessStatusCode();
    }
}
