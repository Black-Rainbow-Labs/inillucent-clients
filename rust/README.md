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

Create a table, insert rows, read them back, and update one.
[`examples/person.rs`](examples/person.rs) is this program and it runs.

```rust
use inillucent::{Database, Value};

let database = Database::open("app.rdb")?;
let connection = database.connect()?;

connection.run(
    "CREATE TABLE person (
       id         INTEGER PRIMARY KEY,
       first_name TEXT NOT NULL,
       last_name  TEXT NOT NULL,
       email      TEXT,
       age        INTEGER,
       height_m   REAL
     )",
)?;

let mut insert = connection.prepare(
    "INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)",
)?;
insert.execute(
    &[Value::from("Ada"), Value::from("Lovelace"), Value::from("ada@example.com"),
      Value::Integer(36), Value::Real(1.65)],
    None,
)?;
insert.execute(
    &[Value::from("Grace"), Value::from("Hopper"), Value::Null,
      Value::Integer(85), Value::Real(1.57)],
    None,
)?;
drop(insert);

let rows = connection.run(
    "SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id",
)?;
for nth in 0..rows.len() {
    println!(
        "{} {} {} {} {} {}",
        rows.get(nth, "id").unwrap(),
        rows.get(nth, "first_name").unwrap(),
        rows.get(nth, "last_name").unwrap(),
        rows.get(nth, "email").unwrap(),
        rows.get(nth, "age").unwrap(),
        rows.get(nth, "height_m").unwrap(),
    );
}

println!("people: {}", connection.scalar("SELECT COUNT(*) FROM person", &[])?.unwrap());

let changed = connection.execute(
    "UPDATE person SET email = ?1 WHERE last_name = ?2",
    &[Value::from("grace@example.com"), Value::from("Hopper")],
    None,
)?;
println!("updated: {}", changed.affected.unwrap_or(0));
# Ok::<(), inillucent::Error>(())
```

```
1 Ada Lovelace ada@example.com 36 1.65
2 Grace Hopper NULL 85 1.57
people: 2
updated: 1
email now: grace@example.com
```

`run(sql)` is `execute(sql, &[], None)`, for a statement with nothing bound.

A `Connection` borrows its `Database`, so the compiler enforces the order the C ABI requires: the
database cannot be closed while a connection on it is alive. `Statement` and `Transaction` borrow
their `Connection` the same way.

## Reading rows

`get` takes the column name, so the order of the SELECT does not have to be carried in your head.

```rust
let rows = connection.run("SELECT first_name, last_name, email FROM person ORDER BY id")?;

rows.get(0, "first_name");   // Some(Value::Text("Ada"))
rows.get(0, "last_name");    // Some(Value::Text("Lovelace"))
rows.get(1, "email");        // Some(Value::Null) - the column is NULL

// Read one out as the type it is.
let first = rows.get(0, "first_name").and_then(Value::as_text).unwrap_or("");
let age = rows.get(0, "age").and_then(Value::as_integer);
# Ok::<(), inillucent::Error>(())
```

`scalar` gives the first column of the first row, for a COUNT, a MAX, or one field:

```rust
connection.scalar("SELECT COUNT(*) FROM person", &[])?;
connection.scalar("SELECT email FROM person WHERE last_name = ?1", &[Value::from("Lovelace")])?;
# Ok::<(), inillucent::Error>(())
```

## The whole result

```rust
let rows = connection.execute("SELECT id, first_name FROM person ORDER BY id", &[], Some(200))?;

rows.columns          // ["id", "first_name"]
rows.column_types     // ["INTEGER", "TEXT"] - "" for an expression
rows.rows             // Vec<Vec<Value>>
rows.total            // 2 - how many rows the statement produced
rows.more             // false - whether the limit of 200 left any behind
rows.affected         // None for a query; Some(n) for a write
rows.tag              // "SELECT 2"

rows.one();                    // Option<&Vec<Value>>
rows.scalar();                 // Option<&Value>
rows.column_index("email");    // Option<usize>
# Ok::<(), inillucent::Error>(())
```

`total` is counted, not estimated, so a grid can show `1 to 200 of 4,317` and be right.

## Values

```rust
pub enum Value { Null, Integer(i64), Real(f64), Text(String), Blob(Vec<u8>) }
```

`Null` is a variant rather than an empty string, because they are different values. `From` is
implemented for `i64`, `i32`, `f64`, `bool`, `&str`, `String`, `Vec<u8>`, `&[u8]` and `Option<T>`,
so `Value::from("Ada")` and `Value::from(None::<i64>)` both work, and `as_integer`, `as_real`,
`as_text`, `as_blob` and `is_null` read one back out.

## Transactions

A transaction is an object you hold open. Run the statements, look at how many rows each one
changed, then commit or roll back:

```rust
let mut transaction = connection.transaction()?;
let changed = transaction.execute("UPDATE person SET age = age + 1")?;
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
