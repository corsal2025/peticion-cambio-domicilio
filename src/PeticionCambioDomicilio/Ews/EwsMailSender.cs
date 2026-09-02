using System.Net.Http.Headers;
using System.Text;
using System.Xml.Linq;

namespace PeticionCambioDomicilio.Ews;

public interface IMailSender
{
    /// <summary>true si el transporte está configurado y listo para enviar.</summary>
    bool IsConfigured { get; }

    Task SendAsync(string toAddress, string subject, string body, CancellationToken cancellationToken);
}

/// <summary>
/// Transporte SOAP mínimo contra el EWS on-premises de Exchange. Solo envía correo
/// (CreateItem / SendAndSaveCopy). Basic auth sobre TLS. Reintenta fallos transitorios.
/// Portado de LicenciasCarpetas/CambioDomicilio/Ews/* recortado a lo que esta app usa.
/// </summary>
public sealed class EwsMailSender : IMailSender, IDisposable
{
    private static readonly XNamespace Soap = "http://schemas.xmlsoap.org/soap/envelope/";
    private static readonly XNamespace T = "http://schemas.microsoft.com/exchange/services/2006/types";
    private static readonly XNamespace M = "http://schemas.microsoft.com/exchange/services/2006/messages";
    private static readonly int[] TransientStatusCodes = [408, 429, 500, 502, 503, 504];

    private readonly EwsOptions? _ews;
    private readonly string? _sendAs;
    private readonly HttpClient? _http;

    public EwsMailSender(AppOptions options)
    {
        _ews = options.Ews;
        _sendAs = string.IsNullOrWhiteSpace(options.Ews?.SendAsAddress) ? null : options.Ews!.SendAsAddress!.Trim();
        if (_ews is { Url: not null, Username: not null, Password: not null })
        {
            _http = new HttpClient { Timeout = TimeSpan.FromSeconds(100) };
            var credentials = Convert.ToBase64String(
                Encoding.UTF8.GetBytes($"{_ews.Username}:{_ews.Password}"));
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", credentials);
        }
    }

    public bool IsConfigured => _http is not null;

    public async Task SendAsync(string toAddress, string subject, string body, CancellationToken cancellationToken)
    {
        if (_http is null || _ews?.Url is null)
        {
            throw new InvalidOperationException(
                "Falta configurar Peticion:Ews (Url/Username/Password) en appsettings.Local.json.");
        }

        var soap = BuildSendMailRequest(toAddress, subject, body, _sendAs);
        var response = await PostAsync(_ews.Url, soap, cancellationToken);
        EnsureSuccess(response);
    }

    private async Task<XDocument> PostAsync(string url, string soap, CancellationToken cancellationToken)
    {
        var attempt = 0;
        var delay = TimeSpan.FromSeconds(2);
        const int maxAttempts = 4;

        while (true)
        {
            attempt++;
            try
            {
                using var content = new StringContent(soap, Encoding.UTF8, "text/xml");
                using var response = await _http!.PostAsync(url, content, cancellationToken);

                if (TransientStatusCodes.Contains((int)response.StatusCode) && attempt < maxAttempts)
                {
                    await Task.Delay(delay, cancellationToken);
                    delay *= 2;
                    continue;
                }

                response.EnsureSuccessStatusCode();
                var xml = await response.Content.ReadAsStringAsync(cancellationToken);
                return XDocument.Parse(xml);
            }
            catch (HttpRequestException) when (attempt < maxAttempts)
            {
                await Task.Delay(delay, cancellationToken);
                delay *= 2;
            }
        }
    }

    private static void EnsureSuccess(XDocument document)
    {
        var responseMessage = document.Descendants()
            .FirstOrDefault(e => e.Name.Namespace == M && e.Name.LocalName.EndsWith("ResponseMessage"));

        if (responseMessage?.Attribute("ResponseClass")?.Value == "Error")
        {
            var code = responseMessage.Element(M + "ResponseCode")?.Value ?? "desconocido";
            var text = responseMessage.Element(M + "MessageText")?.Value;
            throw new InvalidOperationException($"EWS CreateItem falló: {code}{(text is null ? "" : $" — {text}")}");
        }
    }

    private static string BuildSendMailRequest(string toAddress, string subject, string body, string? sendAsAddress)
    {
        var envelope = new XElement(Soap + "Envelope",
            new XAttribute(XNamespace.Xmlns + "soap", Soap),
            new XAttribute(XNamespace.Xmlns + "t", T),
            new XAttribute(XNamespace.Xmlns + "m", M),
            new XElement(Soap + "Header",
                new XElement(T + "RequestServerVersion", new XAttribute("Version", "Exchange2013_SP1"))),
            new XElement(Soap + "Body",
                new XElement(M + "CreateItem",
                    new XAttribute("MessageDisposition", "SendAndSaveCopy"),
                    new XElement(M + "SavedItemFolderId",
                        new XElement(T + "DistinguishedFolderId", new XAttribute("Id", "sentitems"))),
                    new XElement(M + "Items",
                        new XElement(T + "Message",
                            new XElement(T + "Subject", subject),
                            new XElement(T + "Body", new XAttribute("BodyType", "Text"), body),
                            new XElement(T + "ToRecipients",
                                new XElement(T + "Mailbox",
                                    new XElement(T + "EmailAddress", toAddress))),
                            // From solo cuando se envia como otro buzon (requiere permiso Send As).
                            // El orden importa: EWS exige ToRecipients antes que From.
                            sendAsAddress is null
                                ? null
                                : new XElement(T + "From",
                                    new XElement(T + "Mailbox",
                                        new XElement(T + "EmailAddress", sendAsAddress))))))));

        return new XDocument(new XDeclaration("1.0", "utf-8", null), envelope)
            .ToString(SaveOptions.DisableFormatting);
    }

    public void Dispose() => _http?.Dispose();
}
