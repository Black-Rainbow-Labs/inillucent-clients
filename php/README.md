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
composer require inillucent/client
```

From a checkout of this repository, `php/autoload.php` registers the classes without Composer, which
is what lets the examples and the conformance runner work straight out of the box.

You also need the shared library. See [the shared library](../README.md#the-shared-library).

## A first program

Create a table, insert rows, read them back, and update one.
[`examples/person.php`](examples/person.php) is this program and it runs.

```php
<?php

use Inillucent\Database;

$database = Database::open('app.rdb');
$connection = $database->connect();

$connection->execute('CREATE TABLE person (
      id         INTEGER PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name  TEXT NOT NULL,
      email      TEXT,
      age        INTEGER,
      height_m   REAL
    )');

$insert = 'INSERT INTO person (first_name, last_name, email, age, height_m)'
    . ' VALUES (?1, ?2, ?3, ?4, ?5)';
$connection->execute($insert, ['Ada', 'Lovelace', 'ada@example.com', 36, 1.65]);
$connection->execute($insert, ['Grace', 'Hopper', null, 85, 1.57]);

$people = $connection->query(
    'SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id'
);
foreach ($people as $person) {
    echo $person['id'], ' ', $person['first_name'], ' ', $person['last_name'], ' ',
        $person['email'] ?? 'NULL', ' ', $person['age'], ' ', $person['height_m'], PHP_EOL;
}

echo 'people: ', $connection->scalar('SELECT COUNT(*) FROM person'), PHP_EOL;

$changed = $connection->execute(
    'UPDATE person SET email = ?1 WHERE last_name = ?2',
    ['grace@example.com', 'Hopper']
);
echo 'updated: ', $changed->affected, PHP_EOL;

$connection->close();
$database->close();
```

```
1 Ada Lovelace ada@example.com 36 1.65
2 Grace Hopper NULL 85 1.57
people: 2
updated: 1
email now: grace@example.com
```

`close()` on the database closes every connection on it first, because the C library refuses to
close a database that still has connections open.

## Reading rows

`query()` gives an array per row, keyed by column name. That is what you want most of the time.

```php
$people = $connection->query('SELECT first_name, last_name, email FROM person ORDER BY id');

$people[0]['first_name'];   // 'Ada'
$people[0]['last_name'];    // 'Lovelace'
$people[1]['email'];        // null - the column is NULL, and null is not ''
```

`scalar()` gives the first column of the first row, for a COUNT, a MAX, or one field:

```php
$connection->scalar('SELECT COUNT(*) FROM person');                                  // 2
$connection->scalar('SELECT email FROM person WHERE last_name = ?1', ['Lovelace']);
```

`execute()` gives the whole result when you need more than the rows:

```php
$rows = $connection->execute('SELECT id, first_name FROM person ORDER BY id', [], 200);

$rows->columns;       // ['id', 'first_name']
$rows->columnTypes;   // ['INTEGER', 'TEXT'] - '' for an expression
$rows->rows;          // [[1, 'Ada'], [2, 'Grace']]
$rows->total;         // 2 - how many rows the statement produced
$rows->more;          // false - whether the limit of 200 left any behind
$rows->affected;      // null for a query; the row count for a write

$rows->objects();            // [['id' => 1, 'first_name' => 'Ada'], ...]
$rows->one();                // the first row, or null
$rows->scalar();             // the first column of the first row
$rows->get(0, 'last_name');  // one cell, by row and column name
count($rows);                // how many rows were handed back
```

`total` is counted, not estimated, so a grid can show `1 to 200 of 4,317` and be right. `Rows` is
`IteratorAggregate` and `Countable`, so `foreach` and `count()` both work.

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
$connection->execute('SELECT * FROM person WHERE age > ?1 AND last_name LIKE ?2', [40, 'L%']);
```

Compile once and run many times with `prepare`:

```php
$insert = $connection->prepare('INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)');
try {
    foreach ($many as $person) {
        $insert->execute([$person->firstName, $person->lastName, $person->email, $person->age, $person->heightM]);
    }
} finally {
    $insert->close();
}
```

## Transactions

A transaction is an object you hold open. Run the statements, look at how many rows each one
changed, then commit or roll back:

```php
$transaction = $connection->begin();
$changed = $transaction->execute('UPDATE person SET age = age + 1');
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
