# inillucent, from C#

The [inillucent](https://github.com/Black-Rainbow-Labs/Inillucent) embedded database, in your process,
through `DllImport`.

Targets **.NET 8** and runs on anything newer. No dependencies.

## Install

```sh
dotnet add package Inillucent.Client
```

You also need the shared library. See [the shared library](../README.md#the-shared-library).

The library path is decided at runtime rather than baked into the attributes:
`NativeLibrary.SetDllImportResolver` points every import at whatever file the shared search order
found, so the `DllImport` declarations stay ordinary and the file can live anywhere.

## A first program

Create a table, insert rows, read them back, and update one.
[`examples/Person`](examples/Person) is this program and it runs.

```csharp
using Inillucent;

using var database = Database.Open("app.rdb");
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

const string insert =
    "INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)";
connection.Execute(insert, ["Ada", "Lovelace", "ada@example.com", 36, 1.65]);
connection.Execute(insert, ["Grace", "Hopper", null, 85, 1.57]);

foreach (var person in connection.Query(
    "SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id"))
{
    Console.WriteLine($"{person["id"]} {person["first_name"]} {person["last_name"]} " +
                      $"{person["email"]} {person["age"]} {person["height_m"]}");
}

Console.WriteLine($"people: {connection.Scalar("SELECT COUNT(*) FROM person")}");

var changed = connection.Execute(
    "UPDATE person SET email = ?1 WHERE last_name = ?2", ["grace@example.com", "Hopper"]);
Console.WriteLine($"updated: {changed.Affected}");
```

```
1 Ada Lovelace ada@example.com 36 1.65
2 Grace Hopper  85 1.57
people: 2
updated: 1
email now: grace@example.com
```

A NULL prints as nothing on that second line because `Console.WriteLine` renders a null as an empty
string. In the result it is a `null`, not `""`.

Both `Database` and `Connection` are `IDisposable`. Disposing the database disposes every connection
on it first, because the C library refuses to close a database that still has connections open.

## Reading rows

`Query` gives a `Dictionary<string, object?>` per row, keyed by column name. That is what you want
most of the time.

```csharp
var people = connection.Query("SELECT first_name, last_name, email FROM person ORDER BY id");

people[0]["first_name"];   // "Ada"
people[0]["last_name"];    // "Lovelace"
people[1]["email"];        // null - the column is NULL, and null is not ""

// Read one out as the type it is.
var first = (string?) people[0]["first_name"];
var age = (long?) people[0]["age"];
```

`Scalar` gives the first column of the first row, for a COUNT, a MAX, or one field:

```csharp
connection.Scalar("SELECT COUNT(*) FROM person");                                   // 2L
connection.Scalar("SELECT email FROM person WHERE last_name = ?1", ["Lovelace"]);
```

`Execute` gives the whole result when you need more than the rows:

```csharp
var rows = connection.Execute("SELECT id, first_name FROM person ORDER BY id", null, 200);

rows.Columns        // ["id", "first_name"]
rows.ColumnTypes    // ["INTEGER", "TEXT"] - "" for an expression
rows.Count          // 2 - how many rows were handed back
rows.Total          // 2 - how many rows the statement produced
rows.More           // false - whether the limit of 200 left any behind
rows.Affected       // null for a query; the row count for a write

rows.Objects();           // List<Dictionary<string, object?>>
rows.One();               // the first row, or null
rows.Scalar();            // the first column of the first row
rows.Get(0, "last_name"); // one cell, by row and column name
```

`Total` is counted, not estimated, so a grid can show `1 to 200 of 4,317` and be right. `Rows` is an
`IReadOnlyList<IReadOnlyList<object?>>`, so `foreach` and indexing both work.

## Values

| SQL | C# |
|---|---|
| `NULL` | `null` |
| `INTEGER` | `long` |
| `REAL` | `double` |
| `TEXT` | `string` |
| `BLOB` | `byte[]` |

`null` is `NULL` and is not the empty string. Binding takes those plus `bool`, every integer type,
`float` and `decimal`. Anything else throws rather than being converted, because converting it would
be this library deciding what your value means.

## Parameters

Parameters are `?1`, `?2` and so on, bound in order and never pasted into the text:

```csharp
connection.Execute("SELECT * FROM person WHERE age > ?1 AND last_name LIKE ?2", [40, "L%"]);
```

Compile once and run many times with `Prepare`:

```csharp
using var insert = connection.Prepare("INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)");
foreach (var person in many)
{
    insert.Execute([person.FirstName, person.LastName, person.Email, person.Age, person.HeightM]);
}
```

## Transactions

A transaction is an object you hold open. Run the statements, look at how many rows each one
changed, then commit or roll back:

```csharp
using var transaction = connection.Begin();
if (transaction.Execute("UPDATE person SET age = age + 1") == expected)
{
    transaction.Commit();
}
// leaving the using block without committing rolls back
```

Disposing rolls back, so an early return undoes its work. A failed statement rolls the whole
transaction back before it throws.

## When the engine refuses

```csharp
try
{
    connection.Execute("SOME CONSTRUCT THE ENGINE HAS NOT BUILT");
}
catch (UnsupportedFeatureException why)
{
    Console.WriteLine($"not yet: {why.Feature}");
}
catch (InillucentException why)
{
    Console.WriteLine($"{why.Status} {why.PlainMessage} at byte {why.Offset}");
}
```

`UnsupportedFeatureException` is a separate type on purpose. The engine refuses what it has not
built rather than answering it wrongly, so an application can say "this engine cannot do that yet"
instead of "check your spelling".

Ask first rather than after:

```csharp
if (Driver.Supports("cancel") != Support.Yes)
{
    // do not draw a Stop button
}

foreach (var capability in Driver.Capabilities())
{
    Console.WriteLine($"{capability.Name} {capability.SupportName} {capability.Note}");
}
```

## Threads

One file is one buffer pool and the engine is single threaded. Keep a `Database` and everything
under it on one thread, or serialise every call on it with a lock of your own. There is no lock
inside. Two databases on two files are independent.

## Why not ADO.NET

`DbConnection` and its family assume a connection pool and a provider that can be handed a
connection from any thread, and this engine is single threaded with no lock inside. An ADO.NET
provider over it would either lie about that or serialise everything behind a pool of one, and the
caller would lose the exact `Total`, the capability table and the refusal that names its construct,
because ADO.NET has nowhere to put them.

## Running the tests

```sh
cd csharp/test/Inillucent.Conformance && dotnet run
cd csharp/examples/Quickstart && dotnet run
```

Set `INILLUCENT_REPOSITORY` to the repository root when running from somewhere else, so the runner
can find the suite and the shared library.

It runs [`conformance/suite.json`](../conformance/suite.json), the same file the engine's own Rust
driver runs.
