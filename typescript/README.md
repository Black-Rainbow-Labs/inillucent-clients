# inillucent, from TypeScript

The [inillucent](https://github.com/jasonmcaffee/inillucent) embedded database, in your process.
Published as `inillucent-client`, written in TypeScript, with an ES module entry, a CommonJS entry and type declarations,
so a JavaScript project installs exactly the same package. See [../javascript](../javascript) for
the plain JavaScript form.

Calls go through [koffi](https://koffi.dev), which ships prebuilt binaries, so installing this needs
no C compiler and no build step of your own.

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

```ts
import { connect } from 'inillucent-client';

const db = connect('app.rdb');

db.execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)');
db.execute('INSERT INTO authors VALUES (?1, ?2, ?3)', [1, 'Octavia Butler', 4.8]);
db.execute('INSERT INTO authors VALUES (?1, ?2, ?3)', [2, 'Ursula Le Guin', null]);

for (const author of db.query('SELECT id, name, rating FROM authors ORDER BY id')) {
  console.log(author.id, author.name, author.rating);
}

db.close();
```

`connect()` opens the file and hands back a `Connection` that owns it, so `close()` closes the
database with it. Open the two separately when you want more than one connection on one file:

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

## Reading results

`execute()` returns `Rows`. It is materialised and copied into JavaScript, so it stays usable after
the call that made it.

```ts
const rows = db.execute('SELECT id, name FROM authors ORDER BY id', [], 200);

rows.columns        // ['id', 'name']
rows.columnTypes    // ['INTEGER', 'TEXT'] — '' for an expression, which has no declared type
rows.rows           // [[1, 'Octavia Butler'], [2, 'Ursula Le Guin']]
rows.total          // how many the statement produced, exactly
rows.more           // whether the limit of 200 cut anything off
rows.affected       // null for a query; the count for a write
rows.tag            // 'SELECT 2'

rows.objects()      // [{ id: 1, name: 'Octavia Butler' }, ...]
rows.one()          // the first row, or undefined
rows.scalar()       // the first column of the first row
rows.column('name') // ['Octavia Butler', 'Ursula Le Guin']
```

`query()` is `execute(...).objects()` and `scalar()` is the one value:

```ts
db.query('SELECT id, name FROM authors');     // RowObject[]
db.scalar('SELECT COUNT(*) FROM authors');    // 2
```

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
db.execute('SELECT * FROM authors WHERE rating > ?1 AND name LIKE ?2', [4.0, 'O%']);
```

Compile once and run many times with `prepare`:

```ts
const insert = db.prepare('INSERT INTO authors VALUES (?1, ?2, ?3)');
try {
  for (const author of many) insert.execute([author.id, author.name, author.rating]);
} finally {
  insert.close();
}
```

## Transactions

A transaction is a handle you hold, so what a write did can be checked **before** the commit:

```ts
const txn = db.transaction();
const changed = txn.execute('UPDATE authors SET rating = rating + 0.1 WHERE rating IS NOT NULL');
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
