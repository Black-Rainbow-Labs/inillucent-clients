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

Create a table, insert rows, read them back, and update one.
[`examples/person.py`](examples/person.py) is this program and it runs.

```python
import inillucent

with inillucent.connect("app.rdb") as db:
    db.execute("""
        CREATE TABLE person (
          id         INTEGER PRIMARY KEY,
          first_name TEXT NOT NULL,
          last_name  TEXT NOT NULL,
          email      TEXT,
          age        INTEGER,
          height_m   REAL
        )
    """)

    insert = ("INSERT INTO person (first_name, last_name, email, age, height_m) "
              "VALUES (?1, ?2, ?3, ?4, ?5)")
    db.execute(insert, ["Ada", "Lovelace", "ada@example.com", 36, 1.65])
    db.execute(insert, ["Grace", "Hopper", None, 85, 1.57])

    for person in db.query("SELECT id, first_name, last_name, email, age, height_m "
                           "FROM person ORDER BY id"):
        print(person["id"], person["first_name"], person["last_name"],
              person["email"], person["age"], person["height_m"])

    print("people:", db.scalar("SELECT COUNT(*) FROM person"))

    changed = db.execute("UPDATE person SET email = ?1 WHERE last_name = ?2",
                         ["grace@example.com", "Hopper"])
    print("updated:", changed.affected)
    print("email now:", db.scalar("SELECT email FROM person WHERE last_name = ?1", ["Hopper"]))
```

```
1 Ada Lovelace ada@example.com 36 1.65
2 Grace Hopper None 85 1.57
people: 2
updated: 1
email now: grace@example.com
```

`connect()` opens the file and returns a connection that owns it, so closing the connection closes
the database. Open the two separately when you want more than one connection on one file:

```python
database = inillucent.Database("app.rdb")
first = database.connect()
second = database.connect()
...
database.close()   # closes both connections, then the file
```

## Reading rows

`query()` gives a dict per row, keyed by column name. That is what you want most of the time.

```python
people = db.query("SELECT first_name, last_name, email FROM person ORDER BY id")

people[0]["first_name"]   # 'Ada'
people[0]["last_name"]    # 'Lovelace'
people[0]["email"]        # 'ada@example.com'
people[1]["email"]        # None - the column is NULL, and None is not ''
```

`scalar()` gives the first column of the first row, for a COUNT, a MAX, or one field:

```python
db.scalar("SELECT COUNT(*) FROM person")                                  # 2
db.scalar("SELECT email FROM person WHERE last_name = ?1", ["Lovelace"])  # 'ada@example.com'
```

`execute()` gives the whole result when you need more than the rows:

```python
rows = db.execute("SELECT id, first_name, last_name FROM person ORDER BY id", [], 200)

rows.columns        # ['id', 'first_name', 'last_name']
rows.column_types   # ['INTEGER', 'TEXT', 'TEXT'] - '' for an expression, which has no declared type
rows.rows           # [[1, 'Ada', 'Lovelace'], [2, 'Grace', 'Hopper']]
rows.total          # 2 - how many rows the statement produced
rows.more           # False - whether the limit of 200 left any behind
rows.affected       # None for a query; the row count for a write
rows.tag            # 'SELECT 2'

rows.objects()            # [{'id': 1, 'first_name': 'Ada', ...}, ...]
rows.one()                # the first row, or None
rows.scalar()             # the first column of the first row
rows.column("last_name")  # ['Lovelace', 'Hopper']
```

`total` is counted, not estimated, so a grid can show `1 to 200 of 4,317` and be right.

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
db.execute("SELECT * FROM person WHERE age > ?1 AND last_name LIKE ?2", [40, "L%"])
```

Compile once and run many times with `prepare`:

```python
with db.prepare("INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)") as insert:
    for person in many:
        insert.execute([person.first_name, person.last_name, person.email, person.age, person.height_m])
```

## Transactions

A transaction is an object you hold open. Run the statements, look at how many rows each one
changed, then commit or roll back:

```python
with db.transaction() as txn:
    changed = txn.execute("UPDATE person SET age = age + 1 WHERE last_name = 'Hopper'")
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
