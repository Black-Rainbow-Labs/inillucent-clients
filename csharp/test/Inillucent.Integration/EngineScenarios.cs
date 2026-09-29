using System.Diagnostics;
using System.Text;
using Inillucent;

/// <summary>The scenarios about the engine itself, and the rest of the public API.</summary>
public static partial class Program
{
    /// <summary>
    /// The capability table has named entries, four capabilities answer what the
    /// engine declares, and the versions are the ones this client needs.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder, unused</param>
    private static void CapabilitiesAndVersions(string directory)
    {
        var capabilities = Driver.Capabilities();
        Check(capabilities.Count > 0, "the capability list is empty");
        Check(capabilities.All(row => row.Name.Length > 0), "a capability has no name");
        Same(Support.Partial, Driver.Supports("cancel"), "supports(cancel)");
        Same(Support.Yes, Driver.Supports("encryption"), "supports(encryption)");
        Same(Support.No, Driver.Supports("load_extension"), "supports(load_extension)");
        Same(Support.Unknown, Driver.Supports("a_capability_nobody_declared"), "supports(a made up name)");
        Check(Driver.Version().Contains("1.0."), $"the version is {Driver.Version()}");
        var abi = Driver.AbiVersion().Split('.').Select(int.Parse).ToArray();
        Check(abi[0] > 1 || (abi[0] == 1 && abi[1] >= 1), $"the ABI version is {Driver.AbiVersion()}");
        Check(File.Exists(Driver.DriverPath()), $"the driver path {Driver.DriverPath()} is not a file");
    }

    /// <summary>
    /// Checkpoint and integrity check succeed, a backup opens with the same
    /// rows, and a second backup to the same path succeeds.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void CheckpointIntegrityCheckAndBackup(string directory)
    {
        var copy = Path.Combine(directory, "copy.rdb");
        using (var database = Database.Open(Path.Combine(directory, "original.rdb")))
        using (var connection = database.Connect())
        {
            connection.ExecuteBatch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)");
            database.Checkpoint();
            database.IntegrityCheck();
            database.BackupTo(copy);
            connection.Execute("INSERT INTO t VALUES (3)");
            database.BackupTo(copy);
        }
        using var restored = Database.Open(copy, new OpenOptions { Create = false });
        using var reader = restored.Connect();
        Same(6L, reader.Scalar("SELECT sum(v) FROM t"), "the sum of the rows in the backup");
        restored.IntegrityCheck();
    }

    /// <summary>
    /// A cancel from another thread stops a long statement as interrupted and
    /// the connection keeps working; a cancel with nothing running cancels
    /// nothing.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void CancelFromAnotherThreadInterruptsAndTheConnectionSurvives(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "cancel.rdb"));
        using var connection = database.Connect();
        const string slow = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000000) "
            + "SELECT count(*) FROM n";
        Exception? outcome = null;
        var clock = Stopwatch.StartNew();
        var running = new Thread(() =>
        {
            try
            {
                connection.Execute(slow);
            }
            catch (Exception failure)
            {
                outcome = failure;
            }
        });
        running.Start();
        Thread.Sleep(100);
        connection.Cancel();
        running.Join();
        Check(outcome is InillucentException { Status: Status.Interrupted },
            $"the cancelled statement ended with {outcome?.Message ?? "success"} after {clock.ElapsedMilliseconds} ms");
        Same(1L, connection.Scalar("SELECT 1"), "the statement after the cancel");

        connection.Cancel();
        Same(2L, connection.Scalar("SELECT 2"), "the statement after a cancel with nothing running");
    }

    /// <summary>
    /// An encrypted file holds no plaintext, reads back with its key, reports its
    /// cipher, and refuses no key and a wrong key as corrupt.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void Encryption(string directory)
    {
        var path = Path.Combine(directory, "vault.rdb");
        var key = "x'" + string.Concat(Enumerable.Repeat("5a", 32)) + "'";
        const string secret = "the vault code is 7461";
        using (var database = Database.Open(path, new OpenOptions { Key = key }))
        using (var connection = database.Connect())
        {
            connection.Execute("CREATE TABLE vault (note TEXT)");
            connection.Execute("INSERT INTO vault (note) VALUES (?1)", [secret]);
        }
        foreach (var file in Directory.GetFiles(directory))
        {
            Check(!Encoding.Latin1.GetString(File.ReadAllBytes(file)).Contains(secret),
                $"the plaintext appears in {Path.GetFileName(file)}");
        }
        using (var database = Database.Open(path, new OpenOptions { Key = key }))
        using (var connection = database.Connect())
        {
            Same(secret, connection.Scalar("SELECT note FROM vault"), "the row read back with the key");
            Same("xchacha20-poly1305", connection.Scalar("PRAGMA encryption"), "PRAGMA encryption");
        }
        Refused(Status.Corrupt, () => Database.Open(path).Dispose(), "opening without the key");
        Refused(Status.Corrupt, () => Database.Open(path, new OpenOptions { Key = "a different passphrase" }).Dispose(),
            "opening with a different key");
    }
}
