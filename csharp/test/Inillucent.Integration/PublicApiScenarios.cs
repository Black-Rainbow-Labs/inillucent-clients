using Inillucent;

/// <summary>
/// The parts of the public API that no scenario in integration.md reaches, so
/// that every public method is called by at least one test.
/// </summary>
public static partial class Program
{
    /// <summary>
    /// Binds every .NET type the client accepts, refuses one it does not, and
    /// reads the capability, status and diagnostic helpers.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void TheRestOfThePublicApi(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "rest.rdb"), new OpenOptions { Diagnostics = true });
        using var connection = database.Connect();
        Check(ReferenceEquals(database, connection.Database), "the connection names another database");
        CheckEveryBoundType(connection);
        CheckQueryAndScalar(connection);
        CheckCapabilityHelpers();
        Same("not_found", Status.NotFound.Label(), "the label of not_found");
        Same("status 99", ((Status)99).Label(), "the label of a status nobody declared");
    }

    /// <summary>
    /// Binds each .NET type the client maps to an engine value and reads back
    /// the kind the engine stored.
    /// </summary>
    /// <param name="connection">the connection to use</param>
    private static void CheckEveryBoundType(Connection connection)
    {
        using var kind = connection.Prepare("SELECT typeof(?1), ?1");
        var expected = new (object? Value, string Kind, object? Back)[]
        {
            (null, "null", null),
            (true, "integer", 1L),
            ((byte)7, "integer", 7L),
            ((short)-7, "integer", -7L),
            (7, "integer", 7L),
            (7u, "integer", 7L),
            (1.5f, "real", 1.5),
            (2.5, "real", 2.5),
            (3.5m, "real", 3.5),
            ("", "text", ""),
            (Array.Empty<byte>(), "blob", null),
        };
        foreach (var (value, name, back) in expected)
        {
            var row = kind.Execute([value])[0];
            Same(name, row[0], $"typeof a bound {value?.GetType().Name ?? "null"}");
            if (back is not null || value is null)
            {
                Same(back, row[1], $"a bound {value?.GetType().Name ?? "null"} read back");
            }
        }
        Check(kind.Execute([Array.Empty<byte>()])[0][1] is byte[] { Length: 0 }, "an empty blob read back as something else");
        // The engine refuses a position of 0 and a position past the statement's
        // parameters with invalid_state. The client used to ignore that status.
        Refused(Status.InvalidState, () => kind.Bind(0, 1L), "binding position 0");
        Refused(Status.InvalidState, () => kind.Bind(2, 1L), "binding past the last parameter");
        try
        {
            kind.Bind(1, DateTime.UnixEpoch);
            throw new InvalidOperationException("binding a DateTime succeeded");
        }
        catch (ArgumentException)
        {
        }
    }

    /// <summary>
    /// Reads rows through Query and Scalar with bound values, and a result's
    /// empty cases.
    /// </summary>
    /// <param name="connection">the connection to use</param>
    private static void CheckQueryAndScalar(Connection connection)
    {
        connection.Execute("CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT)");
        connection.Execute("INSERT INTO person VALUES (?1, ?2)", [1L, "Ada"]);
        var people = connection.Query("SELECT id, name FROM person WHERE id = ?1", [1L]);
        Same("Ada", people[0]["name"], "the name read through Query");
        Same("Ada", connection.Scalar("SELECT name FROM person WHERE id = ?1", [1L]), "the name read through Scalar");
        var none = connection.Execute("SELECT id FROM person WHERE id = 2");
        Same(null, none.One(), "One on an empty result");
        Same(null, none.Scalar(), "Scalar on an empty result");
        Same(null, none.Get(0, "id"), "Get past the last row");
        Same(-1, none.ColumnIndex("name"), "ColumnIndex of a column the result does not have");
        System.Collections.IEnumerable untyped = none;
        Check(!untyped.GetEnumerator().MoveNext(), "an empty result walked a row");
    }

    /// <summary>Reads the helpers on a capability row.</summary>
    private static void CheckCapabilityHelpers()
    {
        var byName = Driver.Capabilities().ToDictionary(row => row.Name);
        Same("partial", byName["cancel"].SupportName, "the support name of cancel");
        Check(byName["cancel"].IsSupported, "cancel is partial and counts as supported");
        Same("yes", byName["encryption"].SupportName, "the support name of encryption");
        Same("no", byName["load_extension"].SupportName, "the support name of load_extension");
        Check(!byName["load_extension"].IsSupported, "load_extension counts as supported");
        Check(byName["cancel"].Note.Length > 0, "cancel has no note");
        Same("unknown", new Capability("made up", Support.Unknown, "").SupportName, "the support name of unknown");
    }
}
