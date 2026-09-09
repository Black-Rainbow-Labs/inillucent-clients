# inillucent, from Python

The [inillucent](https://github.com/jasonmcaffee/inillucent) embedded database, in your process.
`ctypes` and the standard library, so there is nothing to compile and nothing to install but this.

## Install

```sh
pip install inillucent-client
```

From a checkout of this repository:

```sh
pip install -e python
```

You also need the shared library. See [the shared library](../README.md#the-shared-library) — build
it once with cargo and run `node scripts/fetch-native.mjs`, or point `INILLUCENT_DRIVER_LIB` at a
copy you ship yourself.

## A first program

```python
import inillucent

with inillucent.connect("app.rdb") as db:
    db.execute("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)")
    db.execute("INSERT INTO authors VALUES (?1, ?2, ?3)", [1, "Octavia Butler", 4.8])
    db.execute("INSERT INTO authors VALUES (?1, ?2, ?3)", [2, "Ursula Le Guin", None])

    for author in db.query("SELECT id, name, rating FROM authors ORDER BY id"):
        print(author["id"], author["name"], author["rating"])
```

`connect()` opens the file and hands back a connection that owns it, so closing the connection
closes the database. Open the two separately when you want more than one connection on one file:

```python
database = inillucent.Database("app.rdb")
first = database.connect()
second = database.connect()
...
database.close()   # closes both connections, then the file
```

## Reading results

`execute()` returns a `Rows`. It is materialised and copied into Python, so it stays usable after
the call that made it.

```python
rows = db.execute("SELECT id, name FROM authors ORDER BY id", [], 200)

rows.columns        # ['id', 'name']
rows.column_types   # ['INTEGER', 'TEXT'] — '' for an expression, which has no declared type
rows.rows           # [[1, 'Octavia Butler'], [2, 'Ursula Le Guin']]
rows.total          # how many the statement produced, exactly
rows.more           # whether the limit of 200 cut anything off
rows.affected       # None for a query; the count for a write
rows.tag            # 'SELECT 2'

rows.objects()      # [{'id': 1, 'name': 'Octavia Butler'}, ...]
rows.one()          # the first row, or None
rows.scalar()       # the first column of the first row
rows.column("name") # ['Octavia Butler', 'Ursula Le Guin']
```

`query()` is `execute(...).objects()` and `scalar()` is the one value, because unwrapping a `COUNT`
out of two lists is a cost you would otherwise pay on every line:

```python
db.query("SELECT id, name FROM authors")     # list of dicts
db.scalar("SELECT COUNT(*) FROM authors")    # 2
```

## Values

| SQL | Python |
|---|---|
| `NULL` | `None` |
| `INTEGER` | `int` |
| `REAL` | `float` |
| `TEXT` | `str` |
| `BLOB` | `bytes` |

`None` is `NULL` and is not the empty string. `bool` binds as an integer, because it is a subclass
of `int` and binding `True` as text would be a quietly different value. Anything else raises rather
than being converted, because converting it would be this library deciding what your value means.

## Parameters

Parameters are `?1`, `?2` and so on, bound in order and never pasted into the text:

```python
db.execute("SELECT * FROM authors WHERE rating > ?1 AND name LIKE ?2", [4.0, "O%"])
```

Compile once and run many times with `prepare`:

```python
with db.prepare("INSERT INTO authors VALUES (?1, ?2, ?3)") as insert:
    for author in many:
        insert.execute([author.id, author.name, author.rating])
```

## Transactions

A transaction is a handle you hold, so what a write did can be checked **before** the commit:

```python
with db.transaction() as txn:
    changed = txn.execute("UPDATE authors SET rating = rating + 0.1 WHERE rating IS NOT NULL")
    if changed != expected:
        txn.rollback()          # or just raise; the context manager rolls back
```

Used as a context manager it commits on a clean exit and rolls back on an exception. A failed
statement rolls the whole transaction back before it raises, so a caller that stops at the first
error has already undone everything.

## When the engine refuses

```python
try:
    db.execute("SOME CONSTRUCT THE ENGINE HAS NOT BUILT")
except inillucent.UnsupportedError as why:
    print("not yet:", why.feature)
except inillucent.InillucentError as why:
    print(why.status_name, why.message, why.offset)
```

`UnsupportedError` is a separate type on purpose. The engine refuses what it has not built rather
than answering it wrongly, so an application can say "this engine cannot do that yet" instead of
"check your spelling".

Ask first rather than after:

```python
if inillucent.supports("cancel") != inillucent.SUPPORT_YES:
    ...  # do not draw a Stop button

for capability in inillucent.capabilities():
    print(capability.name, capability.support_name, capability.note)
```

## The database itself

```python
database.path                # the file it is in
database.checkpoint()        # make everything written so far durable
database.integrity_check()   # walk every tree and raise on the first thing wrong
database.backup_to("copy.rdb")   # copies, then opens and checks the copy
```

`backup_to` checks the copy before returning, because a backup nobody checked is a file that is
assumed to be a database.

## Threads

One file is one buffer pool and the engine is single threaded. Keep a `Database` and everything
under it on one thread, or serialise every call on it with a lock of your own. There is no lock
inside. Two databases on two files are independent.

## Running the tests

```sh
PYTHONPATH=python/src python python/tests/conformance.py
```

It runs [`conformance/suite.json`](../conformance/suite.json), the same file the engine's own Rust
driver runs.
