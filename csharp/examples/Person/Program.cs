// Create a person table, insert rows, read them by column name, and update one.
//
// Run it with `dotnet run` from this folder.

using Inillucent;

var directory = Path.Combine(Path.GetTempPath(), $"person-cs-{Environment.ProcessId}");
Directory.CreateDirectory(directory);
var path = Path.Combine(directory, "person.rdb");

try
{
    using var database = Database.Open(path);
    using var connection = database.Connect();

    connection.Execute("""
        CREATE TABLE person (
          id         INTEGER PRIMARY KEY,
          first_name TEXT NOT NULL,
          last_name  TEXT NOT NULL,
          email      TEXT,
          age        INTEGER,
          height_m   REAL
        )
        """);

    // Insert. Values go in as ?1, ?2 and so on, never pasted into the text.
    const string insert =
        "INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)";
    connection.Execute(insert, ["Ada", "Lovelace", "ada@example.com", 36, 1.65]);
    connection.Execute(insert, ["Grace", "Hopper", null, 85, 1.57]);

    // Read. Query gives a dictionary per row, keyed by column name.
    foreach (var person in connection.Query(
        "SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id"))
    {
        Console.WriteLine($"{person["id"]} {person["first_name"]} {person["last_name"]} " +
                          $"{person["email"]} {person["age"]} {person["height_m"]}");
    }

    // One value.
    Console.WriteLine($"people: {connection.Scalar("SELECT COUNT(*) FROM person")}");

    // Update, and read the row back.
    var changed = connection.Execute(
        "UPDATE person SET email = ?1 WHERE last_name = ?2", ["grace@example.com", "Hopper"]);
    Console.WriteLine($"updated: {changed.Affected}");
    Console.WriteLine("email now: " +
        connection.Scalar("SELECT email FROM person WHERE last_name = ?1", ["Hopper"]));
}
finally
{
    foreach (var file in Directory.GetFiles(directory))
    {
        File.Delete(file);
    }
    Directory.Delete(directory);
}
