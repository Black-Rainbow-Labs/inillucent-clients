// A first program: create a table, write rows, read them back, and ask the
// engine what it can do before composing anything unusual.
//
// Run it with `dotnet run` from this folder.

using Inillucent;

var directory = Path.Combine(Path.GetTempPath(), $"inillucent-quickstart-{Environment.ProcessId}");
Directory.CreateDirectory(directory);
var path = Path.Combine(directory, "library.rdb");

try
{
    using var database = Database.Open(path);
    using var connection = database.Connect();

    Console.WriteLine(Driver.Version());

    connection.Execute("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)");
    connection.Execute("INSERT INTO authors VALUES (?1, ?2, ?3)", [1, "Octavia Butler", 4.8]);
    connection.Execute("INSERT INTO authors VALUES (?1, ?2, ?3)", [2, "Ursula Le Guin", null]);

    foreach (var author in connection.Query("SELECT id, name, rating FROM authors ORDER BY id"))
    {
        Console.WriteLine($"{author["id"]} {author["name"]} {author["rating"]}");
    }

    // The limit caps what is handed back; the total was counted, not estimated.
    var page = connection.Execute("SELECT id, name FROM authors ORDER BY id", null, 1);
    Console.WriteLine($"showing {page.Count} of {page.Total}{(page.More ? ", more to come" : "")}");

    // A transaction is a handle, so what a write did can be checked before commit.
    using (var transaction = connection.Begin())
    {
        if (transaction.Execute("INSERT INTO authors VALUES (3, 'Ted Chiang', 4.9)") == 1)
        {
            transaction.Commit();
        }
    }

    Console.WriteLine($"authors: {connection.Scalar("SELECT COUNT(*) FROM authors")}");
    Console.WriteLine($"cancel supported: {Driver.Supports("cancel") == Support.Yes}");

    try
    {
        connection.Cancel();
    }
    catch (UnsupportedFeatureException why)
    {
        Console.WriteLine($"cancel refused, and it named: {why.Feature}");
    }
}
finally
{
    foreach (var file in Directory.GetFiles(directory))
    {
        File.Delete(file);
    }
    Directory.Delete(directory);
}
