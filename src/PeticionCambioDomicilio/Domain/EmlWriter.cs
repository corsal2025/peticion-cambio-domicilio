using System.Text;
using PeticionCambioDomicilio.Comunas;

namespace PeticionCambioDomicilio.Domain;

/// <summary>
/// Genera el correo como archivo .eml (RFC 5322). Doble clic y se abre en Outlook con
/// destinatario, asunto y cuerpo ya puestos: el operador solo aprieta Enviar.
/// Es la via que NO necesita credenciales — sirve mientras EWS siga dando 401.
/// </summary>
public sealed class EmlWriter
{
    private readonly ComunaDirectory _directory;
    private readonly AppOptions _options;

    public EmlWriter(ComunaDirectory directory, AppOptions options)
    {
        _directory = directory;
        _options = options;
    }

    /// <summary>Nombre de archivo seguro para Windows, reconocible en la carpeta.</summary>
    public string FileNameFor(Peticion p)
    {
        var prefijo = string.IsNullOrWhiteSpace(_options.TestModeEmail) ? "" : "PRUEBA - ";
        var crudo = $"{prefijo}{p.Comuna} - {p.NombreCompleto} - {p.Rut}.eml";
        foreach (var c in Path.GetInvalidFileNameChars())
        {
            crudo = crudo.Replace(c, '_');
        }

        return crudo;
    }

    /// <summary>
    /// Arma el .eml. Devuelve null si la comuna no tiene correo registrado: sin destinatario
    /// no hay borrador que valga, y es mejor que el operador lo vea en la lista.
    /// </summary>
    public byte[]? Build(Peticion p)
    {
        IReadOnlyList<string> destinatarios = _directory.EmailsFor(p.Comuna);
        if (destinatarios.Count == 0)
        {
            return null;
        }

        var subject = EmailTemplate.Subject(p);
        var body = EmailTemplate.Body(p, _options.MailboxAddress);

        // MODO PRUEBA: igual que el envio por EWS, el borrador tampoco puede quedar dirigido a la
        // municipalidad. Se redirige a la casilla de prueba y se marca, para que un doble clic
        // distraido en Outlook no le escriba de verdad a un municipio.
        if (!string.IsNullOrWhiteSpace(_options.TestModeEmail))
        {
            var cabecera = new[]
            {
                "*** BORRADOR DE PRUEBA - NO VA A LA MUNICIPALIDAD ***",
                $"Comuna destino real: {p.Comuna}",
                $"Habria ido a: {string.Join(", ", destinatarios)}",
                new string('-', 60),
                string.Empty,
                string.Empty,
            };
            body = string.Join("\n", cabecera) + body;
            subject = $"[PRUEBA] {subject}";
            destinatarios = new[] { _options.TestModeEmail!.Trim() };
        }

        var sb = new StringBuilder();
        sb.Append("From: ").Append(_options.MailboxAddress).Append(Crlf);
        sb.Append("To: ").Append(string.Join(", ", destinatarios)).Append(Crlf);
        sb.Append("Subject: ").Append(EncodeHeader(subject)).Append(Crlf);
        sb.Append("Date: ").Append(DateTimeOffset.Now.ToString("r")).Append(Crlf);
        sb.Append("MIME-Version: 1.0").Append(Crlf);
        sb.Append("Content-Type: text/plain; charset=utf-8").Append(Crlf);
        sb.Append("Content-Transfer-Encoding: 8bit").Append(Crlf);
        sb.Append("X-Unsent: 1").Append(Crlf);   // Outlook lo abre como borrador editable, no como recibido
        sb.Append(Crlf);
        sb.Append(body.Replace("\n", Crlf));

        return new UTF8Encoding(false).GetBytes(sb.ToString());
    }

    /// <summary>Asuntos con tildes o enie: RFC 2047 en base64 para que Outlook no los rompa.</summary>
    private static string EncodeHeader(string value)
    {
        if (value.All(c => c < 128))
        {
            return value;
        }

        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
        return $"=?UTF-8?B?{b64}?=";
    }

    private const string Crlf = "\r\n";
}
