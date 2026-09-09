# inillucent, from Rust

The [inillucent](https://github.com/jasonmcaffee/inillucent) embedded database, in your process,
loading its C ABI at runtime with [libloading](https://docs.rs/libloading).

## Which Rust crate to use

There are two, and the choice is worth thirty seconds.

**`inillucent-driver`, from the engine repository**, is the driver itself. It keeps the type system
across the seam, costs no pointer round trip per call, and is what you want when your project can
depend on the engine's source.

**`inillucent-client`, this crate**, loads a prebuilt shared library at runtime instead. Use it when
the library ships beside your program, when you would rather not build the engine to build your
application, or when you want the same deployment story as the other seven clients here.

The two have the same shape. This one is a little more verbose because every call can fail to find
the library, not only to run the statement.

## Install

```toml
[dependencies]
inillucent-client = "0.1"
```

The crate is named `inillucent-client` and the library it exports is `inillucent`, so `use
inillucent::Database;` is the import.

You also need the shared library. See [the shared library](../README.md#the-shared-library).

## A first program

```rust
use inillucent::{Database, Value};

let database = Database::open("app.rdb")?;
let connection = database.connect()?;

connection.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)")?;
connection.execute(
    "INSERT INTO authors VALUES (?1, ?2, ?3)",
    &[Value::Integer(1), Value::from("Octavia Butler"), Value::Real(4.8)],
    None,
)?;

let rows = connection.run("SELECT id, name, rating FROM authors ORDER BY id")?;
for row in &rows {
    println!("{} {} {}", row[0], row[1], row[2]);
}
# Ok::<(), inillucent::Error>(())
```

`run(sql)` is `execute(sql, &[], None)`, for the common case of a statement with nothing bound.

A `Connection` borrows its `Database`, so the compiler enforces the order the C ABI requires: the
database cannot be closed while a connection on it is alive. `Statement` and `Transaction` borrow
their `Connection` the same way.

## Reading results

`Rows` is materialised and owned, so it outlives the statement that made it.

```rust
let rows = connection.execute("SELECT id, name FROM authors ORDER BY id", &[], Some(200))?;

rows.columns          // ["id", "name"]
rows.column_types     // ["INTEGER", "TEXT"] — "" for an expression
rows.rows             // Vec<Vec<Value>>
rows.total            // how many the statement produced, exactly
rows.more             // whether the limit of 200 cut anything off
rows.affected         // None for a query; Some(n) for a write
rows.tag              // "SELECT 2"

rows.one();                    // Option<&Vec<Value>>
rows.scalar();                 // Option<&Value>
rows.get(0, "name");           // Option<&Value>, by row and column name
rows.column_index("name");     // Option<usize>
# Ok::<(), inillucent::Error>(())
```

## Values

```rust
pub enum Value { Null, Integer(i64), Real(f64), Text(String), Blob(Vec<u8>) }
```

`Null` is a variant rather than an empty string, because they are different values. `From` is
implemented for `i64`, `i32`, `f64`, `bool`, `&str`, `String`, `Vec<u8>`, `&[u8]` and `Option<T>`,
so `Value::from("Ada")` and `Value::from(None::<i64>)` both work, and `as_integer`, `as_real`,
`as_text`, `as_blob` and `is_null` read one back out.

## Transactions

A transaction is a handle you hold, so what a write did can be checked **before** the commit:

```rust
let mut transaction = connection.transaction()?;
let changed = transaction.execute("UPDATE authors SET rating = rating + 0.1")?;
if changed == expected {
    transaction.commit()?;
} else {
    transaction.rollback();
}
# Ok::<(), inillucent::Error>(())
```

`commit` takes `self`, so a committed transaction cannot be used again. Dropping one without
committing rolls it back, which is what an early `?` means.

## When the engine refuses

```rust
use inillucent::Status;

match connection.run("SOME CONSTRUCT THE ENGINE HAS NOT BUILT") {
    Err(why) if why.status == Status::Unsupported => {
        println!("not yet: {}", why.feature.unwrap_or_default());
    }
    other => { other?; }
}
# Ok::<(), inillucent::Error>(())
```

`Status::Unsupported` is its own status. The engine refuses what it has not built rather than
answering it wrongly, so an application can say "this engine cannot do that yet" instead of "check
your spelling", and `Error::feature` names the construct.

Ask first rather than after:

```rust
use inillucent::{capabilities, supports, Support};

if supports("cancel")? != Support::Yes {
    // do not draw a Stop button
}

for capability in capabilities()? {
    println!("{} {} {}", capability.name, capability.support.name(), capability.note);
}
# Ok::<(), inillucent::LoadError>(())
```

An unknown name answers `Support::Unknown`, and you should treat that as no rather than as yes: a
capability that was never declared was certainly never checked.

## Threads

`Database` is deliberately neither `Send` nor `Sync`. One file is one buffer pool and the engine is
single threaded, and there is no lock inside. Two databases on two files are independent.

## Running the tests

```sh
cargo test --manifest-path rust/Cargo.toml
cargo run --manifest-path rust/Cargo.toml --example quickstart
```

The test runs [`conformance/suite.json`](../conformance/suite.json), the same file the engine's own
Rust driver runs.
