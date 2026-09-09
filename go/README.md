# inillucent, from Go

The [inillucent](https://github.com/jasonmcaffee/inillucent) embedded database, in your process.
Calls go through [purego](https://github.com/ebitengine/purego), so **cgo stays off** and building
this needs no C compiler.

## Install

```sh
go get github.com/jasonmcaffee/inillucent-clients/go
```

```go
import inillucent "github.com/jasonmcaffee/inillucent-clients/go"
```

The import path ends in `/go` and the package is named `inillucent`, so the alias above is worth
writing out.

You also need the shared library. See [the shared library](../README.md#the-shared-library).

## A first program

```go
database, err := inillucent.Open("app.rdb")
if err != nil {
    return err
}
defer database.Close()

connection, err := database.Connect()
if err != nil {
    return err
}
defer connection.Close()

if _, err := connection.Exec(
    "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)"); err != nil {
    return err
}
if _, err := connection.Exec(
    "INSERT INTO authors VALUES (?1, ?2, ?3)", 1, "Octavia Butler", 4.8); err != nil {
    return err
}

authors, err := connection.Query("SELECT id, name, rating FROM authors ORDER BY id")
if err != nil {
    return err
}
for _, author := range authors {
    fmt.Println(author["id"], author["name"], author["rating"])
}
```

## Reading results

`Exec` returns `*Rows`. It is materialised and copied into Go, so it outlives the call that made it.

```go
rows, err := connection.ExecLimit("SELECT id, name FROM authors ORDER BY id", 200)

rows.Columns        // []string{"id", "name"}
rows.ColumnTypes    // []string{"INTEGER", "TEXT"} — "" for an expression
rows.Values         // [][]any
rows.Total          // how many the statement produced, exactly
rows.More           // whether the limit of 200 cut anything off
rows.Affected       // -1 for a query; the count for a write
rows.Tag            // "SELECT 2"

rows.Objects()          // []map[string]any
rows.One()              // the first row, or nil
rows.Scalar()           // the first column of the first row
rows.Get(0, "name")     // one cell, by row and column name
rows.ColumnIndex("id")  // the position of a column, or -1
```

`Query` is `Exec(...).Objects()` and `Scalar` is the one value:

```go
authors, err := connection.Query("SELECT id, name FROM authors")
count, err := connection.Scalar("SELECT COUNT(*) FROM authors")
```

A limit of `0` in `ExecLimit` means every row, which is the same as `Exec`.

## Values

| SQL | Go |
|---|---|
| `NULL` | `nil` |
| `INTEGER` | `int64` |
| `REAL` | `float64` |
| `TEXT` | `string` |
| `BLOB` | `[]byte` |

`nil` is `NULL` and is not the empty string. Binding takes those plus `bool`, `int`, `int32`,
`uint64`, `float32`, and anything else is an error rather than a conversion, because converting it
would be this library deciding what your value means.

## Parameters

Parameters are `?1`, `?2` and so on, passed as variadic arguments in order and never pasted into
the text:

```go
rows, err := connection.Exec(
    "SELECT * FROM authors WHERE rating > ?1 AND name LIKE ?2", 4.0, "O%")
```

Compile once and run many times with `Prepare`:

```go
insert, err := connection.Prepare("INSERT INTO authors VALUES (?1, ?2, ?3)")
if err != nil {
    return err
}
defer insert.Close()

for _, author := range many {
    if _, err := insert.Exec(author.ID, author.Name, author.Rating); err != nil {
        return err
    }
}
```

## Transactions

A transaction is a handle you hold, so what a write did can be checked **before** the commit:

```go
transaction, err := connection.Begin()
if err != nil {
    return err
}
defer transaction.Rollback()   // safe after a commit, so this is the right shape

changed, err := transaction.Exec("UPDATE authors SET rating = rating + 0.1")
if err != nil {
    return err
}
if changed == expected {
    return transaction.Commit()
}
return nil                     // the deferred rollback undoes it
```

`Rollback` after a `Commit` is a no-op, which is what makes the `defer` above correct.

## When the engine refuses

```go
var refusal *inillucent.Error
if _, err := connection.Exec("SOME CONSTRUCT"); errors.As(err, &refusal) {
    if refusal.IsUnsupported() {
        fmt.Println("not yet:", refusal.Feature)
    } else {
        fmt.Println(refusal.Status, refusal.Message, refusal.Offset)
    }
}
```

`StatusUnsupported` is its own status. The engine refuses what it has not built rather than
answering it wrongly, so an application can say "this engine cannot do that yet" instead of "check
your spelling", and `Feature` names the construct.

Ask first rather than after:

```go
if support, _ := inillucent.Supports("cancel"); support != inillucent.SupportYes {
    // do not draw a Stop button
}

capabilities, _ := inillucent.Capabilities()
for _, capability := range capabilities {
    fmt.Println(capability.Name, capability.Support, capability.Note)
}
```

## Goroutines

One file is one buffer pool and the engine is single threaded. Keep a `*Database` and everything
under it on one goroutine, or serialise every call on it with a mutex of your own. There is no lock
inside. Two databases on two files are independent.

## Why not database/sql

`database/sql` assumes a connection pool and a driver that can be handed a connection from any
goroutine, and this engine is single threaded with no lock inside. Wrapping it in `database/sql`
would either lie about that or serialise everything behind a pool of one, and either way the caller
loses the exact `total`, the capability table and the refusal that names its construct, because
`database/sql` has nowhere to put them.

## Running the tests

```sh
cd go && go test ./...
go run ./examples/quickstart
```

The test runs [`conformance/suite.json`](../conformance/suite.json), the same file the engine's own
Rust driver runs.
