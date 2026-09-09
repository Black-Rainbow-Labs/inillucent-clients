//! Finding the shared library, loading it once, checking its ABI, and holding
//! every symbol this crate calls.
//!
//! Handles cross as `*mut c_void` because nothing here ever reads through one.

use std::env;
use std::ffi::{c_char, c_double, c_int, c_void, CStr};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use libloading::{Library, Symbol};

use crate::error::LoadError;

/// The ABI this crate was written against. Only the major has to match: a minor
/// bump adds symbols, a major bump moves one.
pub const ABI_MAJOR: u32 = 1;

/// Returns the shared library file names this platform uses.
fn library_names() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &["inillucent_driver_capi.dll"]
    }
    #[cfg(target_os = "macos")]
    {
        &["libinillucent_driver_capi.dylib"]
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        &["libinillucent_driver_capi.so"]
    }
}

/// Returns every place the shared library is looked for, in order.
///
/// The order is the same in all eight client libraries, so an application that
/// works in one works in the rest.
pub fn search_paths() -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(named) = env::var("INILLUCENT_DRIVER_LIB") {
        if !named.is_empty() {
            found.push(PathBuf::from(named));
        }
    }
    // CARGO_MANIFEST_DIR is <clients>/rust at build time, so the repository root
    // is one up and an engine checkout beside it is two.
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo = crate_dir.parent().unwrap_or(crate_dir);
    let engines = [
        repo.parent().map(|up| up.join("inillucent")),
        repo.parent().and_then(|up| up.parent()).map(|up| up.join("inillucent")),
    ];
    for name in library_names() {
        found.push(repo.join("native").join(name));
        for engine in engines.iter().flatten() {
            for profile in ["release", "debug"] {
                found.push(engine.join("target").join(profile).join(name));
            }
        }
    }
    found
}

/// Returns the path of the shared library, or an error saying where it looked.
///
/// A message that names every place it tried is the difference between a problem
/// somebody can fix and one they have to guess at.
pub fn resolve_library() -> Result<PathBuf, LoadError> {
    for candidate in search_paths() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let looked = search_paths()
        .iter()
        .map(|path| format!("  {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(LoadError(format!(
        "cannot find the inillucent driver shared library. Looked in:\n{looked}\n\
         Build it with\n  cargo build --release --manifest-path <engine>/Cargo.toml \
         -p inillucent-driver-capi\nthen run scripts/fetch-native.mjs, or set \
         INILLUCENT_DRIVER_LIB to its path."
    )))
}

/// Every symbol the crate calls, resolved once at load.
///
/// They are held as raw function pointers rather than as `Symbol` values so the
/// table is `Send` and `Sync`. Each one points into `_library`, which is kept
/// alive in the same struct and never unloaded.
pub struct Driver {
    pub path: PathBuf,
    _library: Library,

    pub abi_version: unsafe extern "C" fn() -> u32,
    pub version: unsafe extern "C" fn() -> *const c_char,
    pub capability_count: unsafe extern "C" fn() -> usize,
    pub capability: unsafe extern "C" fn(usize, *mut *const c_char, *mut i32, *mut *const c_char) -> i32,
    pub supports: unsafe extern "C" fn(*const c_char) -> i32,

    pub open: unsafe extern "C" fn(*const c_char, u32, *mut *mut c_void, *mut *mut c_void) -> i32,
    pub close: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> i32,
    pub checkpoint: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> i32,
    pub integrity_check: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> i32,
    pub backup_to: unsafe extern "C" fn(*mut c_void, *const c_char, *mut *mut c_void) -> i32,
    pub path_of: unsafe extern "C" fn(*const c_void) -> *const c_char,

    pub connect: unsafe extern "C" fn(*mut c_void, *mut *mut c_void, *mut *mut c_void) -> i32,
    pub conn_free: unsafe extern "C" fn(*mut c_void),
    pub execute: unsafe extern "C" fn(*mut c_void, *const c_char, u64, *mut *mut c_void, *mut *mut c_void) -> i32,
    pub execute_batch: unsafe extern "C" fn(*mut c_void, *const c_char, *mut *mut c_void) -> i32,
    pub last_insert_rowid: unsafe extern "C" fn(*mut c_void) -> i64,
    pub total_changes: unsafe extern "C" fn(*mut c_void) -> i64,
    pub in_transaction: unsafe extern "C" fn(*mut c_void) -> i32,
    pub schema_cookie: unsafe extern "C" fn(*mut c_void) -> u64,
    pub cancel: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> i32,

    pub prepare: unsafe extern "C" fn(*mut c_void, *const c_char, *mut *mut c_void, *mut *mut c_void) -> i32,
    pub stmt_free: unsafe extern "C" fn(*mut c_void),
    pub bind_null: unsafe extern "C" fn(*mut c_void, u32) -> i32,
    pub bind_int: unsafe extern "C" fn(*mut c_void, u32, i64) -> i32,
    pub bind_real: unsafe extern "C" fn(*mut c_void, u32, c_double) -> i32,
    pub bind_text: unsafe extern "C" fn(*mut c_void, u32, *const c_char, usize) -> i32,
    pub bind_blob: unsafe extern "C" fn(*mut c_void, u32, *const u8, usize) -> i32,
    pub clear_bindings: unsafe extern "C" fn(*mut c_void),
    pub stmt_execute: unsafe extern "C" fn(*mut c_void, u64, *mut *mut c_void, *mut *mut c_void) -> i32,

    pub rows_free: unsafe extern "C" fn(*mut c_void),
    pub rows_column_count: unsafe extern "C" fn(*const c_void) -> usize,
    pub rows_column_name: unsafe extern "C" fn(*const c_void, usize) -> *const c_char,
    pub rows_column_type: unsafe extern "C" fn(*const c_void, usize) -> *const c_char,
    pub rows_count: unsafe extern "C" fn(*const c_void) -> usize,
    pub rows_total: unsafe extern "C" fn(*const c_void) -> usize,
    pub rows_more: unsafe extern "C" fn(*const c_void) -> i32,
    pub rows_affected: unsafe extern "C" fn(*const c_void) -> i64,
    pub rows_elapsed_us: unsafe extern "C" fn(*const c_void) -> u64,
    pub rows_tag: unsafe extern "C" fn(*const c_void) -> *const c_char,
    pub value_type: unsafe extern "C" fn(*const c_void, usize, usize) -> i32,
    pub value_int: unsafe extern "C" fn(*const c_void, usize, usize) -> i64,
    pub value_real: unsafe extern "C" fn(*const c_void, usize, usize) -> c_double,
    pub value_bytes: unsafe extern "C" fn(*const c_void, usize, usize, *mut usize) -> *const u8,

    pub txn_begin: unsafe extern "C" fn(*mut c_void, *mut *mut c_void, *mut *mut c_void) -> i32,
    pub txn_execute: unsafe extern "C" fn(*mut c_void, *const c_char, *mut u64, *mut *mut c_void) -> i32,
    pub txn_commit: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> i32,
    pub txn_rollback: unsafe extern "C" fn(*mut c_void),

    pub error_status: unsafe extern "C" fn(*const c_void) -> i32,
    pub error_message: unsafe extern "C" fn(*const c_void) -> *const c_char,
    pub error_feature: unsafe extern "C" fn(*const c_void) -> *const c_char,
    pub error_detail: unsafe extern "C" fn(*const c_void) -> *const c_char,
    pub error_offset: unsafe extern "C" fn(*const c_void) -> c_int,
    pub error_free: unsafe extern "C" fn(*mut c_void),
}

// Every pointer in the table points into a library that is never unloaded, and
// the engine's own thread rule is enforced by `Database` not being Send.
unsafe impl Send for Driver {}
unsafe impl Sync for Driver {}

/// Resolves one symbol out of the library, naming it in the error when it is
/// missing rather than letting the failure surface at the call.
///
/// # Safety
/// The caller states that `T` is the symbol's real signature.
unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, LoadError> {
    let found: Symbol<T> = library.get(name).map_err(|why| {
        LoadError(format!(
            "the driver does not export {}: {why}. That symbol is in the ABI this crate \
             was written for, so the library is either older than it claims or is not \
             the inillucent driver.",
            String::from_utf8_lossy(name)
        ))
    })?;
    Ok(*found)
}

/// Loads the shared library, refuses a major ABI mismatch by name, and resolves
/// every symbol.
fn load() -> Result<Driver, LoadError> {
    let path = resolve_library()?;
    // Loading a shared library runs its initialisers, so the caller has to trust
    // the file. That is the same trust as linking against it.
    let library = unsafe { Library::new(&path) }
        .map_err(|why| LoadError(format!("cannot load {}: {why}", path.display())))?;

    unsafe {
        let abi_version: unsafe extern "C" fn() -> u32 = symbol(&library, b"inillucent_abi_version")?;
        let reported = abi_version();
        let major = reported / 1_000_000;
        if major != ABI_MAJOR {
            return Err(LoadError(format!(
                "{} reports ABI {}.{}.{}, and this crate was written for ABI {ABI_MAJOR}.x. \
                 A major bump moves a signature, so calling it would fail in a way nobody \
                 can read. Install a matching driver.",
                path.display(),
                major,
                (reported / 1000) % 1000,
                reported % 1000
            )));
        }

        Ok(Driver {
            abi_version,
            version: symbol(&library, b"inillucent_version")?,
            capability_count: symbol(&library, b"inillucent_capability_count")?,
            capability: symbol(&library, b"inillucent_capability")?,
            supports: symbol(&library, b"inillucent_supports")?,
            open: symbol(&library, b"inillucent_open")?,
            close: symbol(&library, b"inillucent_close")?,
            checkpoint: symbol(&library, b"inillucent_checkpoint")?,
            integrity_check: symbol(&library, b"inillucent_integrity_check")?,
            backup_to: symbol(&library, b"inillucent_backup_to")?,
            path_of: symbol(&library, b"inillucent_path")?,
            connect: symbol(&library, b"inillucent_connect")?,
            conn_free: symbol(&library, b"inillucent_conn_free")?,
            execute: symbol(&library, b"inillucent_execute")?,
            execute_batch: symbol(&library, b"inillucent_execute_batch")?,
            last_insert_rowid: symbol(&library, b"inillucent_last_insert_rowid")?,
            total_changes: symbol(&library, b"inillucent_total_changes")?,
            in_transaction: symbol(&library, b"inillucent_in_transaction")?,
            schema_cookie: symbol(&library, b"inillucent_schema_cookie")?,
            cancel: symbol(&library, b"inillucent_cancel")?,
            prepare: symbol(&library, b"inillucent_prepare")?,
            stmt_free: symbol(&library, b"inillucent_stmt_free")?,
            bind_null: symbol(&library, b"inillucent_bind_null")?,
            bind_int: symbol(&library, b"inillucent_bind_int")?,
            bind_real: symbol(&library, b"inillucent_bind_real")?,
            bind_text: symbol(&library, b"inillucent_bind_text")?,
            bind_blob: symbol(&library, b"inillucent_bind_blob")?,
            clear_bindings: symbol(&library, b"inillucent_clear_bindings")?,
            stmt_execute: symbol(&library, b"inillucent_stmt_execute")?,
            rows_free: symbol(&library, b"inillucent_rows_free")?,
            rows_column_count: symbol(&library, b"inillucent_rows_column_count")?,
            rows_column_name: symbol(&library, b"inillucent_rows_column_name")?,
            rows_column_type: symbol(&library, b"inillucent_rows_column_type")?,
            rows_count: symbol(&library, b"inillucent_rows_count")?,
            rows_total: symbol(&library, b"inillucent_rows_total")?,
            rows_more: symbol(&library, b"inillucent_rows_more")?,
            rows_affected: symbol(&library, b"inillucent_rows_affected")?,
            rows_elapsed_us: symbol(&library, b"inillucent_rows_elapsed_us")?,
            rows_tag: symbol(&library, b"inillucent_rows_tag")?,
            value_type: symbol(&library, b"inillucent_value_type")?,
            value_int: symbol(&library, b"inillucent_value_int")?,
            value_real: symbol(&library, b"inillucent_value_real")?,
            value_bytes: symbol(&library, b"inillucent_value_bytes")?,
            txn_begin: symbol(&library, b"inillucent_txn_begin")?,
            txn_execute: symbol(&library, b"inillucent_txn_execute")?,
            txn_commit: symbol(&library, b"inillucent_txn_commit")?,
            txn_rollback: symbol(&library, b"inillucent_txn_rollback")?,
            error_status: symbol(&library, b"inillucent_error_status")?,
            error_message: symbol(&library, b"inillucent_error_message")?,
            error_feature: symbol(&library, b"inillucent_error_feature")?,
            error_detail: symbol(&library, b"inillucent_error_detail")?,
            error_offset: symbol(&library, b"inillucent_error_offset")?,
            error_free: symbol(&library, b"inillucent_error_free")?,
            path,
            _library: library,
        })
    }
}

static DRIVER: OnceLock<Result<Driver, LoadError>> = OnceLock::new();

/// Returns the loaded driver, loading it the first time it is asked for.
///
/// The load is attempted once. A failure is remembered and returned again rather
/// than retried, so a missing library does not turn into one error message per
/// call.
pub fn driver() -> Result<&'static Driver, LoadError> {
    match DRIVER.get_or_init(load) {
        Ok(loaded) => Ok(loaded),
        Err(why) => Err(why.clone()),
    }
}

/// Copies a C string the library returned into an owned `String`.
///
/// Every string is copied on the way out, because it points inside a handle the
/// caller may free.
///
/// # Safety
/// The caller states that `pointer` is either null or a valid C string.
pub unsafe fn owned(pointer: *const c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    Some(CStr::from_ptr(pointer).to_string_lossy().into_owned())
}
