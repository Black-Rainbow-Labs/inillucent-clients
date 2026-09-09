# inillucent, from Go

The [inillucent](https://github.com/jasonmcaffee/inillucent) embedded database, in your process.
Calls go through [purego](https://github.com/ebitengine/purego), so `CGO_ENABLED` stays 0.

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

Create a table, insert rows, read them back, and update one.
[`examples/person`](examples/person) is this program and it runs.

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

if _, err := connection.Exec(`CREATE TABLE person (
      id         INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name  TEXT NOT NULL,
      email      TEXT,
      age        INTEGER,
      height_m   REAL
    )`); err != nil {
    return err
}

insert := "INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)"
connection.Exec(insert, "Ada", "Lovelace", "ada@example.com", 36, 1.65)
connection.Exec(insert, "Grace", "Hopper", nil, 85, 1.57)

people, err := connection.Query(
    "SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id")
if err != nil {
    return err
}
for _, person := range people {
    fmt.Println(person["id"], person["first_name"], person["last_name"],
        person["email"], person["age"], person["height_m"])
}

count, _ := connection.Scalar("SELECT COUNT(*) FROM person")
fmt.Println("people:", count)

changed, err := connection.Exec(
    "UPDATE person SET email = ?1 WHERE last_name = ?2", "grace@example.com", "Hopper")
fmt.Println("updated:", changed.Affected)
```

```
1 Ada Lovelace ada@example.com 36 1.65
2 Grace Hopper <nil> 85 1.57
people: 2
updated: 1
email now: grace@example.com
```

## Reading rows

`Query` gives a `map[string]any` per row, keyed by column name. That is what you want most of the
time.

```go
people, err := connection.Query("SELECT first_name, last_name, email FROM person ORDER BY id")

people[0]["first_name"]   // "Ada"
people[0]["last_name"]    // "Lovelace"
people[1]["email"]        // nil - the column is NULL, and nil is not ""

// Read one out as the type it is.
first := people[0]["first_name"].(string)
age, ok := people[0]["age"].(int64)
```

`Scalar` gives the first column of the first row, for a COUNT, a MAX, or one field:

```go
connection.Scalar("SELECT COUNT(*) FROM person")                                    // int64(2)
connection.Scalar("SELECT email FROM person WHERE last_name = ?1", "Lovelace")      // "ada@example.com"
```

`Exec` gives the whole result when you need more than the rows:

```go
rows, err := connection.ExecLimit("SELECT id, first_name FROM person ORDER BY id", 200)

rows.Columns        // []string{"id", "first_name"}
rows.ColumnTypes    // []string{"INTEGER", "TEXT"} - "" for an expression
rows.Values         // [][]any
rows.Total          // 2 - how many rows the statement produced
rows.More           // false - whether the limit of 200 left any behind
rows.Affected       // -1 for a query; the row count for a write
rows.Tag            // "SELECT 2"

rows.Objects()               // []map[string]any
rows.One()                   // the first row, or nil
rows.Scalar()                // the first column of the first row
rows.Get(0, "last_name")     // one cell, by row and column name
```

`Total` is counted, not estimated, so a grid can show `1 to 200 of 4,317` and be right. A limit of
`0` in `ExecLimit` means every row, which is the same as `Exec`.

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
    "SELECT * FROM person WHERE age > ?1 AND last_name LIKE ?2", 40, "L%")
```

Compile once and run many times with `Prepare`:

```go
insert, err := connection.Prepare("INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)")
if err != nil {
    return err
}
defer insert.Close()

for _, person := range many {
    if _, err := insert.Exec(person.FirstName, person.LastName, person.Email, person.Age, person.HeightM); err != nil {
        return err
    }
}
```

## Transactions

A transaction is an object you hold open. Run the statements, look at how many rows each one
changed, then commit or roll back:

```go
transaction, err := connection.Begin()
if err != nil {
    return err
}
defer transaction.Rollback()   // safe after a commit, so this is the right shape

changed, err := transaction.Exec("UPDATE person SET age = age + 1")
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
