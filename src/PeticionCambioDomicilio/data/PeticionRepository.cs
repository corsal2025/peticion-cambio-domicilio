using Microsoft.Data.Sqlite;
using PeticionCambioDomicilio.Domain;

namespace PeticionCambioDomicilio.Data;

/// <summary>SQLite sin ORM (mismo enfoque que LicenciasCarpetas). Un archivo data/peticiones.db.</summary>
public sealed class PeticionRepository
{
    private readonly string _connectionString;

    public PeticionRepository(string dbPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);
        _connectionString = new SqliteConnectionStringBuilder { DataSource = dbPath }.ToString();
        Init();
    }

    private void Init()
    {
        using var cn = Open();
        using var cmd = cn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS Peticion (
                Id                INTEGER PRIMARY KEY AUTOINCREMENT,
                NombreCompleto    TEXT NOT NULL,
                Rut               TEXT NOT NULL,
                Comuna            TEXT NOT NULL,
                Clases            TEXT,
                FechaSolicitud    TEXT,
                Origen            TEXT,
                RutInvalido       INTEGER NOT NULL DEFAULT 0,
                Estado            INTEGER NOT NULL DEFAULT 0,
                DetalleEstado     TEXT,
                CreadaEn          TEXT NOT NULL,
                EnviadaEn         TEXT,
                DestinatariosCorreo TEXT,
                Oficina           TEXT,
                OrdenImportacion  INTEGER NOT NULL DEFAULT 0,
                Marcada           INTEGER NOT NULL DEFAULT 0
            );
            CREATE UNIQUE INDEX IF NOT EXISTS UX_Peticion_Rut_Comuna
                ON Peticion (Rut, Comuna);
            """;
        cmd.ExecuteNonQuery();

        // Bases creadas antes de estas columnas: agregarlas sin perder datos.
        foreach (var (columna, definicion) in new[]
                 {
                     ("Oficina", "TEXT"),
                     ("OrdenImportacion", "INTEGER NOT NULL DEFAULT 0"),
                     ("Marcada", "INTEGER NOT NULL DEFAULT 0"),
                 })
        {
            if (ColumnExists(cn, columna))
            {
                continue;
            }

            using var alter = cn.CreateCommand();
            alter.CommandText = $"ALTER TABLE Peticion ADD COLUMN {columna} {definicion};";
            alter.ExecuteNonQuery();
        }
    }

    private static bool ColumnExists(SqliteConnection cn, string column)
    {
        using var cmd = cn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM pragma_table_info('Peticion') WHERE name = $name;";
        cmd.Parameters.AddWithValue("$name", column);
        return Convert.ToInt64(cmd.ExecuteScalar()) > 0;
    }

    private SqliteConnection Open()
    {
        var cn = new SqliteConnection(_connectionString);
        cn.Open();
        return cn;
    }

    /// <summary>Inserta si no existe (Rut+Comuna). Devuelve true si insertó, false si ya existía.</summary>
    public bool AddIfNew(Peticion p)
    {
        using var cn = Open();
        using var cmd = cn.CreateCommand();
        cmd.CommandText = """
            INSERT OR IGNORE INTO Peticion
                (NombreCompleto, Rut, Comuna, Clases, FechaSolicitud, Origen, Oficina,
                 OrdenImportacion, RutInvalido, Estado, CreadaEn)
            VALUES
                ($nombre, $rut, $comuna, $clases, $fecha, $origen, $oficina,
                 $orden, $rutInvalido, $estado, $creada);
            """;
        cmd.Parameters.AddWithValue("$nombre", p.NombreCompleto);
        cmd.Parameters.AddWithValue("$rut", p.Rut);
        cmd.Parameters.AddWithValue("$comuna", p.Comuna);
        cmd.Parameters.AddWithValue("$clases", (object?)p.Clases ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$fecha", (object?)p.FechaSolicitud?.ToString("yyyy-MM-dd") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$origen", (object?)p.Origen ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$oficina", (object?)p.Oficina ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$orden", p.OrdenImportacion);
        cmd.Parameters.AddWithValue("$rutInvalido", p.RutInvalido ? 1 : 0);
        cmd.Parameters.AddWithValue("$estado", (int)p.Estado);
        cmd.Parameters.AddWithValue("$creada", p.CreadaEn.ToString("o"));
        return cmd.ExecuteNonQuery() > 0;
    }

    public IReadOnlyList<Peticion> All()
    {
        using var cn = Open();
        using var cmd = cn.CreateCommand();
        cmd.CommandText = "SELECT * FROM Peticion ORDER BY OrdenImportacion ASC, Id ASC;";
        using var reader = cmd.ExecuteReader();
        var result = new List<Peticion>();
        while (reader.Read())
        {
            result.Add(Map(reader));
        }

        return result;
    }

    public Peticion? Get(long id)
    {
        using var cn = Open();
        using var cmd = cn.CreateCommand();
        cmd.CommandText = "SELECT * FROM Peticion WHERE Id = $id;";
        cmd.Parameters.AddWithValue("$id", id);
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? Map(reader) : null;
    }

    public void UpdateEstado(long id, EstadoPeticion estado, string? detalle, DateTimeOffset? enviadaEn, string? destinatarios)
    {
        using var cn = Open();
        using var cmd = cn.CreateCommand();
        cmd.CommandText = """
            UPDATE Peticion
               SET Estado = $estado,
                   DetalleEstado = $detalle,
                   EnviadaEn = $enviada,
                   DestinatariosCorreo = $dest
             WHERE Id = $id;
            """;
        cmd.Parameters.AddWithValue("$estado", (int)estado);
        cmd.Parameters.AddWithValue("$detalle", (object?)detalle ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$enviada", (object?)enviadaEn?.ToString("o") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$dest", (object?)destinatarios ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$id", id);
        cmd.ExecuteNonQuery();
    }

    /// <summary>Invierte la marca personal de una fila. Devuelve el valor que quedo.</summary>
    public bool ToggleMarcada(long id)
    {
        using var cn = Open();
        using var cmd = cn.CreateCommand();
        cmd.CommandText = """
            UPDATE Peticion SET Marcada = CASE Marcada WHEN 1 THEN 0 ELSE 1 END WHERE Id = $id;
            SELECT Marcada FROM Peticion WHERE Id = $id;
            """;
        cmd.Parameters.AddWithValue("$id", id);
        var result = cmd.ExecuteScalar();
        return result is not null && Convert.ToInt64(result) == 1;
    }

    public void Delete(long id)
    {
        using var cn = Open();
        using var cmd = cn.CreateCommand();
        cmd.CommandText = "DELETE FROM Peticion WHERE Id = $id;";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.ExecuteNonQuery();
    }

    private static Peticion Map(SqliteDataReader r) => new()
    {
        Id = r.GetInt64(r.GetOrdinal("Id")),
        NombreCompleto = r.GetString(r.GetOrdinal("NombreCompleto")),
        Rut = r.GetString(r.GetOrdinal("Rut")),
        Comuna = r.GetString(r.GetOrdinal("Comuna")),
        Clases = r.IsDBNull(r.GetOrdinal("Clases")) ? null : r.GetString(r.GetOrdinal("Clases")),
        FechaSolicitud = r.IsDBNull(r.GetOrdinal("FechaSolicitud"))
            ? null
            : DateOnly.Parse(r.GetString(r.GetOrdinal("FechaSolicitud"))),
        Origen = r.IsDBNull(r.GetOrdinal("Origen")) ? null : r.GetString(r.GetOrdinal("Origen")),
        Oficina = r.IsDBNull(r.GetOrdinal("Oficina")) ? null : r.GetString(r.GetOrdinal("Oficina")),
        OrdenImportacion = r.GetInt64(r.GetOrdinal("OrdenImportacion")),
        Marcada = r.GetInt32(r.GetOrdinal("Marcada")) == 1,
        RutInvalido = r.GetInt32(r.GetOrdinal("RutInvalido")) == 1,
        Estado = (EstadoPeticion)r.GetInt32(r.GetOrdinal("Estado")),
        DetalleEstado = r.IsDBNull(r.GetOrdinal("DetalleEstado")) ? null : r.GetString(r.GetOrdinal("DetalleEstado")),
        CreadaEn = DateTimeOffset.Parse(r.GetString(r.GetOrdinal("CreadaEn"))),
        EnviadaEn = r.IsDBNull(r.GetOrdinal("EnviadaEn"))
            ? null
            : DateTimeOffset.Parse(r.GetString(r.GetOrdinal("EnviadaEn"))),
        DestinatariosCorreo = r.IsDBNull(r.GetOrdinal("DestinatariosCorreo"))
            ? null
            : r.GetString(r.GetOrdinal("DestinatariosCorreo")),
    };
}
