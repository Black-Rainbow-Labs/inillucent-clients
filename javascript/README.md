# inillucent, from JavaScript

The [inillucent](https://github.com/jasonmcaffee/inillucent) embedded database, in your process,
from plain JavaScript.

**This is the same npm package as [../typescript](../typescript), not a second implementation.**
`inillucent` is written in TypeScript and published with three things beside each other: an ES module
entry, a CommonJS entry, and type declarations. A JavaScript project installs that one package, calls
it with `import` or with `require`, and gets editor completion from the declarations without writing
any types itself. Shipping a second, untyped copy of the same binding would be a second thing to keep
correct and would give a JavaScript caller nothing.

What lives here is the JavaScript side of that: runnable examples in both module systems, and the
tests that hold the CommonJS entry to the same standard as the ES module one.

## Install

```sh
npm install inillucent
```

You also need the shared library. See [the shared library](../README.md#the-shared-library).

## ES modules

```js
import { connect } from 'inillucent';

const db = connect('app.rdb');

db.execute('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)');
db.execute('INSERT INTO note (body) VALUES (?1)', ['hello']);

for (const note of db.query('SELECT id, body FROM note')) {
  console.log(note.id, note.body);
}

db.close();
```

[`examples/quickstart.mjs`](examples/quickstart.mjs) is the longer form.

## CommonJS

```js
const { connect } = require('inillucent');

const db = connect('app.rdb');

db.execute('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)');
db.execute('INSERT INTO note (body) VALUES (?1)', ['hello']);

for (const note of db.query('SELECT id, body FROM note')) {
  console.log(note.id, note.body);
}

db.close();
```

[`examples/quickstart.cjs`](examples/quickstart.cjs) is the longer form. The API is identical; only
the import line differs.

## The API

It is the same in both, and [../typescript/README.md](../typescript/README.md) documents all of it:
values, results, parameters, transactions, refusals and the capability table. The short version:

- **`connect(path)`** opens the file and hands back a connection that owns it.
- **`db.execute(sql, params, limit)`** returns `Rows`, with an exact `total` beside the rows a
  `limit` handed back.
- **`db.query(sql, params)`** is the same thing as objects keyed by column name.
- **`db.scalar(sql, params)`** is the first column of the first row.
- **`db.transaction()`** is a handle you hold, so a write can be checked before the commit.
- **`null` is `NULL`**, and it is not the empty string.
- **`UnsupportedError`** is its own type, and `why.feature` names the construct the engine has not
  built.

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
