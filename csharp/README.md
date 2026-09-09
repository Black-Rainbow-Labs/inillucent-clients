# inillucent, from C#

The [inillucent](https://github.com/jasonmcaffee/inillucent) embedded database, in your process,
through `DllImport`.

Targets **.NET 8** and runs on anything newer. No dependencies.

## Install

```sh
dotnet add package Inillucent
```

You also need the shared library. See [the shared library](../README.md#the-shared-library).

The library path is decided at runtime rather than baked into the attributes:
`NativeLibrary.SetDllImportResolver` points every import at whatever file the shared search order
found, so the `DllImport` declarations stay ordinary and the file can live anywhere.

## A first program

```csharp
using Inillucent;

using var database = Database.Open("app.rdb");
using var connection = database.Connect();

connection.Execute("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)");
connection.Execute("INSERT INTO authors VALUES (?1, ?2, ?3)", [1, "Octavia Butler", 4.8]);
connection.Execute("INSERT INTO authors VALUES (?1, ?2, ?3)", [2, "Ursula Le Guin", null]);

foreach (var author in connection.Query("SELECT id, name, rating FROM authors ORDER BY id"))
{
    Console.WriteLine($"{author["id"]} {author["name"]} {author["rating"]}");
}
```

Both are `IDisposable`. Disposing the database disposes every connection on it first, because the C
library refuses to close a database that still has connections open, and freeing it then would leave
them pointing at memory that is gone.

## Reading results

`Execute` returns `Rows`. It is materialised and copied into .NET, so it outlives the call that made
it.

```csharp
var rows = connection.Execute("SELECT id, name FROM authors ORDER BY id", null, 200);

rows.Columns        // ["id", "name"]
rows.ColumnTypes    // ["INTEGER", "TEXT"] — "" for an expression
rows.Count          // how many rows were handed back
rows.Total          // how many the statement produced, exactly
rows.More           // whether the limit of 200 cut anything off
rows.Affected       // null for a query; the count for a write
rows.Tag            // "SELECT 2"

rows.Objects();          // List<Dictionary<string, object?>>
rows.One();              // the first row, or null
rows.Scalar();           // the first column of the first row
rows.Get(0, "name");     // one cell, by row and column name
```

`Rows` is an `IReadOnlyList<IReadOnlyList<object?>>`, so `foreach` and indexing both work.

`Query` is `Execute(...).Objects()` and `Scalar` is the one value:

```csharp
connection.Query("SELECT id, name FROM authors");
connection.Scalar("SELECT COUNT(*) FROM authors");
```

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
connection.Execute("SELECT * FROM authors WHERE rating > ?1 AND name LIKE ?2", [4.0, "O%"]);
```

Compile once and run many times with `Prepare`:

```csharp
using var insert = connection.Prepare("INSERT INTO authors VALUES (?1, ?2, ?3)");
foreach (var author in many)
{
    insert.Execute([author.Id, author.Name, author.Rating]);
}
```

## Transactions

A transaction is a handle you hold, so what a write did can be checked **before** the commit:

```csharp
using var transaction = connection.Begin();
if (transaction.Execute("UPDATE authors SET rating = rating + 0.1") == expected)
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
