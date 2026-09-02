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

    /// <summary>
    /// Intenta calzar un texto sucio del Excel (con tipeos: "VIÑA DELA MAR", "QUILPUE", espacios
    /// dobles) contra el nombre oficial de una comuna del directorio. Devuelve el nombre canónico
    /// o null si no hay match razonable. Descarta valores que claramente no son comuna
    /// ("RUT INVALIDO", números, fechas).
    /// </summary>
    public string? ResolveComunaName(string? raw)
    {
        var folded = TextNormalization.Fold(raw);
        if (folded.Length < 3 || folded.Any(char.IsDigit) || folded is "rut invalido" or "rut ivalido"
            or "rur invalido" or "pendiente f8" or "1 licencia")
        {
            return null;
        }

        // Exacto (folded).
        var exact = _byComuna[folded].FirstOrDefault();
        if (exact is not null)
        {
            return exact.Comuna;
        }

        // Distancia de edición <= 2 contra cada nombre oficial folded.
        string? best = null;
        var bestDistance = int.MaxValue;
        foreach (var name in _byComuna.Select(g => g.Key).Distinct())
        {
            var d = Levenshtein(folded, name, 2);
            if (d < bestDistance)
            {
                bestDistance = d;
                best = _byComuna[name].First().Comuna;
            }
        }

        return bestDistance <= 2 ? best : null;
    }

    private static int Levenshtein(string a, string b, int max)
    {
        if (Math.Abs(a.Length - b.Length) > max)
        {
            return max + 1;
        }

        var prev = new int[b.Length + 1];
        var curr = new int[b.Length + 1];
        for (var j = 0; j <= b.Length; j++)
        {
            prev[j] = j;
        }

        for (var i = 1; i <= a.Length; i++)
        {
            curr[0] = i;
            var rowMin = curr[0];
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                curr[j] = Math.Min(Math.Min(curr[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                rowMin = Math.Min(rowMin, curr[j]);
            }

            if (rowMin > max)
            {
                return max + 1;
            }

            (prev, curr) = (curr, prev);
        }

        return prev[b.Length];
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
