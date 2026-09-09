# inillucent client libraries

Client libraries for [inillucent](https://github.com/jasonmcaffee/inillucent), an embedded database
written in Rust, in eight languages.

There is no server. Your program opens a file, sends SQL to a library in the same process, and gets
typed rows back.

```python
import inillucent

with inillucent.connect("app.rdb") as db:
    db.execute("CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)")
    db.execute("INSERT INTO note (body) VALUES (?1)", ["hello"])
    for row in db.query("SELECT id, body FROM note"):
        print(row["id"], row["body"])
```

---

## The eight

| | Install | Calls the ABI through | Needs a C compiler |
|---|---|---|---|
| [TypeScript](typescript/) | `npm install inillucent-client` | koffi | no |
| [JavaScript](javascript/) | `npm install inillucent-client` | the same package, CommonJS or ESM | no |
| [Python](python/) | `pip install inillucent-client` | ctypes, standard library only | no |
| [Rust](rust/) | `cargo add inillucent-client` | libloading | no |
| [Go](go/) | `go get github.com/jasonmcaffee/inillucent-clients/go` | purego, so cgo stays off | no |
| [Java](java/) | `com.inillucent:inillucent-client`, Java 22 or later | the Foreign Function and Memory API | no |
| [C#](csharp/) | `dotnet add package Inillucent.Client` | `DllImport` with a resolver | no |
| [PHP](php/) | `composer require inillucent/client` | the FFI extension | no |

Each folder has its own README with the installation, a worked example, and the API in that
language's own idiom.

**No client needs a C compiler to install.** That was a constraint rather than a coincidence: a
database client that only installs where a toolchain is already set up is a client most people
cannot install.

### Nothing is published yet

**The install lines above are the names these packages will have. None of them is on npm, PyPI,
crates.io, Maven Central, NuGet or Packagist today**, so running one of those commands right now
fails. Until they are published, use the client from a checkout of this repository — each language's
README says how, and `node scripts/test-all.mjs` proves all eight work from a checkout.

The client is `inillucent-client` and not `inillucent` because **the engine already uses
`inillucent`** for its command line tool on npm and on PyPI. Two different things under one name is
the mistake that is expensive to undo after the first publish rather than before it.

---

## What every client agrees on

The eight are not eight designs. They are eight spellings of one, and these four are the parts worth
knowing before you read any of them.

**Values stay typed.** `NULL`, integer, real, text and bytes arrive as the nearest thing the host
language has, and `NULL` is never the empty string. A layer that drew them the same is a layer
nobody can trust. In PHP, where one string type covers both text and bytes, a blob arrives as a
`Blob` for the same reason.

**`total` is exact.** A limit caps the rows handed back; `total` says how many the statement
produced, counted rather than estimated, and `more` says whether the limit cut anything off. That is
what lets a grid say `1 to 200 of 4,317` and mean it. The cost is that a query over a large table
costs what the whole result costs, so put a `LIMIT` in your own SQL when you cannot afford that,
where the planner can act on it.

**A transaction is a handle you hold.** It is not a pair of calls, because the check on what a write
did has to happen before the commit. A postcondition tested afterwards is a report about something
that has already happened.

**A refusal names what it refused.** This engine is deliberately incomplete in places and refuses
what it has not built rather than answering it wrongly, so "not implemented" is a status of its own
and a separate exception type in every client. An application can say "this engine cannot do that
yet" instead of "check your spelling", and `capabilities()` answers before you compose a statement
rather than after.

```ts
import { supports, Support } from 'inillucent-client';

if (supports('cancel') !== Support.Yes) {
  // do not draw a Stop button
}
```

An unknown capability name answers `unknown`, and you should treat that as no rather than as yes: a
capability that was never declared was certainly never checked.

---

## How correctness is decided

Every client is graded by [`conformance/suite.json`](conformance/suite.json), which is the driver's
behaviour written as data rather than as prose. It is the same file the engine's own Rust driver
runs, so a client here is correct in the sense that it **agrees with the engine**, not in the sense
that somebody wrote tests for it.

```
$ node scripts/test-all.mjs
inillucent client libraries, conformance in every language

  ok    python      ctypes
  ok    typescript  koffi
  ok    javascript  the same package, both module systems
  ok    rust        libloading
  ok    go          purego
  ok    java        the Foreign Function and Memory API
  ok    csharp      DllImport
  ok    php         the FFI extension

8 of 8 clients pass
```

A language whose toolchain is not on the machine is reported as **skipped**, never as passing.

That the suite is shared rather than per language is not a tidiness argument. It found a real defect
in two clients while they were being written, and both had the same cause: the C ABI reads a null
value pointer as `NULL`, deliberately, and both koffi and Go hand a zero length buffer across as a
null pointer. So binding `''` stored `NULL` instead of the empty string, in two languages at once.
The case that caught it is called `null_is_not_the_empty_string`. A test suite written per client
would have carried the same wrong assumption into the test.

---

## The shared library

Every client calls one shared library, built from the engine:

| Platform | File |
|---|---|
| Windows | `inillucent_driver_capi.dll` |
| Linux | `libinillucent_driver_capi.so` |
| macOS | `libinillucent_driver_capi.dylib` |

Build it from an engine checkout and copy it into `native/`:

```sh
cargo build --release --manifest-path <engine>/Cargo.toml -p inillucent-driver-capi
node scripts/fetch-native.mjs
```

Every client looks for it in the same four places, in this order, so an application that works in
one language works in the rest:

1. **`INILLUCENT_DRIVER_LIB`** — a full path. This wins whenever it is set, and it is how a
   deployment points at a copy it ships itself.
2. **`native/`** in this repository, for a checkout.
3. The engine's `target/release` then `target/debug`, for a checkout beside the engine.
4. The operating system's own library search path.

A client that finds nothing names all four places in the error rather than saying file not found,
because "which of the four did you mean" is the only question that message otherwise leaves you
with.

Every client also reads `inillucent_abi_version()` at load and refuses a **major** mismatch by name,
before it calls anything else. A minor bump adds symbols and is accepted; a major bump moves one,
and calling a function whose signature has moved does not fail in a way anybody can read.

[`native/inillucent_driver.h`](native/inillucent_driver.h) is the contract, copied from the engine so
a C or C++ program can compile against it without cloning the engine.

---

## Running the tests

`node scripts/test-all.mjs` runs all eight. One at a time:

| | |
|---|---|
| Python | `python python/tests/conformance.py` (with `PYTHONPATH=python/src`) |
| TypeScript | `npm --prefix typescript test` |
| JavaScript | `npm --prefix javascript test` |
| Rust | `cargo test --manifest-path rust/Cargo.toml` |
| Go | `go test ./...` in `go/` |
| Java | `javac` the sources, then `java com.inillucent.ConformanceTest` — see [java/README.md](java/README.md) |
| C# | `dotnet run` in `csharp/test/Inillucent.Conformance` |
| PHP | `php php/tests/conformance.php` |

Each one prints a line per case and exits non zero on a disagreement.

---

## Writing a ninth

The C ABI is documented in the engine repository, in
[`drivers/README.md`](https://github.com/jasonmcaffee/inillucent/blob/main/drivers/README.md), and
that file plus the header is meant to be enough on its own. The shape is the same every time: check
the ABI major at load, wrap each opaque pointer in the host language's own resource type, check the
status after every call that takes an error out parameter and free the error in a `finally`, map
"unsupported" to its own type, copy every string on the way out, and then run the suite.

The clients here are ordered by how little machinery they need, so read
[Python](python/src/inillucent/) first: it is `ctypes` and nothing else.

---

## Licence

MIT. See [LICENSE](LICENSE).
