using System.Diagnostics;
using Inillucent;

/// <summary>The scenarios about opening, closing and sharing a database file.</summary>
public static partial class Program
{
    /// <summary>
    /// Writes two rows, closes, reopens the same path and reads both rows back.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void FileSurvivesCloseAndReopen(string directory)
    {
        var path = Path.Combine(directory, "kept.rdb");
        using (var database = Database.Open(path))
        using (var connection = database.Connect())
        {
            connection.Execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
            connection.Execute("INSERT INTO t VALUES (?1, ?2)", [1L, "one"]);
            connection.Execute("INSERT INTO t VALUES (?1, ?2)", [2L, "two"]);
        }
        using (var database = Database.Open(path))
        using (var connection = database.Connect())
        {
            Same(Path.GetFullPath(path), Path.GetFullPath(database.Path), "the database path");
            var rows = connection.Execute("SELECT id, v FROM t ORDER BY id");
            Same(2, rows.Count, "the row count after reopening");
            Same(1L, rows[0][0], "the first id");
            Same("one", rows[0][1], "the first value");
            Same(2L, rows[1][0], "the second id");
            Same("two", rows[1][1], "the second value");
        }
    }

    /// <summary>
    /// Opening a missing path with create turned off fails as not_found and
    /// leaves no file behind.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void MissingFileWithoutCreateIsNotFound(string directory)
    {
        var path = Path.Combine(directory, "absent.rdb");
        Refused(Status.NotFound, () => Database.Open(path, new OpenOptions { Create = false }).Dispose(),
            "opening a missing file without create");
        Check(!File.Exists(path), "opening without create made a file at the path");
    }

    /// <summary>
    /// A read only open answers a SELECT and refuses an INSERT as readonly.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void ReadOnlyOpenReadsAndRefusesWrites(string directory)
    {
        var path = Path.Combine(directory, "read-only.rdb");
        using (var database = Database.Open(path))
        using (var connection = database.Connect())
        {
            connection.ExecuteBatch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a'); INSERT INTO t VALUES ('b')");
        }
        using (var database = Database.Open(path, new OpenOptions { ReadOnly = true, Create = false }))
        using (var connection = database.Connect())
        {
            Same(2, connection.Query("SELECT v FROM t").Count, "the rows read through a read only open");
            Refused(Status.ReadOnly, () => connection.Execute("INSERT INTO t VALUES ('c')"),
                "an INSERT on a read only open");
            Same(2L, Count(connection, "t"), "the row count after the refused INSERT");
        }
    }

    /// <summary>
    /// Two handles on one file in one process: a row written through the first
    /// is read through the second.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void SecondHandleInTheSameProcessSeesCommittedRows(string directory)
    {
        var path = Path.Combine(directory, "shared.rdb");
        using var first = Database.Open(path);
        using var writer = first.Connect();
        writer.Execute("CREATE TABLE t (v TEXT)");
        using var second = Database.Open(path);
        using var reader = second.Connect();
        // On inillucent 1.0.33 a database that was just opened holds a read lock
        // on the file until a statement runs on it, even with no connection made,
        // so a write through the first handle at this point waits out
        // busy_timeout and fails with Status.Busy. The second handle therefore
        // reads once first, which also shows it seeing the table empty.
        Same(0L, Count(reader, "t"), "the rows the second handle sees before the insert");
        writer.Execute("INSERT INTO t VALUES (?1)", ["seen"]);
        Same("seen", reader.Scalar("SELECT v FROM t"), "the row read through the second handle");
    }

    /// <summary>
    /// A child process writes a row into a file this process holds open, and
    /// this process reads it without reopening.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void AnotherProcessWritesAndThisOneReadsIt(string directory)
    {
        var path = Path.Combine(directory, "two-processes.rdb");
        using var database = Database.Open(path);
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

        var start = new ProcessStartInfo(Environment.ProcessPath!)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add("child");
        start.ArgumentList.Add(path);
        // The child finds the same library through INILLUCENT_DRIVER_LIB, the
        // first place every client looks, so that lookup is exercised too.
        start.Environment["INILLUCENT_DRIVER_LIB"] = Driver.DriverPath();
        start.Environment.Remove("INILLUCENT_REPOSITORY");
        using var child = Process.Start(start)!;
        var said = child.StandardOutput.ReadToEnd() + child.StandardError.ReadToEnd();
        child.WaitForExit();
        Check(child.ExitCode == 0, $"the child process exited {child.ExitCode}: {said}");
        Same("from the child", connection.Scalar("SELECT v FROM t"), "the row the child wrote");
    }
}
