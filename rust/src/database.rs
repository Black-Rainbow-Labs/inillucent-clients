//! The database, connection, statement and transaction types.
//!
//! Every handle is owned by exactly one value and freed in its `Drop`. A child
//! borrows its parent, so the compiler enforces the order the C ABI requires:
//! a database cannot be closed while a connection on it is alive.

use std::ffi::{c_void, CString};
use std::marker::PhantomData;
use std::path::Path;

use crate::error::{Error, Result, Status};
use crate::ffi::{driver, owned, Driver};
use crate::value::{Rows, Value};

pub const OPEN_CREATE: u32 = 0x0001;
pub const OPEN_READONLY: u32 = 0x0002;
pub const OPEN_DIAGNOSTICS: u32 = 0x0004;

/// The largest limit the C ABI accepts, which is every row.
const NO_LIMIT: u64 = u64::MAX;

/// How a database file is opened.
#[derive(Debug, Clone, Copy)]
pub struct OpenOptions {
    /// Create the file when it is not there.
    pub create: bool,
    /// Refuse anything but a query.
    pub read_only: bool,
    /// Collect internal diagnostic text on failures.
    ///
    /// Diagnostics may hold a file system path or a bound value, so do not show
    /// them to a person and do not send them to a shared log.
    pub diagnostics: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions { create: true, read_only: false, diagnostics: false }
    }
}

impl OpenOptions {
    /// Returns the flags the C ABI takes for these options.
    fn flags(self) -> u32 {
        let mut flags = 0;
        if self.create {
            flags |= OPEN_CREATE;
        }
        if self.read_only {
            flags |= OPEN_READONLY;
        }
        if self.diagnostics {
            flags |= OPEN_DIAGNOSTICS;
        }
        flags
    }
}

/// Turns a path into the UTF-8 C string the ABI takes.
///
/// @param path - the file to name
fn c_path(path: &Path) -> Result<CString> {
    let text = path.to_str().ok_or_else(|| Error {
        status: Status::InvalidState,
        message: format!("the path {} is not valid UTF-8, and the ABI takes UTF-8", path.display()),
        feature: None,
        detail: None,
        offset: None,
    })?;
    CString::new(text).map_err(|_| Error {
        status: Status::InvalidState,
        message: "a path may not contain a NUL byte".to_owned(),
        feature: None,
        detail: None,
        offset: None,
    })
}

/// Turns a statement into the C string the ABI takes.
///
/// @param sql - the statement text
fn c_sql(sql: &str) -> Result<CString> {
    CString::new(sql).map_err(|_| Error {
        status: Status::Syntax,
        message: "a statement may not contain a NUL byte".to_owned(),
        feature: None,
        detail: None,
        offset: None,
    })
}

/// Builds the error a C error handle describes, and frees it either way.
///
/// # Safety
/// The caller states that `handle` is a live error this call takes over.
unsafe fn error_from(calls: &Driver, handle: *mut c_void) -> Error {
    let built = Error {
        status: Status::from_code((calls.error_status)(handle)),
        message: owned((calls.error_message)(handle)).unwrap_or_default(),
        feature: owned((calls.error_feature)(handle)),
        detail: owned((calls.error_detail)(handle)),
        offset: match (calls.error_offset)(handle) {
            negative if negative < 0 => None,
            offset => Some(offset),
        },
    };
    (calls.error_free)(handle);
    built
}

/// Turns a failed call into an error, using the error it produced.
///
/// A non zero status with no error still fails: a call that failed and said
/// nothing is not a reason to carry on.
///
/// # Safety
/// The caller states that `error` is the out parameter the call was given.
unsafe fn check(calls: &Driver, status: i32, error: *mut c_void) -> Result<()> {
    if status == 0 {
        return Ok(());
    }
    if !error.is_null() {
        return Err(error_from(calls, error));
    }
    let status = Status::from_code(status);
    Err(Error {
        status,
        message: format!("the call failed with {}", status.name()),
        feature: None,
        detail: None,
        offset: None,
    })
}

/// One transaction, held open while the caller decides whether to commit.
///
/// This is a handle rather than a pair of calls because a check on what a write
/// did has to happen before the commit. A postcondition tested afterwards is a
/// report about something that has already happened.
///
/// Dropping it without committing rolls it back.
pub struct Transaction<'c> {
    handle: *mut c_void,
    /// How many rows each statement in this transaction changed, in order.
    pub affected: Vec<u64>,
    held: PhantomData<&'c Connection<'c>>,
}

impl Transaction<'_> {
    /// Runs one statement inside the transaction and returns the rows it changed.
    ///
    /// A failure rolls the whole transaction back before it returns, so a caller
    /// that stops at the first error has already undone everything.
    ///
    /// @param sql - the statement to run
    pub fn execute(&mut self, sql: &str) -> Result<u64> {
        let calls = driver()?;
        let text = c_sql(sql)?;
        let mut changed: u64 = 0;
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe {
            let status = (calls.txn_execute)(self.handle, text.as_ptr(), &mut changed, &mut error);
            check(calls, status, error)?;
        }
        self.affected.push(changed);
        Ok(changed)
    }

    /// Commits the transaction. The handle is spent either way.
    pub fn commit(mut self) -> Result<()> {
        let calls = driver()?;
        let mut error: *mut c_void = std::ptr::null_mut();
        let handle = std::mem::replace(&mut self.handle, std::ptr::null_mut());
        unsafe {
            let status = (calls.txn_commit)(handle, &mut error);
            let outcome = check(calls, status, error);
            (calls.txn_rollback)(handle);
            outcome
        }
    }

    /// Rolls the transaction back and frees it.
    pub fn rollback(self) {
        // Drop does the work, and consuming self here says so at the call site.
    }
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if self.handle.is_null() {
            return;
        }
        if let Ok(calls) = driver() {
            unsafe { (calls.txn_rollback)(self.handle) };
        }
        self.handle = std::ptr::null_mut();
    }
}

/// A compiled statement and the values bound to it.
pub struct Statement<'c> {
    handle: *mut c_void,
    held: PhantomData<&'c Connection<'c>>,
}

impl Statement<'_> {
    /// Binds these values, runs the statement, and returns what it produced.
    ///
    /// @param params - values for ?1, ?2 and so on, in order
    /// @param limit - rows to hand back, or None for every row
    pub fn execute(&mut self, params: &[Value], limit: Option<u64>) -> Result<Rows> {
        let calls = driver()?;
        unsafe { (calls.clear_bindings)(self.handle) };
        for (nth, value) in params.iter().enumerate() {
            self.bind(nth as u32 + 1, value)?;
        }
        let mut rows: *mut c_void = std::ptr::null_mut();
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe {
            let status =
                (calls.stmt_execute)(self.handle, limit.unwrap_or(NO_LIMIT), &mut rows, &mut error);
            check(calls, status, error)?;
            Rows::take(rows)
        }
    }

    /// Binds one value at a one based parameter position.
    ///
    /// @param index - the one based parameter position
    /// @param value - what to bind
    pub fn bind(&mut self, index: u32, value: &Value) -> Result<()> {
        let calls = driver()?;
        unsafe {
            match value {
                Value::Null => (calls.bind_null)(self.handle, index),
                Value::Integer(whole) => (calls.bind_int)(self.handle, index, *whole),
                Value::Real(number) => (calls.bind_real)(self.handle, index, *number),
                Value::Text(text) => (calls.bind_text)(
                    self.handle,
                    index,
                    text.as_ptr() as *const std::ffi::c_char,
                    text.len(),
                ),
                Value::Blob(bytes) => {
                    (calls.bind_blob)(self.handle, index, bytes.as_ptr(), bytes.len())
                }
            }
        };
        Ok(())
    }
}

impl Drop for Statement<'_> {
    fn drop(&mut self) {
        if self.handle.is_null() {
            return;
        }
        if let Ok(calls) = driver() {
            unsafe { (calls.stmt_free)(self.handle) };
        }
        self.handle = std::ptr::null_mut();
    }
}

/// One connection to a database, and one session.
///
/// Temp tables, ATTACH and the connection pragmas are scoped to the session this
/// connection holds, so they last as long as it does.
pub struct Connection<'d> {
    handle: *mut c_void,
    held: PhantomData<&'d Database>,
}

impl Connection<'_> {
    /// Runs one statement and returns everything it produced.
    ///
    /// `limit` caps the rows handed back, not the rows produced. `Rows::total`
    /// is exact either way, because the engine materialises and the count was
    /// taken rather than estimated.
    ///
    /// @param sql - the statement to run
    /// @param params - values for ?1, ?2 and so on, in order
    /// @param limit - rows to hand back, or None for every row
    pub fn execute(&self, sql: &str, params: &[Value], limit: Option<u64>) -> Result<Rows> {
        if !params.is_empty() {
            return self.prepare(sql)?.execute(params, limit);
        }
        let calls = driver()?;
        let text = c_sql(sql)?;
        let mut rows: *mut c_void = std::ptr::null_mut();
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe {
            let status = (calls.execute)(
                self.handle,
                text.as_ptr(),
                limit.unwrap_or(NO_LIMIT),
                &mut rows,
                &mut error,
            );
            check(calls, status, error)?;
            Rows::take(rows)
        }
    }

    /// Runs one statement with nothing bound and returns what it produced.
    ///
    /// @param sql - the statement to run
    pub fn run(&self, sql: &str) -> Result<Rows> {
        self.execute(sql, &[], None)
    }

    /// Runs one statement and returns the first column of its first row.
    ///
    /// @param sql - the statement to run
    /// @param params - values for ?1, ?2 and so on, in order
    pub fn scalar(&self, sql: &str, params: &[Value]) -> Result<Option<Value>> {
        Ok(self.execute(sql, params, Some(1))?.scalar().cloned())
    }

    /// Runs several statements separated by semicolons, for their effect.
    ///
    /// @param sql - the statements to run
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        let calls = driver()?;
        let text = c_sql(sql)?;
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe {
            let status = (calls.execute_batch)(self.handle, text.as_ptr(), &mut error);
            check(calls, status, error)
        }
    }

    /// Compiles a statement so it can be run more than once.
    ///
    /// @param sql - the statement to compile
    pub fn prepare(&self, sql: &str) -> Result<Statement<'_>> {
        let calls = driver()?;
        let text = c_sql(sql)?;
        let mut handle: *mut c_void = std::ptr::null_mut();
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe {
            let status = (calls.prepare)(self.handle, text.as_ptr(), &mut handle, &mut error);
            check(calls, status, error)?;
        }
        Ok(Statement { handle, held: PhantomData })
    }

    /// Opens a transaction.
    pub fn transaction(&self) -> Result<Transaction<'_>> {
        let calls = driver()?;
        let mut handle: *mut c_void = std::ptr::null_mut();
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe {
            let status = (calls.txn_begin)(self.handle, &mut handle, &mut error);
            check(calls, status, error)?;
        }
        Ok(Transaction { handle, affected: Vec::new(), held: PhantomData })
    }

    /// The rowid the most recent insert on this connection produced.
    pub fn last_insert_rowid(&self) -> Result<i64> {
        Ok(unsafe { (driver()?.last_insert_rowid)(self.handle) })
    }

    /// How many rows every statement on this connection has changed.
    pub fn total_changes(&self) -> Result<i64> {
        Ok(unsafe { (driver()?.total_changes)(self.handle) })
    }

    /// Whether a transaction is open on this connection.
    pub fn in_transaction(&self) -> Result<bool> {
        Ok(unsafe { (driver()?.in_transaction)(self.handle) } != 0)
    }

    /// The schema's generation, which changes when the schema does.
    ///
    /// Compare it to know whether a cached table description is stale.
    pub fn schema_cookie(&self) -> Result<u64> {
        Ok(unsafe { (driver()?.schema_cookie)(self.handle) })
    }

    /// Asks a running statement to stop.
    ///
    /// This always refuses as `Unsupported` today, and `supports("cancel")` says
    /// so before an application draws a Stop button: the engine runs a statement
    /// whole rather than a row at a time, so there is no point at which it could
    /// notice.
    pub fn cancel(&self) -> Result<()> {
        let calls = driver()?;
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe {
            let status = (calls.cancel)(self.handle, &mut error);
            check(calls, status, error)
        }
    }
}

impl Drop for Connection<'_> {
    fn drop(&mut self) {
        if self.handle.is_null() {
            return;
        }
        if let Ok(calls) = driver() {
            unsafe { (calls.conn_free)(self.handle) };
        }
        self.handle = std::ptr::null_mut();
    }
}

/// One open database file.
///
/// One file is one buffer pool and the engine is single threaded, so a
/// `Database` is deliberately neither `Send` nor `Sync`. Two databases on two
/// files are independent.
pub struct Database {
    handle: *mut c_void,
    // The engine has no lock inside, so this type must not cross threads. The
    // raw pointer already makes it !Send and !Sync; this says why.
    _not_send: PhantomData<*const ()>,
}

impl Database {
    /// Opens a database file, creating it when it is not there.
    ///
    /// @param path - the database file
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Database::open_with(path, OpenOptions::default())
    }

    /// Opens a database file with explicit options.
    ///
    /// @param path - the database file
    /// @param options - how to open it
    pub fn open_with(path: impl AsRef<Path>, options: OpenOptions) -> Result<Self> {
        let calls = driver()?;
        let text = c_path(path.as_ref())?;
        let mut handle: *mut c_void = std::ptr::null_mut();
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe {
            let status = (calls.open)(text.as_ptr(), options.flags(), &mut handle, &mut error);
            check(calls, status, error)?;
        }
        Ok(Database { handle, _not_send: PhantomData })
    }

    /// Opens a connection, and with it a session.
    pub fn connect(&self) -> Result<Connection<'_>> {
        let calls = driver()?;
        let mut handle: *mut c_void = std::ptr::null_mut();
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe {
            let status = (calls.connect)(self.handle, &mut handle, &mut error);
            check(calls, status, error)?;
        }
        Ok(Connection { handle, held: PhantomData })
    }

    /// The file this database is in.
    pub fn path(&self) -> Result<String> {
        Ok(unsafe { owned((driver()?.path_of)(self.handle)) }.unwrap_or_default())
    }

    /// Makes everything written so far durable in the file.
    pub fn checkpoint(&self) -> Result<()> {
        let calls = driver()?;
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe { check(calls, (calls.checkpoint)(self.handle, &mut error), error) }
    }

    /// Walks every tree and reports the first thing that is wrong.
    pub fn integrity_check(&self) -> Result<()> {
        let calls = driver()?;
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe { check(calls, (calls.integrity_check)(self.handle, &mut error), error) }
    }

    /// Copies the database to a path, opening and checking the copy first.
    ///
    /// A backup nobody checked is a file that is assumed to be a database.
    ///
    /// @param path - where to write the copy
    pub fn backup_to(&self, path: impl AsRef<Path>) -> Result<()> {
        let calls = driver()?;
        let text = c_path(path.as_ref())?;
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe { check(calls, (calls.backup_to)(self.handle, text.as_ptr(), &mut error), error) }
    }

    /// Checkpoints and closes, reporting a failure the drop would have swallowed.
    ///
    /// The C library refuses to close a database that still has connections on
    /// it, so call this only once every connection has been dropped.
    pub fn close(mut self) -> Result<()> {
        let calls = driver()?;
        let handle = std::mem::replace(&mut self.handle, std::ptr::null_mut());
        let mut error: *mut c_void = std::ptr::null_mut();
        unsafe { check(calls, (calls.close)(handle, &mut error), error) }
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        if self.handle.is_null() {
            return;
        }
        if let Ok(calls) = driver() {
            let mut error: *mut c_void = std::ptr::null_mut();
            unsafe {
                (calls.close)(self.handle, &mut error);
                if !error.is_null() {
                    // A drop cannot report, and `close()` exists for a caller who
                    // wants to be told. Freeing the error is all that is left.
                    (calls.error_free)(error);
                }
            }
        }
        self.handle = std::ptr::null_mut();
    }
}
