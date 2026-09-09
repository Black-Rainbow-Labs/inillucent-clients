//! The Inillucent client for Rust.
//!
//! Inillucent is an embedded database written in Rust. There is no server: your
//! program opens a file, sends SQL to a library in the same process, and gets
//! typed rows back.
//!
//! ```no_run
//! use inillucent::{Database, Value};
//!
//! let database = Database::open("library.rdb")?;
//! let connection = database.connect()?;
//!
//! connection.run("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)")?;
//! connection.execute(
//!     "INSERT INTO authors VALUES (?1, ?2)",
//!     &[Value::Integer(1), Value::from("Octavia Butler")],
//!     None,
//! )?;
//!
//! let rows = connection.run("SELECT id, name FROM authors")?;
//! println!("{} of {}", rows.len(), rows.total);
//! # Ok::<(), inillucent::Error>(())
//! ```
//!
//! # Which Rust crate to use
//!
//! This crate loads the driver's C ABI at runtime with `libloading`, the same as
//! the other seven clients in this repository. That is what you want when the
//! shared library ships beside your program, or when you would rather not build
//! the engine to build your application.
//!
//! If your project can depend on the engine's own source, use `inillucent-driver`
//! from the engine repository instead. It is the same driver without the C ABI in
//! the middle, so it keeps the type system across the seam and costs no pointer
//! round trip per call.
//!
//! # Two things that shape the whole API
//!
//! Values stay typed. [`Value`] is `Null`, `Integer`, `Real`, `Text` or `Blob`,
//! and `Null` is a variant rather than an empty string.
//!
//! The engine refuses what it has not built rather than answering it wrongly.
//! That refusal arrives as [`Status::Unsupported`] with [`Error::feature`]
//! naming the construct, and [`supports`] answers before you compose a
//! statement rather than after.

mod capability;
mod database;
mod error;
mod ffi;
mod value;

pub use capability::{abi_version, capabilities, driver_path, supports, version, Capability, Support};
pub use database::{
    Connection, Database, OpenOptions, Statement, Transaction, OPEN_CREATE, OPEN_DIAGNOSTICS,
    OPEN_READONLY,
};
pub use error::{Error, LoadError, Result, Status};
pub use ffi::{search_paths, ABI_MAJOR};
pub use value::{Rows, Value};
