# inillucent, from JavaScript

The [inillucent](https://github.com/Black-Rainbow-Labs/Inillucent) embedded database, in your process,
from plain JavaScript.

**This is the same npm package as [../typescript](../typescript), not a second implementation.**
`inillucent-client` is written in TypeScript and published with three things beside each other: an ES module
entry, a CommonJS entry, and type declarations. A JavaScript project installs that one package, calls
it with `import` or with `require`, and gets editor completion from the declarations without writing
any types itself. Shipping a second, untyped copy of the same binding would be a second thing to keep
correct and would give a JavaScript caller nothing.

What lives here is the JavaScript side of that: runnable examples in both module systems, and the
tests that hold the CommonJS entry to the same standard as the ES module one.

## Install

```sh
npm install inillucent-client
```

You also need the shared library. See [the shared library](../README.md#the-shared-library).

## ES modules

```js
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

db.close();
```

```
1 Ada Lovelace ada@example.com 36 1.65
2 Grace Hopper null 85 1.57
people: 2
updated: 1
```

## CommonJS

The same program with `require`. [`examples/person.cjs`](examples/person.cjs) is it, and it runs.

```js
const { connect } = require('inillucent-client');

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

Only the import line differs between the two.

## Reading rows

`query` gives one object per row, keyed by column name:

```js
const people = db.query('SELECT first_name, last_name, email FROM person ORDER BY id');

people[0].first_name;   // 'Ada'
people[0].email;        // 'ada@example.com'
people[1].email;        // null - the column is NULL, and null is not ''
```

`scalar` gives one value, and `execute` gives the whole result with `total`, `more` and `affected`.
[../typescript/README.md](../typescript/README.md) documents all of it: values, parameters,
transactions, errors and the capability table. The API is identical, so everything there applies
here.

## Why this folder has its own tests

The CommonJS entry is a **separate build artifact**. `import.meta.url` has no meaning in CommonJS,
so the code that locates the shared library is compiled differently there, and it is the single
thing most likely to work under `import` and fail under `require`. A test suite that only ever
imported would not notice.

So [`test/commonjs.test.cjs`](test/commonjs.test.cjs) runs the whole conformance suite through
`require()`, and [`test/esm.test.mjs`](test/esm.test.mjs) checks the ES module entry and then asserts
that both entry points report the same driver loaded from the same file.

```sh
npm --prefix javascript install
npm --prefix javascript test
```

## Async

Every call is synchronous. The engine runs a statement whole, so there is nothing to await, and an
async wrapper would add a microtask per row for no gain. Put a long query on a worker thread if it
must not block the event loop.
