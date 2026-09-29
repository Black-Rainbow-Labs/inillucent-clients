using System.Text.Json;
using Inillucent;

// Runs conformance/suite.json against this client.
//
// The suite is the driver's behaviour written as data rather than as prose, and
// every client library in this repository runs the same file. When two of them
// disagree, one of them is wrong; when they agree, the specification is one that
// can actually be followed.
//
// It is a console program rather than a test framework so that running the suite
// needs nothing restored but this client.

/// <summary>The conformance runner.</summary>
public static class Program
{
    /// <summary>
    /// Runs every case, prints a line each, and exits non zero on any failure.
    /// </summary>
    /// <param name="args">unused</param>
    public static int Main(string[] args)
    {
        var suitePath = SuitePath();
        Console.WriteLine($"{Driver.Version()}  ABI {Driver.AbiVersion()}");
        Console.WriteLine($"driver: {Driver.DriverPath()}");
        Console.WriteLine($"suite:  {suitePath}");
        Console.WriteLine();

        using var suite = JsonDocument.Parse(File.ReadAllText(suitePath));
        var failures = new List<string>();
        var cases = suite.RootElement.GetProperty("cases");
        var ran = 0;

        foreach (var theCase in cases.EnumerateArray())
        {
            var name = theCase.TryGetProperty("name", out var named)
                ? named.GetString() ?? "(unnamed)"
                : "(unnamed)";
            var lacking = Lacking(theCase);
            if (lacking.Count > 0)
            {
                Console.WriteLine($"  skip  {name} (this runner lacks {string.Join(", ", lacking)})");
                continue;
            }
            ran++;
            var wrong = RunCase(theCase, name);
            Console.WriteLine($"  {(wrong.Count == 0 ? "ok  " : "FAIL")}  {name}");
            foreach (var problem in wrong)
            {
                Console.WriteLine($"          {problem}");
                failures.Add($"{name}: {problem}");
            }
        }

        failures.AddRange(CheckCapabilityTable());
        failures.AddRange(CheckEncryptedDatabase());

        Console.WriteLine();
        Console.WriteLine($"{ran} of {cases.GetArrayLength()} cases, {failures.Count} failures");
        return failures.Count == 0 ? 0 : 1;
    }

    /// <summary>
    /// The capabilities this runner has, out of the suite's `capabilities` list.
    ///
    /// It holds one real connection for a whole case, so a transaction, a
    /// savepoint or a temporary table lasts from one step to the next.
    /// </summary>
    private static readonly HashSet<string> Has = ["session"];

    /// <summary>
    /// Returns the capabilities a case needs that this runner does not have.
    /// An empty list means the case runs.
    /// </summary>
    /// <param name="theCase">one entry from the suite's cases</param>
    private static List<string> Lacking(JsonElement theCase)
    {
        if (!theCase.TryGetProperty("needs", out var needs))
        {
            return [];
        }
        return needs.EnumerateArray()
            .Select(need => need.GetString() ?? "")
            .Where(need => !Has.Contains(need))
            .ToList();
    }

    /// <summary>
    /// Checks that an encrypted database keeps its text off disk, reads back with
    /// its key, reports its cipher, and refuses no key and a different key as
    /// corrupt.
    /// </summary>
    private static List<string> CheckEncryptedDatabase()
    {
        var wrong = new List<string>();
        var directory = Directory.CreateTempSubdirectory("inillucent-cs-encrypted-").FullName;
        var path = Path.Combine(directory, "encrypted.rdb");
        var key = "x'" + string.Concat(Enumerable.Repeat("5a", 32)) + "'";
        var otherKey = "x'" + string.Concat(Enumerable.Repeat("6b", 32)) + "'";
        const string secret = "the vault code is 7461";
        try
        {
            using (var database = Database.Open(path, new OpenOptions { Key = key }))
            using (var connection = database.Connect())
            {
                connection.Execute("CREATE TABLE vault (note TEXT)");
                connection.Execute("INSERT INTO vault (note) VALUES (?1)", new object?[] { secret });
            }
            foreach (var file in Directory.GetFiles(directory))
            {
                var text = System.Text.Encoding.Latin1.GetString(File.ReadAllBytes(file));
                if (text.Contains(secret))
                {
                    wrong.Add($"encrypted: the plaintext appears in {Path.GetFileName(file)}");
                }
            }
            using (var database = Database.Open(path, new OpenOptions { Key = key }))
            using (var connection = database.Connect())
            {
                var note = connection.Scalar("SELECT note FROM vault");
                if (!secret.Equals(note))
                {
                    wrong.Add($"encrypted: the row read back as {note}");
                }
                var mode = connection.Scalar("PRAGMA encryption");
                if (!"xchacha20-poly1305".Equals(mode))
                {
                    wrong.Add($"encrypted: PRAGMA encryption answered {mode}");
                }
            }
            wrong.AddRange(ExpectCorrupt(path, null, "opening without a key"));
            wrong.AddRange(ExpectCorrupt(path, otherKey, "opening with a different key"));
        }
        finally
        {
            foreach (var file in Directory.GetFiles(directory))
            {
                File.Delete(file);
            }
            Directory.Delete(directory);
        }
        Console.WriteLine($"  {(wrong.Count == 0 ? "ok  " : "FAIL")}  encrypted database");
        foreach (var problem in wrong)
        {
            Console.WriteLine($"          {problem}");
        }
        return wrong;
    }

    /// <summary>
    /// Returns a problem line unless opening the database failed with Status.Corrupt.
    /// </summary>
    /// <param name="path">the database file</param>
    /// <param name="key">the key to try, or null for none</param>
    /// <param name="what">says which attempt this was</param>
    private static List<string> ExpectCorrupt(string path, string? key, string what)
    {
        try
        {
            using var database = Database.Open(path, new OpenOptions { Key = key });
            return [$"encrypted: {what} must fail, and it opened"];
        }
        catch (InillucentException failure)
        {
            return failure.Status == Status.Corrupt
                ? []
                : [$"encrypted: {what} failed as {failure.Status} and must fail as corrupt"];
        }
    }

    /// <summary>
    /// Returns the path of the shared conformance suite, or the file named by
    /// INILLUCENT_SUITE when that is set, so a changed copy can be run without
    /// touching the real one.
    /// </summary>
    private static string SuitePath()
    {
        var chosen = Environment.GetEnvironmentVariable("INILLUCENT_SUITE");
        if (!string.IsNullOrEmpty(chosen))
        {
            return Path.GetFullPath(chosen);
        }
        var repository = Environment.GetEnvironmentVariable("INILLUCENT_REPOSITORY");
        var root = string.IsNullOrEmpty(repository)
            ? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."))
            : Path.GetFullPath(repository);
        return Path.Combine(root, "conformance", "suite.json");
    }

    /// <summary>
    /// Reads a value out of the suite's one key object form.
    ///
    /// One key rather than a bare literal, so that NULL and the empty string can
    /// never be confused by the file itself.
    /// </summary>
    /// <param name="described">a value object such as {"int": 7}</param>
    private static object? ValueOf(JsonElement described)
    {
        if (described.TryGetProperty("null", out _))
        {
            return null;
        }
        if (described.TryGetProperty("int", out var whole))
        {
            return whole.GetInt64();
        }
        if (described.TryGetProperty("real", out var number))
        {
            return number.GetDouble();
        }
        if (described.TryGetProperty("text", out var text))
        {
            return text.GetString();
        }
        if (described.TryGetProperty("blob", out var blob))
        {
            return blob.EnumerateArray().Select(byteValue => (byte)byteValue.GetInt32()).ToArray();
        }
        throw new ArgumentException($"{described} names no value kind");
    }

    /// <summary>
    /// Compares an expected value to what came back.
    ///
    /// The kinds have to match as well as the contents: an integer and a real are
    /// different values, and a comparison that let 1 equal 1.0 would hide a
    /// client that lost the distinction.
    /// </summary>
    private static bool Same(object? want, object? got)
    {
        if (want is null || got is null)
        {
            return want is null && got is null;
        }
        if (want is byte[] || got is byte[])
        {
            return want is byte[] wantBytes && got is byte[] gotBytes
                && wantBytes.AsSpan().SequenceEqual(gotBytes);
        }
        return want.GetType() == got.GetType() && want.Equals(got);
    }

    /// <summary>Renders a value for a failure message.</summary>
    private static string Shown(object? value) => value switch
    {
        null => "NULL",
        byte[] bytes => $"{bytes.Length} bytes [{string.Join(",", bytes)}]",
        _ => $"{value.GetType().Name}({value})",
    };

    /// <summary>Checks the rows a successful step handed back.</summary>
    private static void CheckRows(JsonElement step, Rows rows, List<string> wrong)
    {
        var want = step.GetProperty("rows");
        if (want.GetArrayLength() != rows.Count)
        {
            wrong.Add($"there are {rows.Count} rows and there should be {want.GetArrayLength()}");
            return;
        }
        var nth = 0;
        foreach (var row in want.EnumerateArray())
        {
            var got = rows[nth];
            if (row.GetArrayLength() != got.Count)
            {
                wrong.Add($"row {nth} has {got.Count} cells and should have {row.GetArrayLength()}");
                nth++;
                continue;
            }
            var column = 0;
            foreach (var cell in row.EnumerateArray())
            {
                var expected = ValueOf(cell);
                if (!Same(expected, got[column]))
                {
                    wrong.Add($"row {nth} column {column} is {Shown(got[column])} and should be "
                        + Shown(expected));
                }
                column++;
            }
            nth++;
        }
    }

    /// <summary>Checks a step that was expected to succeed.</summary>
    private static void CheckSuccess(JsonElement step, Rows rows, List<string> wrong)
    {
        if (step.TryGetProperty("status", out var status))
        {
            wrong.Add($"expected it to fail with `{status.GetString()}` and it succeeded");
            return;
        }
        if (step.TryGetProperty("columns", out var columns))
        {
            var want = columns.EnumerateArray().Select(name => name.GetString()).ToList();
            if (!want.SequenceEqual(rows.Columns))
            {
                wrong.Add($"columns are [{string.Join(", ", rows.Columns)}] and should be "
                    + $"[{string.Join(", ", want)}]");
            }
        }
        if (step.TryGetProperty("rows", out _))
        {
            CheckRows(step, rows, wrong);
        }
        if (step.TryGetProperty("affected", out var affected))
        {
            long? want = affected.ValueKind == JsonValueKind.Null ? null : affected.GetInt64();
            if (rows.Affected != want)
            {
                wrong.Add($"affected is {rows.Affected?.ToString() ?? "absent"} and should be "
                    + (want?.ToString() ?? "absent"));
            }
        }
        if (step.TryGetProperty("total", out var total) && rows.Total != total.GetInt64())
        {
            wrong.Add($"total is {rows.Total} and should be {total.GetInt64()}, and total is exact,"
                + " so this is a real disagreement rather than an estimate being off");
        }
        if (step.TryGetProperty("more", out var more) && rows.More != more.GetBoolean())
        {
            wrong.Add($"more is {rows.More} and should be {more.GetBoolean()}");
        }
    }

    /// <summary>Checks a step that was expected to fail.</summary>
    private static void CheckFailure(JsonElement step, InillucentException failure,
                                     List<string> wrong)
    {
        if (!step.TryGetProperty("status", out var status))
        {
            wrong.Add($"it was expected to succeed and it failed: {failure.Message}");
            return;
        }
        var want = status.GetString();
        if (failure.Status.Label() != want)
        {
            wrong.Add($"it failed with `{failure.Status.Label()}` and should have failed with "
                + $"`{want}`, saying: {failure.Message}");
        }
        if (step.TryGetProperty("message_contains", out var holds)
            && !failure.PlainMessage.Contains(holds.GetString()!, StringComparison.Ordinal))
        {
            wrong.Add($"the message is \"{failure.PlainMessage}\" and should hold "
                + $"\"{holds.GetString()}\"");
        }
        if (step.TryGetProperty("feature_contains", out var feature))
        {
            if (failure.Feature is null)
            {
                wrong.Add("it named no construct, and an unsupported refusal has to name one or an"
                    + " application cannot say what it hit");
            }
            else if (!failure.Feature.Contains(feature.GetString()!, StringComparison.Ordinal))
            {
                wrong.Add($"it named \"{failure.Feature}\" and should have named something holding"
                    + $" \"{feature.GetString()}\"");
            }
        }
        if (failure.Status == Status.Unsupported)
        {
            if (failure is not UnsupportedFeatureException)
            {
                wrong.Add("an unsupported refusal did not arrive as UnsupportedFeatureException,"
                    + " which is the whole of this design arriving in .NET");
            }
            if (failure.Feature is null)
            {
                wrong.Add("an unsupported refusal must carry a feature");
            }
        }
    }

    /// <summary>
    /// Runs one case and returns one line per disagreement.
    /// </summary>
    /// <param name="theCase">one entry from the suite's cases</param>
    /// <param name="name">the case name, used for the scratch file</param>
    private static List<string> RunCase(JsonElement theCase, string name)
    {
        var directory = Path.Combine(Path.GetTempPath(),
            $"inillucent-cs-{name}-{Environment.ProcessId}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "case.rdb");
        var wrong = new List<string>();

        try
        {
            using var database = Database.Open(path);
            using var connection = database.Connect();

            if (theCase.TryGetProperty("setup", out var setup))
            {
                foreach (var statement in setup.EnumerateArray())
                {
                    try
                    {
                        connection.Execute(statement.GetString()!);
                    }
                    catch (InillucentException why)
                    {
                        wrong.Add($"the setup statement `{statement.GetString()}` was refused: "
                            + why.Message);
                    }
                }
            }
            if (wrong.Count == 0 && theCase.TryGetProperty("steps", out var steps))
            {
                foreach (var step in steps.EnumerateArray())
                {
                    wrong.AddRange(RunStep(connection, step));
                }
            }
        }
        finally
        {
            // The whole folder goes, including the engine's .rdb-wal files and
            // anything else it wrote beside the database.
            Directory.Delete(directory, true);
        }
        return wrong;
    }

    /// <summary>
    /// Runs one step and returns one line per disagreement, each naming the SQL.
    /// </summary>
    /// <param name="connection">the connection the case is running on</param>
    /// <param name="step">the step, which asserts only the keys it carries</param>
    private static List<string> RunStep(Connection connection, JsonElement step)
    {
        var sql = step.GetProperty("sql").GetString()!;
        var parameters = new List<object?>();
        if (step.TryGetProperty("params", out var described))
        {
            parameters.AddRange(described.EnumerateArray().Select(ValueOf));
        }
        long? limit = step.TryGetProperty("limit", out var capped) ? capped.GetInt64() : null;

        var said = new List<string>();
        try
        {
            CheckSuccess(step, connection.Execute(sql, parameters, limit), said);
        }
        catch (InillucentException failure)
        {
            CheckFailure(step, failure, said);
        }
        return said.Select(problem => $"`{sql}`: {problem}").ToList();
    }

    /// <summary>
    /// Checks the capability table, which is the other half of the surface.
    ///
    /// Reading it here also proves the C strings it hands back survive being
    /// copied out, which is the rule a binding is most likely to get wrong.
    /// </summary>
    private static List<string> CheckCapabilityTable()
    {
        var wrong = new List<string>();
        var rows = Driver.Capabilities();
        Console.WriteLine();
        Console.WriteLine($"{rows.Count} capabilities reported");
        if (rows.Count == 0)
        {
            wrong.Add("the engine declares no capabilities at all");
        }
        foreach (var row in rows)
        {
            if (row.Name.Length == 0)
            {
                wrong.Add("a capability came back with no name");
            }
            if (row.Support == Support.No)
            {
                Console.WriteLine($"  not supported: {row.Name}");
            }
        }
        if (Driver.Supports("cancel") != Support.Partial)
        {
            wrong.Add("cancel is partial: a running statement stops at the next point the executor"
                + $" checks, and the engine answered {Driver.Supports("cancel")}");
        }
        if (Driver.Supports("encryption") != Support.Yes)
        {
            wrong.Add("the engine declares encryption at rest as supported, and it answered"
                + $" {Driver.Supports("encryption")}");
        }
        if (Driver.Supports("time_travel") != Support.Unknown)
        {
            wrong.Add("a capability nobody declared must answer unknown rather than no: they mean"
                + " different things, and one of them is a checked absence");
        }
        return wrong;
    }
}
