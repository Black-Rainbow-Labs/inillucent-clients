using Inillucent;

// Runs every scenario in conformance/integration.md against this client.
//
// suite.json grades what a statement does. These scenarios grade the library
// around the statement: opening, closing and reopening a file, a transaction
// object, a prepared statement run many times, a backup, a cancel from another
// thread and a second process writing the same file. Each one runs against a
// real database file in a fresh temporary folder, through the public API, and
// the folder is deleted when the scenario ends.
//
// It is a console program like the conformance runner, so it needs nothing
// restored but this client. Started with the argument "child" it is instead
// the second process of AnotherProcessWritesAndThisOneReadsIt.

/// <summary>The integration runner.</summary>
public static partial class Program
{
    /// <summary>
    /// Runs every scenario, prints a line each, and exits non zero on any failure.
    /// </summary>
    /// <param name="args">empty, or "child" and a database path for the child process</param>
    public static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "child")
        {
            return RunChild(args[1]);
        }
        Console.WriteLine($"{Driver.Version()}  ABI {Driver.AbiVersion()}");
        Console.WriteLine($"driver: {Driver.DriverPath()}");
        Console.WriteLine();

        var scenarios = Scenarios();
        var failed = 0;
        foreach (var (name, body) in scenarios)
        {
            if (!RunScenario(name, body))
            {
                failed++;
            }
        }
        Console.WriteLine();
        Console.WriteLine($"{scenarios.Count - failed} of {scenarios.Count} scenarios pass"
            + (failed > 0 ? $", {failed} FAILED" : ""));
        return failed == 0 ? 0 : 1;
    }

    /// <summary>Returns every scenario in the order integration.md lists them.</summary>
    private static List<(string Name, Action<string> Body)> Scenarios() =>
    [
        (nameof(FileSurvivesCloseAndReopen), FileSurvivesCloseAndReopen),
        (nameof(MissingFileWithoutCreateIsNotFound), MissingFileWithoutCreateIsNotFound),
        (nameof(ReadOnlyOpenReadsAndRefusesWrites), ReadOnlyOpenReadsAndRefusesWrites),
        (nameof(SecondHandleInTheSameProcessSeesCommittedRows),
            SecondHandleInTheSameProcessSeesCommittedRows),
        (nameof(AnotherProcessWritesAndThisOneReadsIt), AnotherProcessWritesAndThisOneReadsIt),
        (nameof(PreparedStatementRunsManyTimesWithFreshBindings),
            PreparedStatementRunsManyTimesWithFreshBindings),
        (nameof(RowsReportCountsColumnsAndLimits), RowsReportCountsColumnsAndLimits),
        (nameof(LastInsertRowidAndTotalChanges), LastInsertRowidAndTotalChanges),
        (nameof(SchemaCookieChangesWhenTheSchemaDoes), SchemaCookieChangesWhenTheSchemaDoes),
        (nameof(ExecuteBatchRunsEveryStatement), ExecuteBatchRunsEveryStatement),
        (nameof(LargeValuesRoundTrip), LargeValuesRoundTrip),
        (nameof(SearchWithBoundParameters), SearchWithBoundParameters),
        (nameof(TransactionCommitsAllOfIt), TransactionCommitsAllOfIt),
        (nameof(TransactionRollsBackWhenAskedAndWhenAbandoned),
            TransactionRollsBackWhenAskedAndWhenAbandoned),
        (nameof(AFailingStatementRollsTheTransactionBack), AFailingStatementRollsTheTransactionBack),
        (nameof(ErrorsCarryStatusOffsetAndMessage), ErrorsCarryStatusOffsetAndMessage),
        (nameof(ClosingRefusesWhileAStatementIsOpen), ClosingRefusesWhileAStatementIsOpen),
        (nameof(UseAfterCloseIsAnErrorNotACrash), UseAfterCloseIsAnErrorNotACrash),
        (nameof(CapabilitiesAndVersions), CapabilitiesAndVersions),
        (nameof(CheckpointIntegrityCheckAndBackup), CheckpointIntegrityCheckAndBackup),
        (nameof(CancelFromAnotherThreadInterruptsAndTheConnectionSurvives),
            CancelFromAnotherThreadInterruptsAndTheConnectionSurvives),
        (nameof(Encryption), Encryption),
        (nameof(TheRestOfThePublicApi), TheRestOfThePublicApi),
    ];

    /// <summary>
    /// Runs one scenario in a fresh temporary folder, deletes the folder, and
    /// prints whether it passed.
    /// </summary>
    /// <param name="name">the scenario name</param>
    /// <param name="body">the scenario, given the folder to work in</param>
    private static bool RunScenario(string name, Action<string> body)
    {
        var directory = Directory.CreateTempSubdirectory("inillucent-cs-integration-").FullName;
        try
        {
            body(directory);
            Console.WriteLine($"  ok    {name}");
            return true;
        }
        catch (Exception failure)
        {
            Console.WriteLine($"  FAIL  {name}");
            Console.WriteLine($"          {failure.GetType().Name}: {failure.Message}");
            return false;
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    /// <summary>Throws with a message unless a condition holds.</summary>
    /// <param name="condition">what must be true</param>
    /// <param name="message">what went wrong when it is not</param>
    private static void Check(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    /// <summary>Throws unless two values are equal, naming both.</summary>
    /// <param name="want">the expected value</param>
    /// <param name="got">the value that came back</param>
    /// <param name="what">what the value is</param>
    private static void Same(object? want, object? got, string what)
    {
        Check(Equals(want, got), $"{what} is {got ?? "null"} and should be {want ?? "null"}");
    }

    /// <summary>
    /// Runs an action that must fail with a status, and returns the failure.
    /// </summary>
    /// <param name="status">the status it must fail with</param>
    /// <param name="action">the call that must fail</param>
    /// <param name="what">what the call was, for the message</param>
    private static InillucentException Refused(Status status, Action action, string what)
    {
        try
        {
            action();
        }
        catch (InillucentException failure)
        {
            Check(failure.Status == status,
                $"{what} failed with {failure.Status.Label()} and should fail with {status.Label()}: "
                + failure.Message);
            return failure;
        }
        throw new InvalidOperationException($"{what} succeeded and should fail with {status.Label()}");
    }

    /// <summary>Returns the number of rows in a table.</summary>
    /// <param name="connection">the connection to ask</param>
    /// <param name="table">the table to count</param>
    private static long Count(Connection connection, string table) =>
        (long)connection.Scalar($"SELECT count(*) FROM {table}")!;

    /// <summary>
    /// The child process: opens the file, inserts one row, closes and exits 0.
    /// </summary>
    /// <param name="path">the database file the parent holds open</param>
    private static int RunChild(string path)
    {
        var told = Environment.GetEnvironmentVariable("INILLUCENT_DRIVER_LIB");
        if (!string.Equals(Path.GetFullPath(told ?? "."), Driver.DriverPath(), StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine($"the child loaded {Driver.DriverPath()} and was told {told}");
            return 2;
        }
        using var database = Database.Open(path);
        using var connection = database.Connect();
        connection.Execute("INSERT INTO t (v) VALUES (?1)", ["from the child"]);
        return 0;
    }
}
