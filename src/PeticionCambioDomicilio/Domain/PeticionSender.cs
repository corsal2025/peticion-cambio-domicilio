using PeticionCambioDomicilio.Comunas;
using PeticionCambioDomicilio.Data;
using PeticionCambioDomicilio.Ews;

namespace PeticionCambioDomicilio.Domain;

public sealed record SendResult(EstadoPeticion Estado, string Mensaje);

/// <summary>
/// Envía una petición: busca el/los correo(s) de la comuna en el directorio, arma el
/// correo con la plantilla del art. 14, lo manda por EWS y actualiza el estado.
/// </summary>
public sealed class PeticionSender
{
    private readonly PeticionRepository _repository;
    private readonly ComunaDirectory _directory;
    private readonly IMailSender _mail;
    private readonly AppOptions _options;

    public PeticionSender(
        PeticionRepository repository,
        ComunaDirectory directory,
        IMailSender mail,
        AppOptions options)
    {
        _repository = repository;
        _directory = directory;
        _mail = mail;
        _options = options;
    }

    public async Task<SendResult> SendAsync(long peticionId, CancellationToken cancellationToken)
    {
        var p = _repository.Get(peticionId);
        if (p is null)
        {
            return new SendResult(EstadoPeticion.Error, "La petición ya no existe.");
        }

        if (p.Estado == EstadoPeticion.Enviada)
        {
            return new SendResult(EstadoPeticion.Enviada, "Ya estaba enviada.");
        }

        if (!_mail.IsConfigured)
        {
            return new SendResult(EstadoPeticion.Error,
                "El correo EWS no está configurado (Peticion:Ews en appsettings.Local.json).");
        }

        var destinatarios = _directory.EmailsFor(p.Comuna);
        if (destinatarios.Count == 0)
        {
            _repository.UpdateEstado(p.Id, EstadoPeticion.SinCorreoComuna,
                $"Sin correo registrado para la comuna \"{p.Comuna}\".", null, null);
            return new SendResult(EstadoPeticion.SinCorreoComuna,
                $"No hay correo en el directorio para la comuna \"{p.Comuna}\".");
        }

        var subject = EmailTemplate.Subject(p);
        var body = EmailTemplate.Body(p, _options.MailboxAddress);

        // MODO PRUEBA: nada sale hacia la municipalidad. Un solo correo a la casilla de prueba,
        // marcado, diciendo a dónde habría ido de verdad.
        var modoPrueba = !string.IsNullOrWhiteSpace(_options.TestModeEmail);
        var realDestinatarios = destinatarios;
        if (modoPrueba)
        {
            subject = $"[PRUEBA] {subject}";
            var cabecera = new[]
            {
                "*** CORREO DE PRUEBA - NO SE ENVIO A LA MUNICIPALIDAD ***",
                $"Comuna destino real: {p.Comuna}",
                $"Habria ido a: {string.Join(", ", destinatarios)}",
                new string('-', 60),
                string.Empty,
                string.Empty,
            };
            body = string.Join("\n", cabecera) + body;
            realDestinatarios = new[] { _options.TestModeEmail!.Trim() };
        }

        try
        {
            foreach (var to in realDestinatarios)
            {
                await _mail.SendAsync(to, subject, body, cancellationToken);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException
                                       or System.Net.Sockets.SocketException or TaskCanceledException)
        {
            _repository.UpdateEstado(p.Id, EstadoPeticion.Error, ex.Message, null, null);
            return new SendResult(EstadoPeticion.Error, $"Falló el envío: {ex.Message}");
        }

        var joined = string.Join(", ", realDestinatarios);
        var detalle = modoPrueba ? $"MODO PRUEBA — desviada desde {string.Join(", ", destinatarios)}" : null;
        _repository.UpdateEstado(p.Id, EstadoPeticion.Enviada, detalle, DateTimeOffset.Now, joined);
        return new SendResult(EstadoPeticion.Enviada,
            modoPrueba
                ? $"[PRUEBA] Enviada a {joined} (habría ido a {p.Comuna})."
                : $"Enviada a {joined}.");
    }
}
