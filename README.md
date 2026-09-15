# inillucent client libraries

Client libraries for [inillucent](https://github.com/Black-Rainbow-Labs/Inillucent), an embedded database
written in Rust.

There is no server. Your program opens a file, sends SQL to a library in the same process, and gets
typed rows back.

```ts
import { connect } from 'inillucent-client';

const db = connect('app.rdb');

db.execute(`
  CREATE TABLE person (
    id         INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name  TEXT NOT NULL,
    email      TEXT,
    age        INTEGER,
    height_m   REAL
  )
`);

db.execute(
  'INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)',
  ['Ada', 'Lovelace', 'ada@example.com', 36, 1.65],
);

for (const person of db.query('SELECT first_name, last_name, email FROM person')) {
  console.log(person.first_name, person.last_name, person.email);
}

db.close();
```

```
Ada Lovelace ada@example.com
```

---

## Languages

| | Install | |
|---|---|---|
| **TypeScript** | `npm install inillucent-client` | [typescript/](typescript/) |
| **JavaScript** | `npm install inillucent-client` | [javascript/](javascript/) |
| **Python** | `pip install inillucent-client` | [python/](python/) |
| **Rust** | `cargo add inillucent-client` | [rust/](rust/) |
| **Go** | `go get github.com/Black-Rainbow-Labs/inillucent-clients/go` | [go/](go/) |
| **Java** | `com.inillucent:inillucent-client` | [java/](java/) |
| **C#** | `dotnet add package Inillucent.Client` | [csharp/](csharp/) |
| **PHP** | `composer require inillucent/client` | [php/](php/) |

Each folder has a README with a worked example and the API in that language's own idiom. The API is
the same in all eight, so the sections below apply to every one of them.

Every client also needs the engine's shared library. See [The shared library](#the-shared-library).

---

## Reading rows

`query` returns one object per row, keyed by column name.

```ts
for (const person of db.query(
  'SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id',
)) {
  console.log(person.id, person.first_name, person.last_name, person.email, person.age);
}
```

```
1 Ada Lovelace ada@example.com 36
2 Grace Hopper null 85
```

`scalar` returns the first column of the first row, for a `COUNT` or a `MAX`:

```ts
db.scalar('SELECT COUNT(*) FROM person');    // 2
```

`execute` returns the full result when you want more than the rows:

```ts
const page = db.execute('SELECT id, first_name FROM person ORDER BY id', [], 20);

page.columns;   // ['id', 'first_name']
page.rows;      // [[1, 'Ada'], [2, 'Grace']]
page.total;     // 2 — how many rows the statement produced
page.more;      // false — whether the limit of 20 left any behind
page.affected;  // null for a query, the row count for a write
page.objects(); // the same rows keyed by column name
```

`total` is counted, not estimated, so a grid can show `1 to 20 of 4,317` and be right.

## Writing rows

Values go in as `?1`, `?2` and so on. They are bound, never pasted into the SQL text.

```ts
db.execute(
  'INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)',
  ['Grace', 'Hopper', null, 85, 1.57],
);

const changed = db.execute('UPDATE person SET email = ?1 WHERE last_name = ?2', [
  'grace@example.com',
  'Hopper',
]);
changed.affected;   // 1
```

To run the same statement many times, compile it once:

```ts
const insert = db.prepare(
  'INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)',
);
for (const person of many) {
  insert.execute([person.firstName, person.lastName, person.email, person.age, person.heightM]);
}
insert.close();
```

## Values

| SQL | TypeScript | Python | Rust | Go | Java | C# | PHP |
|---|---|---|---|---|---|---|---|
| `NULL` | `null` | `None` | `Value::Null` | `nil` | `null` | `null` | `null` |
| `INTEGER` | `number` | `int` | `Value::Integer` | `int64` | `Long` | `long` | `int` |
| `REAL` | `number` | `float` | `Value::Real` | `float64` | `Double` | `double` | `float` |
| `TEXT` | `string` | `str` | `Value::Text` | `string` | `String` | `string` | `string` |
| `BLOB` | `Buffer` | `bytes` | `Value::Blob` | `[]byte` | `byte[]` | `byte[]` | `Blob` |

`NULL` and the empty string are different values and stay different in every client. An integer too
large for a JavaScript number comes back as a `bigint`.

## Transactions

A transaction is an object you hold open. Run the statements, look at how many rows each one
changed, then commit or roll back.

```ts
const txn = db.transaction();
const changed = txn.execute("UPDATE person SET age = age + 1 WHERE last_name = 'Hopper'");

if (changed === 1) txn.commit();
else txn.rollback();
```

If a statement inside the transaction fails, the transaction is rolled back before the error is
thrown, so nothing is left half applied. A transaction that is never committed rolls back.

## Errors

Every failure carries a status, so you never have to match on the message text.

```ts
import { InillucentError, UnsupportedError } from 'inillucent-client';

try {
  db.execute('SELECT * FROM missing_table');
} catch (why) {
  if (why instanceof UnsupportedError) console.log('the engine has no', why.feature);
  else if (why instanceof InillucentError) console.log(why.statusName);  // 'not_found'
  else throw why;
}
```

The statuses are `unsupported`, `syntax`, `not_found`, `constraint`, `readonly`, `busy`,
`interrupted`, `corrupt`, `io`, `full`, `too_big`, `invalid_state` and `internal`.

`unsupported` has its own error type because the engine is still being built out. When it has not
implemented something, it says so and names the construct, instead of failing as though your SQL
were wrong. You can also ask before you write the statement:

```ts
import { capabilities, supports, Support } from 'inillucent-client';

supports('cancel');     // Support.No, so do not draw a Stop button
capabilities();         // every feature the engine declares, with a note on each
```

---

## The shared library

Every client calls one shared library built from the engine:
`inillucent_driver_capi.dll` on Windows, `libinillucent_driver_capi.so` on Linux,
`libinillucent_driver_capi.dylib` on macOS.

Build it from an engine checkout and copy it into `native/`:

```sh
cargo build --release --manifest-path <engine>/Cargo.toml -p inillucent-driver-capi
node scripts/fetch-native.mjs
```

Every client looks in the same four places, in order:

1. `INILLUCENT_DRIVER_LIB`, a full path. Set this to point at a copy you ship yourself.
2. `native/` in this repository.
3. An engine checkout beside this one, `target/release` then `target/debug`.
4. The operating system's library search path.

If none of them has it, the error lists all four.

[`native/inillucent_driver.h`](native/inillucent_driver.h) is the C header, so a C or C++ program
can compile against the same ABI.

## Tests

Every client is graded by [`conformance/suite.json`](conformance/suite.json), the same file the
engine's own Rust driver runs. A client passes when it agrees with the engine.

```
$ node scripts/test-all.mjs

  ok    python      ctypes
  ok    typescript  koffi
  ok    javascript  the same package, both module systems
  ok    rust        libloading
  ok    go          purego
  ok    java        the Foreign Function and Memory API
  ok    csharp      DllImport
  ok    php         the FFI extension

8 of 8 clients pass
```

A language with no toolchain on the machine is reported as skipped.

The [`examples/`](examples/) folder describes the person program each README shows, and each client
has its own copy that runs.

## Licence

MIT. See [LICENSE](LICENSE).
