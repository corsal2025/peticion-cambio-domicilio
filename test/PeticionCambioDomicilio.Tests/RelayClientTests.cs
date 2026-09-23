using System.Net;
using System.Text;
using System.Text.Json;
using PeticionCambioDomicilio.Ews;
using PeticionCambioDomicilio.Relay;

namespace PeticionCambioDomicilio.Tests;

/// <summary>Handler falso: enruta por metodo+ruta a una funcion, sin tocar la red.</summary>
public sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _responder;
    public List<HttpRequestMessage> Requests { get; } = new();

    public FakeHttpMessageHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> responder)
    {
        _responder = responder;
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return await _responder(request);
    }
}

public sealed class FakeMailSender : IMailSender
{
    private readonly Func<string, string, string, Task> _onSend;
    public bool IsConfigured => true;
    public List<(string To, string Subject, string Body)> Enviados { get; } = new();

    public FakeMailSender(Func<string, string, string, Task>? onSend = null)
    {
        _onSend = onSend ?? ((_, _, _) => Task.CompletedTask);
    }

    public async Task SendAsync(string toAddress, string subject, string body, CancellationToken cancellationToken)
    {
        Enviados.Add((toAddress, subject, body));
        await _onSend(toAddress, subject, body);
    }
}

public class RelayClientTests
{
    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    [Fact]
    public async Task RunOnceAsync_envia_los_pendientes_y_reporta_ok()
    {
        var pendientes = new[]
        {
            new { id = 1, para = "a@x.cl", asunto = "Asunto 1", cuerpo_html = "Cuerpo 1" },
            new { id = 2, para = "b@x.cl", asunto = "Asunto 2", cuerpo_html = "Cuerpo 2" },
        };
        var resultadosReportados = new List<JsonElement>();

        var handler = new FakeHttpMessageHandler(async req =>
        {
            if (req.Method == HttpMethod.Get && req.RequestUri!.AbsolutePath.EndsWith("pendientes"))
            {
                return Json(pendientes);
            }

            if (req.Method == HttpMethod.Post && req.RequestUri!.AbsolutePath.EndsWith("resultado"))
            {
                var texto = await req.Content!.ReadAsStringAsync();
                resultadosReportados.Add(JsonDocument.Parse(texto).RootElement.Clone());
                return Json(new { ok = true });
            }

            throw new InvalidOperationException($"Ruta no esperada: {req.RequestUri}");
        });

        using var http = new HttpClient(handler) { BaseAddress = new Uri("http://relay.local/") };
        var mailSender = new FakeMailSender();
        var client = new RelayClient(http, mailSender);

        var resultado = await client.RunOnceAsync(10, CancellationToken.None);

        Assert.Equal(2, resultado.Procesados);
        Assert.Equal(2, resultado.Enviados);
        Assert.Equal(0, resultado.Fallidos);
        Assert.False(resultado.CredencialesRechazadas);
        Assert.Equal(2, mailSender.Enviados.Count);
        Assert.Equal(2, resultadosReportados.Count);
        Assert.All(resultadosReportados, r => Assert.True(r.GetProperty("ok").GetBoolean()));
    }

    [Fact]
    public async Task RunOnceAsync_reporta_error_cuando_falla_el_envio_pero_sigue_con_los_demas()
    {
        var pendientes = new[]
        {
            new { id = 1, para = "a@x.cl", asunto = "Asunto 1", cuerpo_html = "Cuerpo 1" },
            new { id = 2, para = "b@x.cl", asunto = "Asunto 2", cuerpo_html = "Cuerpo 2" },
        };
        var reportados = new List<(long Id, bool Ok)>();

        var handler = new FakeHttpMessageHandler(async req =>
        {
            if (req.Method == HttpMethod.Get)
            {
                return Json(pendientes);
            }

            var texto = await req.Content!.ReadAsStringAsync();
            var doc = JsonDocument.Parse(texto).RootElement;
            reportados.Add((doc.GetProperty("id").GetInt64(), doc.GetProperty("ok").GetBoolean()));
            return Json(new { ok = true });
        });

        using var http = new HttpClient(handler) { BaseAddress = new Uri("http://relay.local/") };
        var mailSender = new FakeMailSender((to, _, _) =>
            to == "a@x.cl" ? throw new EwsSendException("boom") : Task.CompletedTask);
        var client = new RelayClient(http, mailSender);

        var resultado = await client.RunOnceAsync(10, CancellationToken.None);

        Assert.Equal(2, resultado.Procesados);
        Assert.Equal(1, resultado.Enviados);
        Assert.Equal(1, resultado.Fallidos);
        Assert.False(resultado.CredencialesRechazadas);
        Assert.Contains(reportados, r => r.Id == 1 && r.Ok == false);
        Assert.Contains(reportados, r => r.Id == 2 && r.Ok == true);
    }

    [Fact]
    public async Task RunOnceAsync_corta_apenas_hay_credenciales_rechazadas_sin_seguir_con_los_demas()
    {
        var pendientes = new[]
        {
            new { id = 1, para = "a@x.cl", asunto = "Asunto 1", cuerpo_html = "Cuerpo 1" },
            new { id = 2, para = "b@x.cl", asunto = "Asunto 2", cuerpo_html = "Cuerpo 2" },
        };

        var handler = new FakeHttpMessageHandler(req =>
            Task.FromResult(req.Method == HttpMethod.Get ? Json(pendientes) : Json(new { ok = true })));

        using var http = new HttpClient(handler) { BaseAddress = new Uri("http://relay.local/") };
        var mailSender = new FakeMailSender((_, _, _) =>
            throw new EwsAuthException("credenciales rechazadas"));
        var client = new RelayClient(http, mailSender);

        var resultado = await client.RunOnceAsync(10, CancellationToken.None);

        Assert.True(resultado.CredencialesRechazadas);
        Assert.Equal(0, resultado.Enviados);
        Assert.Single(mailSender.Enviados); // no siguio con el segundo pendiente
    }

    [Fact]
    public async Task ObtenerPendientes_manda_el_limite_y_el_secreto_configurados_en_el_header()
    {
        var handler = new FakeHttpMessageHandler(req =>
            Task.FromResult(req.Method == HttpMethod.Get ? Json(Array.Empty<object>()) : Json(new { ok = true })));

        using var http = new HttpClient(handler) { BaseAddress = new Uri("http://relay.local/") };
        http.DefaultRequestHeaders.Add("X-Relay-Secret", "s3cr3t");
        var client = new RelayClient(http, new FakeMailSender());

        await client.RunOnceAsync(7, CancellationToken.None);

        var peticion = Assert.Single(handler.Requests);
        Assert.Contains("limit=7", peticion.RequestUri!.Query);
        Assert.Equal("s3cr3t", peticion.Headers.GetValues("X-Relay-Secret").Single());
    }
}
