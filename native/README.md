# The shared library

Every client library in this repository calls the same C ABI, exported by one
shared library built from the engine:

| Platform | File |
|---|---|
| Windows | `inillucent_driver_capi.dll` |
| Linux | `libinillucent_driver_capi.so` |
| macOS | `libinillucent_driver_capi.dylib` |

`inillucent_driver.h` in this directory is the contract, copied from the engine
so that a C or C++ program can compile against it without cloning the engine.

## Getting it

Build it from the engine checkout:

```
cargo build --release --manifest-path <engine>/Cargo.toml -p inillucent-driver-capi
```

The file lands in `<engine>/target/release/`. Copy it into this directory, or
point `INILLUCENT_DRIVER_LIB` at it. `scripts/fetch-native.mjs` does both:

```
node scripts/fetch-native.mjs               # looks for the engine next to this repo
node scripts/fetch-native.mjs <engine-path> # or say where it is
```

## How each library finds it

The search order is the same in all eight languages, so an application that
works in one works in the rest:

1. `INILLUCENT_DRIVER_LIB` — a full path to the file. This wins whenever it is
   set, and it is how you point a deployment at a copy you ship yourself.
2. `native/` in this repository, for a checkout.
3. The engine's `target/release` and then `target/debug`, for a checkout that
   sits next to the engine.
4. The operating system's own library search path, by plain name.

A library that finds nothing says all four places in the error rather than
`file not found`, because "which of the four did you mean" is the only question
that message otherwise leaves you with.

## The version check

Every library reads `inillucent_abi_version()` on load and refuses a **major**
mismatch by name, before it calls anything else. A minor bump adds symbols and
is accepted; a major bump moves one, and calling a function whose signature has
moved fails in a way nobody can read.
