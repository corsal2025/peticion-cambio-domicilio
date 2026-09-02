using PeticionCambioDomicilio.Domain;

namespace PeticionCambioDomicilio.Comunas;

public sealed record ComunaContact(string Comuna, string Email, string Domain);

/// <summary>
/// Directorio de correos municipales. Carga el CSV (Comuna,ContactEmail,Domain) una vez y
/// resuelve la(s) dirección(es) de una comuna por nombre (sin distinguir tildes ni mayúsculas).
/// El CSV viene de LicenciasCarpetas/data/comunas.csv (513 comunas oficiales).
/// </summary>
public sealed class ComunaDirectory
{
    private readonly IReadOnlyList<ComunaContact> _contacts;
    private readonly ILookup<string, ComunaContact> _byComuna;

    public ComunaDirectory(string csvPath)
    {
        _contacts = File.Exists(csvPath) ? Parse(csvPath) : Array.Empty<ComunaContact>();
        _byComuna = _contacts.ToLookup(c => TextNormalization.Fold(c.Comuna));
    }

    public int Count => _contacts.Count;

    public IReadOnlyList<ComunaContact> All() => _contacts;

    public IReadOnlyList<string> ComunaNames() =>
        _contacts.Select(c => c.Comuna).Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(c => c, StringComparer.CurrentCulture).ToList();

    /// <summary>Correos registrados para una comuna, sin repetir. Vacío si la comuna no está en el directorio.</summary>
    public IReadOnlyList<string> EmailsFor(string? comuna)
    {
        var key = TextNormalization.Fold(comuna);
        return _byComuna[key]
            .Select(c => c.Email)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static List<ComunaContact> Parse(string csvPath)
    {
        var result = new List<ComunaContact>();
        var lines = File.ReadAllLines(csvPath);
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (i == 0 && line.Contains("Comuna", StringComparison.OrdinalIgnoreCase))
            {
                continue; // encabezado
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var fields = SplitCsv(line);
            if (fields.Count < 3)
            {
                continue;
            }

            result.Add(new ComunaContact(fields[0].Trim(), fields[1].Trim(), fields[2].Trim()));
        }

        return result;
    }

    private static List<string> SplitCsv(string line)
    {
        var fields = new List<string>();
        var sb = new System.Text.StringBuilder();
        var inQuotes = false;
        foreach (var c in line)
        {
            switch (c)
            {
                case '"':
                    inQuotes = !inQuotes;
                    break;
                case ',' when !inQuotes:
                    fields.Add(sb.ToString());
                    sb.Clear();
                    break;
                default:
                    sb.Append(c);
                    break;
            }
        }

        fields.Add(sb.ToString());
        return fields;
    }
}
