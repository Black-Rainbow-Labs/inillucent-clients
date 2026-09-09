# inillucent, from Java

The [inillucent](https://github.com/jasonmcaffee/inillucent) embedded database, in your process,
through the Foreign Function and Memory API.

**Java 22 or later.** The Foreign Function and Memory API is final in 22, and using it means there
is no JNI shim to build and no C compiler in your build.

## Install

```xml
<dependency>
  <groupId>com.inillucent</groupId>
  <artifactId>inillucent-client</artifactId>
  <version>0.1.0</version>
</dependency>
```

The package has **no dependencies**.

You also need the shared library. See [the shared library](../README.md#the-shared-library).

Run with `--enable-native-access=ALL-UNNAMED` (or name your module) to silence the runtime's warning
about native access.

## A first program

```java
import com.inillucent.*;
import java.util.List;
import java.util.Map;

try (Database database = Database.open("app.rdb");
     Connection connection = database.connect()) {

    connection.execute("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)");
    connection.execute("INSERT INTO authors VALUES (?1, ?2, ?3)",
        List.of(1, "Octavia Butler", 4.8));

    for (Map<String, Object> author
             : connection.query("SELECT id, name, rating FROM authors ORDER BY id")) {
        System.out.println(author.get("id") + " " + author.get("name"));
    }
}
```

`Database` and `Connection` are both `AutoCloseable`. Closing the database closes every connection
on it first, because the C library refuses to close a database that still has connections open, and
freeing it then would leave them pointing at memory that is gone.

To bind a `null`, use `Arrays.asList(...)` rather than `List.of(...)`, which refuses null elements.

## Reading results

`execute()` returns `Rows`. It is materialised and copied into Java, so it outlives the call that
made it.

```java
Rows rows = connection.execute("SELECT id, name FROM authors ORDER BY id", List.of(), 200L);

rows.columns()        // ["id", "name"]
rows.columnTypes()    // ["INTEGER", "TEXT"] — "" for an expression
rows.rows()           // List<List<Object>>
rows.total()          // how many the statement produced, exactly
rows.more()           // whether the limit of 200 cut anything off
rows.affected()       // null for a query; the count for a write
rows.tag()            // "SELECT 2"

rows.objects();           // List<Map<String, Object>>
rows.one();               // the first row, or null
rows.scalar();            // the first column of the first row
rows.get(0, "name");      // one cell, by row and column name
```

`Rows` is `Iterable`, so `for (List<Object> row : rows)` walks the rows.

`query()` is `execute(...).objects()` and `scalar()` is the one value:

```java
connection.query("SELECT id, name FROM authors");
connection.scalar("SELECT COUNT(*) FROM authors");
```

## Values

| SQL | Java |
|---|---|
| `NULL` | `null` |
| `INTEGER` | `Long` |
| `REAL` | `Double` |
| `TEXT` | `String` |
| `BLOB` | `byte[]` |

`null` is `NULL` and is not the empty string. A row keeps its nulls, which is why a row is an
unmodifiable list rather than a `List.copyOf`, since that one throws on a null element.

Binding takes those plus `Boolean`, `Byte`, `Short`, `Integer` and `Float`. Anything else throws
rather than being converted, because converting it would be this library deciding what your value
means.

## Transactions

A transaction is a handle you hold, so what a write did can be checked **before** the commit:

```java
try (Transaction transaction = connection.begin()) {
    long changed = transaction.execute("UPDATE authors SET rating = rating + 0.1");
    if (changed == expected) {
        transaction.commit();
    }
    // leaving the block without committing rolls back
}
```

Closing rolls back, so an early return out of the try with resources undoes its work. A failed
statement rolls the whole transaction back before it throws.

## When the engine refuses

```java
try {
    connection.execute("SOME CONSTRUCT THE ENGINE HAS NOT BUILT");
} catch (UnsupportedFeatureException why) {
    System.out.println("not yet: " + why.feature());
} catch (InillucentException why) {
    System.out.println(why.status() + " " + why.plainMessage() + " at " + why.offset());
}
```

`UnsupportedFeatureException` is a separate type on purpose. The engine refuses what it has not
built rather than answering it wrongly, so an application can say "this engine cannot do that yet"
instead of "check your spelling".

Both are unchecked. A refusal is not something a caller can usefully be forced to handle at every
statement, and the one worth catching is caught by type.

Ask first rather than after:

```java
if (Inillucent.supports("cancel") != Support.YES) {
    // do not draw a Stop button
}

for (Capability capability : Inillucent.capabilities()) {
    System.out.println(capability.name() + " " + capability.support() + " " + capability.note());
}
```

## Threads

One file is one buffer pool and the engine is single threaded. Keep a `Database` and everything
under it on one thread, or serialise every call on it with a lock of your own. There is no lock
inside. Two databases on two files are independent.

## Running the tests

The conformance runner is a `main` method with its own small JSON reader, so running the suite needs
nothing on the classpath but this client:

```sh
javac -d java/out/classes --release 22 $(find java/src -name '*.java')
java --enable-native-access=ALL-UNNAMED \
     -Dinillucent.repository=$(pwd) \
     -cp java/out/classes \
     com.inillucent.ConformanceTest
```

`com.inillucent.Quickstart` in the same folder runs the example above.

`node ../scripts/test-all.mjs` does both steps for you.

It runs [`conformance/suite.json`](../conformance/suite.json), the same file the engine's own Rust
driver runs.
