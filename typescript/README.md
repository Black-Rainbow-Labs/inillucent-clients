# inillucent, from TypeScript

The [inillucent](https://github.com/Black-Rainbow-Labs/Inillucent) embedded database, in your process.
Published as `inillucent-client`, written in TypeScript, with an ES module entry, a CommonJS entry and type declarations,
so a JavaScript project installs exactly the same package. See [../javascript](../javascript) for
the plain JavaScript form.

Calls go through [koffi](https://koffi.dev), which ships prebuilt binaries, so `npm install` has
nothing to build.

## Install

```sh
npm install inillucent-client
```

From a checkout of this repository:

```sh
npm --prefix typescript install
npm --prefix typescript run build
```

You also need the shared library. See [the shared library](../README.md#the-shared-library) — build
it once with cargo and run `node scripts/fetch-native.mjs`, or point `INILLUCENT_DRIVER_LIB` at a
copy you ship yourself.

## A first program

Create a table, insert rows, read them back, and update one.
[`examples/person.ts`](examples/person.ts) is this program and it runs.

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

const insert =
  'INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)';
db.execute(insert, ['Ada', 'Lovelace', 'ada@example.com', 36, 1.65]);
db.execute(insert, ['Grace', 'Hopper', null, 85, 1.57]);

for (const person of db.query(
  'SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id',
)) {
  console.log(person.id, person.first_name, person.last_name, person.email, person.age, person.height_m);
}

console.log('people:', db.scalar('SELECT COUNT(*) FROM person'));

const changed = db.execute('UPDATE person SET email = ?1 WHERE last_name = ?2', [
  'grace@example.com',
  'Hopper',
]);
console.log('updated:', changed.affected);
console.log('email now:', db.scalar('SELECT email FROM person WHERE last_name = ?1', ['Hopper']));

db.close();
```

```
1 Ada Lovelace ada@example.com 36 1.65
2 Grace Hopper null 85 1.57
people: 2
updated: 1
email now: grace@example.com
```

`connect()` opens the file and returns a `Connection` that owns it, so `close()` closes the database
with it. Open the two separately when you want more than one connection on one file:

```ts
import { Database } from 'inillucent-client';

const database = new Database('app.rdb');
const first = database.connect();
const second = database.connect();
// ...
database.close();   // closes both connections, then the file
```

Both are `Symbol.dispose`, so `using db = connect('app.rdb')` works where your TypeScript target
supports explicit resource management.

## Reading rows

`query()` gives one object per row, keyed by column name. That is what you want most of the time.

```ts
const people = db.query('SELECT first_name, last_name, email FROM person ORDER BY id');

people[0].first_name;   // 'Ada'
people[0].last_name;    // 'Lovelace'
people[0].email;        // 'ada@example.com'
people[1].email;        // null — the column is NULL, and null is not ''
```

`scalar()` gives the first column of the first row, for a `COUNT`, a `MAX`, or one field:

```ts
db.scalar('SELECT COUNT(*) FROM person');                                  // 2
db.scalar('SELECT email FROM person WHERE last_name = ?1', ['Lovelace']);  // 'ada@example.com'
```

`execute()` gives the whole result when you need more than the rows:

```ts
const rows = db.execute('SELECT id, first_name, last_name FROM person ORDER BY id', [], 200);

rows.columns        // ['id', 'first_name', 'last_name']
rows.columnTypes    // ['INTEGER', 'TEXT', 'TEXT'] — '' for an expression, which has no declared type
rows.rows           // [[1, 'Ada', 'Lovelace'], [2, 'Grace', 'Hopper']]
rows.total          // 2 — how many rows the statement produced
rows.more           // false — whether the limit of 200 left any behind
rows.affected       // null for a query; the row count for a write
rows.tag            // 'SELECT 2'

rows.objects()            // [{ id: 1, first_name: 'Ada', last_name: 'Lovelace' }, ...]
rows.one()                // the first row, or undefined
rows.scalar()             // the first column of the first row
rows.column('last_name')  // ['Lovelace', 'Hopper']
```

`total` is counted, not estimated, so a grid can show `1 to 200 of 4,317` and be right.

`Rows` is iterable, so `for (const row of rows)` walks the arrays.

## Values

| SQL | TypeScript |
|---|---|
| `NULL` | `null` |
| `INTEGER` | `number`, or `bigint` past `Number.MAX_SAFE_INTEGER` |
| `REAL` | `number` |
| `TEXT` | `string` |
| `BLOB` | `Buffer` |

`null` is `NULL` and is not the empty string. An integer that does not fit a double comes back as a
`bigint` rather than rounded, because rounding it would be this library quietly changing the value.

Binding takes the same set plus `boolean`, which binds as an integer. A `number` binds as an integer
when `Number.isInteger` says so and as a real otherwise, so write `4.0` as `4.0` only if you mean
the integer 4.

## Parameters

Parameters are `?1`, `?2` and so on, bound in order and never pasted into the text:

```ts
db.execute('SELECT * FROM person WHERE age > ?1 AND last_name LIKE ?2', [40, 'L%']);
```

Compile once and run many times with `prepare`:

```ts
const insert = db.prepare('INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)');
try {
  for (const person of many)
    insert.execute([person.firstName, person.lastName, person.email, person.age, person.heightM]);
} finally {
  insert.close();
}
```

## Transactions

A transaction is an object you hold open. Run the statements, look at how many rows each one
changed, then commit or roll back:

```ts
const txn = db.transaction();
const changed = txn.execute('UPDATE person SET age = age + 1 WHERE last_name = 'Hopper'');
if (changed === expected) txn.commit();
else txn.rollback();
```

A failed statement rolls the whole transaction back before it throws, so a caller that stops at the
first error has already undone everything. A transaction that is never committed rolls back.

## When the engine refuses

```ts
import { InillucentError, UnsupportedError } from 'inillucent-client';

try {
  db.execute('SOME CONSTRUCT THE ENGINE HAS NOT BUILT');
} catch (why) {
  if (why instanceof UnsupportedError) console.log('not yet:', why.feature);
  else if (why instanceof InillucentError) console.log(why.statusName, why.offset);
  else throw why;
}
```

`UnsupportedError` is a separate type on purpose. The engine refuses what it has not built rather
than answering it wrongly, so an application can say "this engine cannot do that yet" instead of
"check your spelling".

Ask first rather than after:

```ts
import { capabilities, supports, Support } from 'inillucent-client';

if (supports('cancel') !== Support.Yes) {
  // do not draw a Stop button
}

for (const capability of capabilities()) {
  console.log(capability.name, capability.supportName, capability.note);
}
```

## The database itself

```ts
database.path;                  // the file it is in
database.checkpoint();          // make everything written so far durable
database.integrityCheck();      // walk every tree and throw on the first thing wrong
database.backupTo('copy.rdb');  // copies, then opens and checks the copy
```

## Threads

One file is one buffer pool and the engine is single threaded. Keep a `Database` and everything
under it on one worker. Two databases on two files are independent.

Every call is synchronous, which is deliberate: the engine runs a statement whole, so there is
nothing to await and an async wrapper would add a microtask per row for no gain. Put a long query on
a worker thread if it must not block the event loop.

## Running the tests

```sh
npm --prefix typescript test
```

It runs [`conformance/suite.json`](../conformance/suite.json), the same file the engine's own Rust
driver runs.
