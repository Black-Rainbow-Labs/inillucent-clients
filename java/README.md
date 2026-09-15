# inillucent, from Java

The [inillucent](https://github.com/Black-Rainbow-Labs/Inillucent) embedded database, in your process,
through the Foreign Function and Memory API.

**Java 22 or later**, where the Foreign Function and Memory API is final. There is no JNI shim to
build.

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

Create a table, insert rows, read them back, and update one.
[`Person.java`](src/test/java/com/inillucent/Person.java) is this program and it runs.

```java
try (Database database = Database.open("app.rdb");
     Connection connection = database.connect()) {

    connection.execute("""
        CREATE TABLE person (
          id         INTEGER PRIMARY KEY,
          first_name TEXT NOT NULL,
          last_name  TEXT NOT NULL,
          email      TEXT,
          age        INTEGER,
          height_m   REAL
        )""");

    String insert = "INSERT INTO person (first_name, last_name, email, age, height_m)"
        + " VALUES (?1, ?2, ?3, ?4, ?5)";
    connection.execute(insert, List.of("Ada", "Lovelace", "ada@example.com", 36, 1.65));
    // Arrays.asList rather than List.of, because List.of refuses a null.
    connection.execute(insert, Arrays.asList("Grace", "Hopper", null, 85, 1.57));

    for (Map<String, Object> person : connection.query(
            "SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id")) {
        System.out.println(person.get("id") + " " + person.get("first_name") + " "
            + person.get("last_name") + " " + person.get("email") + " "
            + person.get("age") + " " + person.get("height_m"));
    }

    System.out.println("people: " + connection.scalar("SELECT COUNT(*) FROM person"));

    Rows changed = connection.execute("UPDATE person SET email = ?1 WHERE last_name = ?2",
        List.of("grace@example.com", "Hopper"));
    System.out.println("updated: " + changed.affected());
}
```

```
1 Ada Lovelace ada@example.com 36 1.65
2 Grace Hopper null 85 1.57
people: 2
updated: 1
email now: grace@example.com
```

`Database` and `Connection` are both `AutoCloseable`. Closing the database closes every connection on
it first, because the C library refuses to close a database that still has connections open.

## Reading rows

`query()` gives a `Map<String, Object>` per row, keyed by column name. That is what you want most of
the time.

```java
List<Map<String, Object>> people =
    connection.query("SELECT first_name, last_name, email FROM person ORDER BY id");

people.get(0).get("first_name");   // "Ada"
people.get(0).get("last_name");    // "Lovelace"
people.get(1).get("email");        // null - the column is NULL, and null is not ""

// Read one out as the type it is.
String first = (String) people.get(0).get("first_name");
Long age = (Long) people.get(0).get("age");
```

`scalar()` gives the first column of the first row, for a COUNT, a MAX, or one field:

```java
connection.scalar("SELECT COUNT(*) FROM person");                                     // 2L
connection.scalar("SELECT email FROM person WHERE last_name = ?1", List.of("Lovelace"));
```

`execute()` gives the whole result when you need more than the rows:

```java
Rows rows = connection.execute("SELECT id, first_name FROM person ORDER BY id", List.of(), 200L);

rows.columns()        // ["id", "first_name"]
rows.columnTypes()    // ["INTEGER", "TEXT"] - "" for an expression
rows.rows()           // List<List<Object>>
rows.total()          // 2 - how many rows the statement produced
rows.more()           // false - whether the limit of 200 left any behind
rows.affected()       // null for a query; the row count for a write

rows.objects();           // List<Map<String, Object>>
rows.one();               // the first row, or null
rows.scalar();            // the first column of the first row
rows.get(0, "last_name"); // one cell, by row and column name
```

`total()` is counted, not estimated, so a grid can show `1 to 200 of 4,317` and be right. `Rows` is
`Iterable`, so `for (List<Object> row : rows)` walks the rows.

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

A transaction is an object you hold open. Run the statements, look at how many rows each one
changed, then commit or roll back:

```java
try (Transaction transaction = connection.begin()) {
    long changed = transaction.execute("UPDATE person SET age = age + 1");
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
