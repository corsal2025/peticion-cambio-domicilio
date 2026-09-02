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
    public static string FileNameFor(Peticion p)
    {
        var crudo = $"{p.Comuna} - {p.NombreCompleto} - {p.Rut}.eml";
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
        var destinatarios = _directory.EmailsFor(p.Comuna);
        if (destinatarios.Count == 0)
        {
            return null;
        }

        var subject = EmailTemplate.Subject(p);
        var body = EmailTemplate.Body(p, _options.MailboxAddress);

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
