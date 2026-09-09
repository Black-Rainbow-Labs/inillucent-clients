# inillucent, from PHP

The [inillucent](https://github.com/jasonmcaffee/inillucent) embedded database, in your process,
through the FFI extension.

**PHP 8.1 or later, with `ext-ffi`.** FFI is off in most default builds, so add this to `php.ini`:

```ini
extension=ffi
ffi.enable=true
```

## Install

```sh
composer require inillucent/inillucent
```

From a checkout of this repository, `php/autoload.php` registers the classes without Composer, which
is what lets the examples and the conformance runner work straight out of the box.

You also need the shared library. See [the shared library](../README.md#the-shared-library).

## A first program

```php
<?php

use Inillucent\Database;

$database = Database::open('app.rdb');
$connection = $database->connect();

$connection->execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)');
$connection->execute('INSERT INTO authors VALUES (?1, ?2, ?3)', [1, 'Octavia Butler', 4.8]);
$connection->execute('INSERT INTO authors VALUES (?1, ?2, ?3)', [2, 'Ursula Le Guin', null]);

foreach ($connection->query('SELECT id, name, rating FROM authors ORDER BY id') as $author) {
    echo $author['id'], ' ', $author['name'], PHP_EOL;
}

$connection->close();
$database->close();
```

`close()` on the database closes every connection on it first, because the C library refuses to
close a database that still has connections open, and freeing it then would leave them pointing at
memory that is gone.

## Reading results

`execute()` returns a `Rows`. It is materialised and copied into PHP, so it outlives the call that
made it.

```php
$rows = $connection->execute('SELECT id, name FROM authors ORDER BY id', [], 200);

$rows->columns;       // ['id', 'name']
$rows->columnTypes;   // ['INTEGER', 'TEXT'] — '' for an expression
$rows->rows;          // [[1, 'Octavia Butler'], [2, 'Ursula Le Guin']]
$rows->total;         // how many the statement produced, exactly
$rows->more;          // whether the limit of 200 cut anything off
$rows->affected;      // null for a query; the count for a write
$rows->tag;           // 'SELECT 2'

$rows->objects();          // [['id' => 1, 'name' => 'Octavia Butler'], ...]
$rows->one();              // the first row, or null
$rows->scalar();           // the first column of the first row
$rows->get(0, 'name');     // one cell, by row and column name
count($rows);              // how many rows were handed back
```

`Rows` is `IteratorAggregate` and `Countable`, so `foreach` and `count()` both work.

`query()` is `execute(...)->objects()` and `scalar()` is the one value:

```php
$connection->query('SELECT id, name FROM authors');
$connection->scalar('SELECT COUNT(*) FROM authors');
```

## Values, and why blobs are their own type

| SQL | PHP |
|---|---|
| `NULL` | `null` |
| `INTEGER` | `int` |
| `REAL` | `float` |
| `TEXT` | `string` |
| `BLOB` | `Inillucent\Blob` |

`null` is `NULL` and it is not the empty string.

PHP has one string type for text and for bytes. A client that returned both as a plain string would
throw away which one the engine holds, for the same reason `NULL` and `''` must stay apart: they are
different facts about a row. So a blob comes back as a `Blob`, and binding one stores bytes while
binding a plain string stores text.

```php
use Inillucent\Blob;

$connection->execute('INSERT INTO files VALUES (?1, ?2)', ['avatar.png', new Blob($bytes)]);

$row = $connection->execute('SELECT body FROM files')->scalar();
$row->bytes;      // the raw bytes
$row->length();   // how many
(string) $row;    // the bytes again, for a caller that wants the plain string
```

## Parameters

Parameters are `?1`, `?2` and so on, bound in order and never pasted into the text:

```php
$connection->execute('SELECT * FROM authors WHERE rating > ?1 AND name LIKE ?2', [4.0, 'O%']);
```

Compile once and run many times with `prepare`:

```php
$insert = $connection->prepare('INSERT INTO authors VALUES (?1, ?2, ?3)');
try {
    foreach ($many as $author) {
        $insert->execute([$author->id, $author->name, $author->rating]);
    }
} finally {
    $insert->close();
}
```

## Transactions

A transaction is a handle you hold, so what a write did can be checked **before** the commit:

```php
$transaction = $connection->begin();
$changed = $transaction->execute('UPDATE authors SET rating = rating + 0.1');
if ($changed === $expected) {
    $transaction->commit();
} else {
    $transaction->rollback();
}
```

A transaction that goes out of scope without a commit rolls back in its destructor. A failed
statement rolls the whole transaction back before it throws.

## When the engine refuses

```php
use Inillucent\InillucentException;
use Inillucent\UnsupportedFeatureException;

try {
    $connection->execute('SOME CONSTRUCT THE ENGINE HAS NOT BUILT');
} catch (UnsupportedFeatureException $why) {
    echo 'not yet: ', $why->feature, PHP_EOL;
} catch (InillucentException $why) {
    echo $why->status->label(), ' ', $why->plainMessage, ' at byte ', $why->offset, PHP_EOL;
}
```

`UnsupportedFeatureException` is a separate type on purpose. The engine refuses what it has not
built rather than answering it wrongly, so an application can say "this engine cannot do that yet"
instead of "check your spelling".

Ask first rather than after:

```php
use Inillucent\Driver;
use Inillucent\Support;

if (Driver::supports('cancel') !== Support::Yes) {
    // do not draw a Stop button
}

foreach (Driver::capabilities() as $capability) {
    echo $capability->name, ' ', $capability->support->label(), ' ', $capability->note, PHP_EOL;
}
```

## Processes

One file is one buffer pool and the engine is single threaded. Keep a `Database` and everything
under it in one process. Two databases on two files are independent.

## Running the tests

```sh
php php/tests/conformance.php
php php/examples/quickstart.php
```

It runs [`conformance/suite.json`](../conformance/suite.json), the same file the engine's own Rust
driver runs.
