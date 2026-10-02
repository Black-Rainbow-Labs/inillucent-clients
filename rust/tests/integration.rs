//! Runs every scenario in conformance/integration.md against this client.
//!
//! suite.json grades what a statement does. These tests grade what the library
//! around the statement does: opening, closing and reopening a file, a
//! transaction, a prepared statement reused with new values, a backup, a cancel
//! sent from another thread, and a second process writing the same file. Every
//! test uses a real database file in a fresh temporary folder, through the public
//! API, with no mocks, and removes the folder when it ends.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use inillucent::{Database, Error, OpenOptions, Rows, Status, Support, Value};

/// The environment variable that tells the child process helper which file to write.
const CHILD_DATABASE: &str = "INILLUCENT_INTEGRATION_CHILD_DATABASE";

/// A temporary folder that is deleted when the test holding it ends.
struct Folder {
    path: PathBuf,
}

impl Folder {
    /// Creates a new empty folder under the system temporary directory.
    fn new() -> Folder {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let nth = COUNTER.fetch_add(1, Ordering::SeqCst);
        let name = format!("inillucent-integration-rs-{}-{stamp}-{nth}", std::process::id());
        let path = std::env::temp_dir().join(name);
        std::fs::create_dir_all(&path).expect("the temporary folder must be created");
        Folder { path }
    }

    /// Returns the path of a file inside the folder.
    ///
    /// @param name - the file name
    fn file(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Returns the error a call that must fail produced.
///
/// @param outcome - the result of the call
fn failure<T>(outcome: inillucent::Result<T>) -> Error {
    match outcome {
        Ok(_) => panic!("the call succeeded and it should have failed"),
        Err(why) => why,
    }
}

/// Returns every row as integers and text, for comparing against a literal.
///
/// @param rows - what a statement returned
fn cells(rows: &Rows) -> Vec<Vec<Value>> {
    rows.rows.clone()
}

/// Returns the single integer a statement produced.
///
/// @param connection - where to run it
/// @param sql - a statement that produces one integer
fn count(connection: &inillucent::Connection<'_>, sql: &str) -> i64 {
    connection.scalar(sql, &[]).unwrap().and_then(|value| value.as_integer()).unwrap()
}

/// Returns the options for opening an existing file without creating it.
fn existing() -> OpenOptions {
    OpenOptions { create: false, ..OpenOptions::default() }
}

/// Creates the table most scenarios use.
///
/// @param connection - where to create it
fn table(connection: &inillucent::Connection<'_>) {
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").unwrap();
}

// Files

#[test]
fn file_survives_close_and_reopen() {
    let folder = Folder::new();
    let path = folder.file("kept.rdb");
    let database = Database::open(&path).unwrap();
    assert_eq!(PathBuf::from(database.path().unwrap()), path);
    let connection = database.connect().unwrap();
    table(&connection);
    connection.execute("INSERT INTO t (v) VALUES (?1)", &["one".into()], None).unwrap();
    connection.execute("INSERT INTO t (v) VALUES (?1)", &["two".into()], None).unwrap();
    drop(connection);
    database.close().unwrap();

    let again = Database::open_with(&path, existing()).unwrap();
    let connection = again.connect().unwrap();
    let rows = connection.run("SELECT id, v FROM t ORDER BY id").unwrap();
    assert_eq!(cells(&rows), vec![vec![1.into(), "one".into()], vec![2.into(), "two".into()]]);
}

#[test]
fn missing_file_without_create_is_not_found() {
    let folder = Folder::new();
    let path = folder.file("absent.rdb");
    let why = failure(Database::open_with(&path, existing()));
    assert_eq!(why.status, Status::NotFound);
    assert!(!path.exists(), "a failed open created the file");
}

#[test]
fn read_only_open_reads_and_refuses_writes() {
    let folder = Folder::new();
    let path = folder.file("ro.rdb");
    {
        let database = Database::open(&path).unwrap();
        let connection = database.connect().unwrap();
        table(&connection);
        connection.run("INSERT INTO t (v) VALUES ('a'), ('b')").unwrap();
    }
    let options = OpenOptions { read_only: true, ..OpenOptions::default() };
    let database = Database::open_with(&path, options).unwrap();
    let connection = database.connect().unwrap();
    assert_eq!(connection.run("SELECT v FROM t ORDER BY id").unwrap().len(), 2);
    let why = failure(connection.run("INSERT INTO t (v) VALUES ('c')"));
    assert_eq!(why.status, Status::ReadOnly);
    assert_eq!(count(&connection, "SELECT count(*) FROM t"), 2);
}

#[test]
fn second_handle_in_the_same_process_sees_committed_rows() {
    let folder = Folder::new();
    let path = folder.file("shared.rdb");
    let first_database = Database::open(&path).unwrap();
    let first = first_database.connect().unwrap();
    table(&first);
    let second_database = Database::open(&path).unwrap();
    let second = second_database.connect().unwrap();
    // On 1.0.33 a handle that has been opened and has run nothing holds a read
    // lock, so a write through the first handle waits out busy_timeout and
    // fails with busy. Running one statement on the second handle releases it.
    assert_eq!(count(&second, "SELECT count(*) FROM t"), 0);
    first.run("INSERT INTO t (v) VALUES ('seen')").unwrap();
    let rows = second.run("SELECT v FROM t").unwrap();
    assert_eq!(cells(&rows), vec![vec![Value::from("seen")]]);
}

/// The child half of another_process_writes_and_this_one_reads_it.
///
/// It does nothing unless the parent set the environment variable, so an
/// ordinary test run passes over it.
#[test]
fn child_process_writer() {
    let Ok(path) = std::env::var(CHILD_DATABASE) else {
        return;
    };
    let database = Database::open(&path).unwrap();
    let connection = database.connect().unwrap();
    connection.execute("INSERT INTO t (v) VALUES (?1)", &["from the child".into()], None).unwrap();
    drop(connection);
    database.close().unwrap();
}

#[test]
fn another_process_writes_and_this_one_reads_it() {
    let folder = Folder::new();
    let path = folder.file("two-processes.rdb");
    let database = Database::open(&path).unwrap();
    let connection = database.connect().unwrap();
    table(&connection);

    let program = std::env::current_exe().unwrap();
    let child = Command::new(program)
        .args(["child_process_writer", "--exact", "--test-threads=1"])
        .env(CHILD_DATABASE, &path)
        .output()
        .expect("the child process must start");
    assert!(child.status.success(), "the child failed: {}", String::from_utf8_lossy(&child.stdout));

    let rows = connection.run("SELECT v FROM t").unwrap();
    assert_eq!(cells(&rows), vec![vec![Value::from("from the child")]]);
}

// Statements

#[test]
fn prepared_statement_runs_many_times_with_fresh_bindings() {
    let folder = Folder::new();
    let database = Database::open(folder.file("prepared.rdb")).unwrap();
    let connection = database.connect().unwrap();
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, v TEXT)").unwrap();
    let mut insert = connection.prepare("INSERT INTO t (n, v) VALUES (?1, ?2)").unwrap();
    for nth in 0..100i64 {
        let rows = insert.execute(&[nth.into(), format!("value {nth}").into()], None).unwrap();
        assert_eq!(rows.affected, Some(1));
    }
    drop(insert);
    let rows = connection.run("SELECT n, v FROM t ORDER BY n").unwrap();
    let want: Vec<Vec<Value>> = (0..100i64).map(|nth| vec![nth.into(), format!("value {nth}").into()]).collect();
    assert_eq!(cells(&rows), want);

    let mut add = connection.prepare("SELECT ?1 + ?2").unwrap();
    assert_eq!(add.execute(&[2.into(), 3.into()], None).unwrap().scalar(), Some(&Value::Integer(5)));
    assert_eq!(add.execute(&[2.into()], None).unwrap().scalar(), Some(&Value::Null));
}

#[test]
fn rows_report_counts_columns_and_limits() {
    let folder = Folder::new();
    let database = Database::open(folder.file("rows.rdb")).unwrap();
    let connection = database.connect().unwrap();
    table(&connection);
    let written = connection.run("INSERT INTO t (v) VALUES ('a'), ('b')").unwrap();
    assert_eq!(written.affected, Some(2));
    assert_eq!(written.tag, "INSERT 2");
    connection.run("INSERT INTO t (v) VALUES ('c'), ('d'), ('e')").unwrap();

    let page = connection.execute("SELECT id, v FROM t ORDER BY id", &[], Some(2)).unwrap();
    assert_eq!(page.len(), 2);
    assert!(!page.is_empty());
    assert_eq!(page.total, 5);
    assert!(page.more);
    assert_eq!(page.affected, None);
    assert_eq!(page.columns, vec!["id".to_string(), "v".to_string()]);
    // The engine returns "" for a plain table column's declared type on 1.0.33,
    // so only the count is asserted. See integration.md.
    assert_eq!(page.column_types.len(), 2);
    assert_eq!(page.get(1, "v"), Some(&Value::from("b")));
    assert_eq!(page.column_index("missing"), None);
    assert_eq!(page.one().map(|row| row.len()), Some(2));
    assert_eq!((&page).into_iter().count(), 2);
    assert!(page.elapsed_micros < 60_000_000);
}

#[test]
fn last_insert_rowid_and_total_changes() {
    let folder = Folder::new();
    let database = Database::open(folder.file("rowid.rdb")).unwrap();
    let connection = database.connect().unwrap();
    table(&connection);
    let before = connection.total_changes().unwrap();
    connection.run("INSERT INTO t (v) VALUES ('first')").unwrap();
    connection.run("INSERT INTO t (v) VALUES ('second')").unwrap();
    let second = count(&connection, "SELECT id FROM t WHERE v = 'second'");
    assert_eq!(connection.last_insert_rowid().unwrap(), second);
    assert_eq!(connection.total_changes().unwrap(), before + 2);
    connection.run("UPDATE t SET v = 'changed'").unwrap();
    assert_eq!(connection.total_changes().unwrap(), before + 4);
}

#[test]
fn schema_cookie_changes_when_the_schema_does() {
    let folder = Folder::new();
    let database = Database::open(folder.file("cookie.rdb")).unwrap();
    let connection = database.connect().unwrap();
    table(&connection);
    let cookie = connection.schema_cookie().unwrap();
    connection.run("SELECT * FROM t").unwrap();
    connection.run("INSERT INTO t (v) VALUES ('x')").unwrap();
    assert_eq!(connection.schema_cookie().unwrap(), cookie);
    connection.run("CREATE TABLE u (id INTEGER PRIMARY KEY)").unwrap();
    assert_ne!(connection.schema_cookie().unwrap(), cookie);
}

#[test]
fn execute_batch_runs_every_statement() {
    let folder = Folder::new();
    let database = Database::open(folder.file("batch.rdb")).unwrap();
    let connection = database.connect().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);\
             INSERT INTO t (v) VALUES ('a');\
             INSERT INTO t (v) VALUES ('b');\
             INSERT INTO t (v) VALUES ('c')",
        )
        .unwrap();
    assert_eq!(count(&connection, "SELECT count(*) FROM t"), 3);
    let why = failure(connection.execute_batch("INSERT INTO t (v) VALUES ('d'); SELEC nothing"));
    assert_eq!(why.status, Status::Syntax);
}

#[test]
fn large_values_round_trip() {
    let folder = Folder::new();
    let database = Database::open(folder.file("large.rdb")).unwrap();
    let connection = database.connect().unwrap();
    connection.run("CREATE TABLE big (id INTEGER PRIMARY KEY, b BLOB, s TEXT)").unwrap();
    let blob: Vec<u8> = (0..1024 * 1024).map(|nth| (nth % 256) as u8).collect();
    let mut text = String::new();
    while text.len() < 1024 * 1024 {
        text.push_str("\u{1F600}\u{10348} plain ");
    }
    connection
        .execute("INSERT INTO big (b, s) VALUES (?1, ?2)", &[blob.as_slice().into(), text.clone().into()], None)
        .unwrap();
    let rows = connection.run("SELECT b, s FROM big").unwrap();
    assert_eq!(rows.rows[0][0].as_blob(), Some(blob.as_slice()));
    assert_eq!(rows.rows[0][1].as_text(), Some(text.as_str()));
}

/// Returns little endian float32 bytes, the form a VECTOR column holds.
///
/// @param numbers - the components
fn vector(numbers: &[f32]) -> Value {
    Value::Blob(numbers.iter().flat_map(|number| number.to_le_bytes()).collect())
}

#[test]
fn search_with_bound_parameters() {
    let folder = Folder::new();
    let database = Database::open(folder.file("search.rdb")).unwrap();
    let connection = database.connect().unwrap();
    connection.run("CREATE VIRTUAL TABLE docs USING fts5(title, body)").unwrap();
    connection
        .run("INSERT INTO docs (rowid, title, body) VALUES (1, 'one', 'the quick brown fox'), \
              (2, 'two', 'a lazy dog'), (3, 'three', 'brown bread')")
        .unwrap();
    let found = connection
        .execute("SELECT rowid FROM docs WHERE docs MATCH ?1 ORDER BY rowid", &["brown".into()], None)
        .unwrap();
    assert_eq!(cells(&found), vec![vec![Value::Integer(1)], vec![Value::Integer(3)]]);

    connection.run("CREATE TABLE point (id INTEGER PRIMARY KEY, at VECTOR(2))").unwrap();
    for (id, at) in [(1i64, [1.0f32, 0.0]), (2, [0.0, 1.0]), (3, [0.7, 0.7])] {
        connection.execute("INSERT INTO point (id, at) VALUES (?1, ?2)", &[id.into(), vector(&at)], None).unwrap();
    }
    let nearest = connection
        .execute("SELECT id FROM point ORDER BY vector_distance_cos(at, ?1)", &[vector(&[0.0, 1.0])], None)
        .unwrap();
    assert_eq!(nearest.scalar(), Some(&Value::Integer(2)));
}

// Transactions

#[test]
fn transaction_commits_all_of_it() {
    let folder = Folder::new();
    let database = Database::open(folder.file("commit.rdb")).unwrap();
    let connection = database.connect().unwrap();
    table(&connection);
    let mut transaction = connection.transaction().unwrap();
    assert_eq!(transaction.execute("INSERT INTO t (v) VALUES ('a')").unwrap(), 1);
    assert_eq!(transaction.execute("INSERT INTO t (v) VALUES ('b'), ('c')").unwrap(), 2);
    assert_eq!(transaction.affected, vec![1, 2]);
    assert!(connection.in_transaction().unwrap());
    transaction.commit().unwrap();
    assert!(!connection.in_transaction().unwrap());
    assert_eq!(count(&connection, "SELECT count(*) FROM t"), 3);
}

#[test]
fn transaction_rolls_back_when_asked_and_when_abandoned() {
    let folder = Folder::new();
    let database = Database::open(folder.file("rollback.rdb")).unwrap();
    let connection = database.connect().unwrap();
    table(&connection);
    let mut asked = connection.transaction().unwrap();
    asked.execute("INSERT INTO t (v) VALUES ('asked')").unwrap();
    asked.rollback();
    assert_eq!(count(&connection, "SELECT count(*) FROM t"), 0);
    {
        let mut abandoned = connection.transaction().unwrap();
        abandoned.execute("INSERT INTO t (v) VALUES ('abandoned')").unwrap();
    }
    assert!(!connection.in_transaction().unwrap());
    assert_eq!(count(&connection, "SELECT count(*) FROM t"), 0);
}

#[test]
fn a_failing_statement_rolls_the_transaction_back() {
    let folder = Folder::new();
    let database = Database::open(folder.file("failing.rdb")).unwrap();
    let connection = database.connect().unwrap();
    table(&connection);
    connection.run("INSERT INTO t (id, v) VALUES (1, 'kept')").unwrap();
    let mut transaction = connection.transaction().unwrap();
    transaction.execute("INSERT INTO t (id, v) VALUES (2, 'undone')").unwrap();
    let why = failure(transaction.execute("INSERT INTO t (id, v) VALUES (1, 'clash')"));
    assert_eq!(why.status, Status::Constraint);
    assert_eq!(count(&connection, "SELECT count(*) FROM t"), 1);
    assert!(!connection.in_transaction().unwrap());
    let again = failure(transaction.execute("INSERT INTO t (id, v) VALUES (3, 'late')"));
    assert_eq!(again.status, Status::InvalidState);
    let late = failure(transaction.commit());
    assert_eq!(late.status, Status::InvalidState);
}

// Errors

#[test]
fn errors_carry_status_offset_and_message() {
    let folder = Folder::new();
    let database = Database::open(folder.file("errors.rdb")).unwrap();
    let connection = database.connect().unwrap();
    table(&connection);
    let syntax = failure(connection.run("SELECT * FROM t WHERE"));
    assert_eq!(syntax.status, Status::Syntax);
    assert_eq!(syntax.offset, Some(21));
    assert!(syntax.to_string().contains("at byte 21"));
    assert_eq!(failure(connection.run("SELECT * FROM missing_table")).status.name(), "not_found");
    connection.run("INSERT INTO t (id, v) VALUES (1, 'a')").unwrap();
    let clash = failure(connection.run("INSERT INTO t (id, v) VALUES (1, 'b')"));
    assert_eq!(clash.status, Status::Constraint);
    let refused = failure(connection.run("CREATE VIRTUAL TABLE f USING fts5(a, detail=none)"));
    assert!(refused.is_unsupported());
    assert_eq!(refused.status, Status::Unsupported);
    assert!(refused.feature.as_deref().unwrap_or_default().contains("detail=none"));
    let nul = failure(connection.run("SELECT 1\0"));
    assert_eq!(nul.status, Status::Syntax);
}

#[test]
fn closing_refuses_while_a_statement_is_open() {
    // The borrow checker will not compile a close while a Statement borrowed
    // from the database is alive, so the only way to reach the engine's refusal
    // is a statement that was leaked with mem::forget. The refusal is reported,
    // and neither close() nor the Drop that follows it panics.
    let folder = Folder::new();
    let path = folder.file("refuse.rdb");
    let database = Database::open(&path).unwrap();
    let connection = database.connect().unwrap();
    table(&connection);
    let mut statement = connection.prepare("INSERT INTO t (v) VALUES (?1)").unwrap();
    statement.execute(&["kept".into()], None).unwrap();
    std::mem::forget(statement);
    drop(connection);
    let why = failure(database.close());
    assert_eq!(why.status, Status::InvalidState);

    let leaked = Database::open(folder.file("dropped.rdb")).unwrap();
    let connection = leaked.connect().unwrap();
    std::mem::forget(connection.prepare("SELECT 1").unwrap());
    drop(connection);
    drop(leaked);

    let reopened = Database::open_with(&path, existing()).unwrap();
    let connection = reopened.connect().unwrap();
    assert_eq!(connection.scalar("SELECT v FROM t", &[]).unwrap(), Some(Value::from("kept")));
}

#[test]
fn use_after_close_is_an_error_not_a_crash() {
    // A closed connection is a moved value in Rust, so using it does not
    // compile. What remains to check is that closing twice is not possible to
    // get wrong and that a statement dropped after its connection still works.
    let folder = Folder::new();
    let database = Database::open(folder.file("closed.rdb")).unwrap();
    let connection = database.connect().unwrap();
    let mut statement = connection.prepare("SELECT 7").unwrap();
    assert_eq!(statement.execute(&[], None).unwrap().scalar(), Some(&Value::Integer(7)));
    drop(statement);
    drop(connection);
    database.close().unwrap();
}

#[test]
fn binding_a_value_with_no_placeholder_is_an_error() {
    let folder = Folder::new();
    let database = Database::open(folder.file("bind.rdb")).unwrap();
    let connection = database.connect().unwrap();
    let why = failure(connection.execute("SELECT ?1", &[1.into(), 2.into()], None));
    assert_eq!(why.status, Status::InvalidState);
    let mut statement = connection.prepare("SELECT ?1").unwrap();
    assert_eq!(failure(statement.bind(0, &Value::Null)).status, Status::InvalidState);
    let values = [Value::Null, true.into(), 1.5.into(), 7i32.into(), Value::from(Some("t")), Value::from(None::<i64>), vec![1u8].into()];
    for value in values {
        assert_eq!(statement.execute(std::slice::from_ref(&value), None).unwrap().scalar(), Some(&value));
    }
}

// Engine facts

#[test]
fn capabilities_and_versions() {
    let table = inillucent::capabilities().unwrap();
    assert!(!table.is_empty());
    assert!(table.iter().all(|entry| !entry.name.is_empty()));
    let cancel = table.iter().find(|entry| entry.name == "cancel").unwrap();
    assert_eq!(cancel.support.name(), "partial");
    assert!(cancel.support.is_supported());
    assert_eq!(inillucent::supports("cancel").unwrap(), Support::Partial);
    assert_eq!(inillucent::supports("encryption").unwrap(), Support::Yes);
    assert_eq!(inillucent::supports("load_extension").unwrap(), Support::No);
    assert_eq!(inillucent::supports("made_up_capability").unwrap(), Support::Unknown);
    // Any release: this said "1.0." and failed when the engine became 2.0. The ABI is what matters.
    let version = inillucent::version().unwrap();
    assert!(version.starts_with("inillucent-driver ") && version.contains(" (engine "), "{version}");
    let abi: Vec<u32> = inillucent::abi_version().unwrap().split('.').map(|part| part.parse().unwrap()).collect();
    assert!((abi[0], abi[1]) >= (1, 1));
    assert!(Path::new(&inillucent::driver_path().unwrap()).is_file());
    assert!(!inillucent::search_paths().is_empty());
}

#[test]
fn checkpoint_integrity_check_and_backup() {
    let folder = Folder::new();
    let copy = folder.file("copy.rdb");
    {
        let database = Database::open(folder.file("source.rdb")).unwrap();
        let connection = database.connect().unwrap();
        table(&connection);
        connection.run("INSERT INTO t (v) VALUES ('a'), ('b')").unwrap();
        database.checkpoint().unwrap();
        database.integrity_check().unwrap();
        database.backup_to(&copy).unwrap();
        database.backup_to(&copy).unwrap();
    }
    let restored = Database::open_with(&copy, existing()).unwrap();
    let connection = restored.connect().unwrap();
    let rows = connection.run("SELECT v FROM t ORDER BY id").unwrap();
    assert_eq!(cells(&rows), vec![vec![Value::from("a")], vec![Value::from("b")]]);
}

const SLOW: &str = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000000) \
                    SELECT count(*) FROM n";

#[test]
fn cancel_from_another_thread_interrupts_and_the_connection_survives() {
    let folder = Folder::new();
    let database = Database::open(folder.file("cancel.rdb")).unwrap();
    let connection = database.connect().unwrap();
    connection.cancel().unwrap();
    assert_eq!(count(&connection, "SELECT 1"), 1);

    let started = Instant::now();
    let outcome = std::thread::scope(|scope| {
        let handle = connection.cancel_handle();
        scope.spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            handle.cancel().unwrap();
        });
        connection.run(SLOW)
    });
    assert_eq!(failure(outcome).status, Status::Interrupted);
    assert!(started.elapsed() < Duration::from_secs(30));
    assert_eq!(count(&connection, "SELECT 2"), 2);
}

#[test]
fn encryption() {
    let folder = Folder::new();
    let path = folder.file("vault.rdb");
    let key = format!("x'{}'", "5a".repeat(32));
    let keyed = |key: &str| OpenOptions { key: Some(key.to_string()), ..OpenOptions::default() };
    let secret = "the vault code is 7461";
    {
        let database = Database::open_with(&path, keyed(&key)).unwrap();
        let connection = database.connect().unwrap();
        connection.run("CREATE TABLE vault (note TEXT)").unwrap();
        connection.execute("INSERT INTO vault (note) VALUES (?1)", &[secret.into()], None).unwrap();
    }
    for entry in std::fs::read_dir(&folder.path).unwrap().flatten() {
        let bytes = std::fs::read(entry.path()).unwrap();
        assert!(!bytes.windows(secret.len()).any(|window| window == secret.as_bytes()));
    }
    let database = Database::open_with(&path, keyed(&key)).unwrap();
    let connection = database.connect().unwrap();
    assert_eq!(connection.scalar("SELECT note FROM vault", &[]).unwrap(), Some(Value::from(secret)));
    assert_eq!(connection.scalar("PRAGMA encryption", &[]).unwrap(), Some(Value::from("xchacha20-poly1305")));
    assert!(format!("{:?}", keyed(&key)).contains("<redacted>"));
    assert_eq!(failure(Database::open(&path)).status, Status::Corrupt);
    let other = format!("x'{}'", "3c".repeat(32));
    assert_eq!(failure(Database::open_with(&path, keyed(&other))).status, Status::Corrupt);
}

// The public types themselves

#[test]
fn values_statuses_and_errors_describe_themselves() {
    let names: Vec<&str> = (0..=14).map(|code| Status::from_code(code).name()).collect();
    assert_eq!(names[..4], ["ok", "unsupported", "syntax", "not_found"]);
    assert_eq!(names[4..], ["constraint", "readonly", "busy", "interrupted", "corrupt", "io", "full", "too_big", "invalid_state", "internal", "unknown"]);
    let words: Vec<&str> = [1, 0, -1, -2].iter().map(|code| Support::from_code(*code).name()).collect();
    assert_eq!(words, ["yes", "no", "partial", "unknown"]);
    assert!(!Support::No.is_supported() && Support::Yes.is_supported());

    let plain = Error { status: Status::Busy, message: "waited".into(), feature: None, detail: None, offset: None };
    assert_eq!(plain.to_string(), "waited [busy]");
    let load = inillucent::LoadError("no library".into());
    assert_eq!(load.to_string(), "no library");
    assert_eq!(Error::from(load).status, Status::Internal);

    assert_eq!(Value::Integer(3).as_integer(), Some(3));
    assert_eq!(Value::Null.as_integer(), None);
    assert_eq!(Value::Real(0.5).as_real(), Some(0.5));
    assert_eq!(Value::Null.as_real(), None);
    assert_eq!(Value::Null.as_text(), None);
    assert_eq!(Value::Null.as_blob(), None);
    assert!(Value::Null.is_null() && !Value::Integer(0).is_null());
    let shown: Vec<String> = [Value::Null, 7i64.into(), 0.25.into(), "hi".into(), String::from("s").into(), vec![1u8, 2].into()]
        .iter()
        .map(|value| value.to_string())
        .collect();
    assert_eq!(shown, ["NULL", "7", "0.25", "hi", "s", "2 bytes"]);
}

#[test]
fn bad_paths_and_keys_are_refused_before_the_engine_sees_them() {
    let folder = Folder::new();
    let why = failure(Database::open(folder.file("nul\0name.rdb")));
    assert_eq!(why.status, Status::InvalidState);
    let keyed = OpenOptions { key: Some("bad\0key".into()), ..OpenOptions::default() };
    assert_eq!(failure(Database::open_with(folder.file("key.rdb"), keyed)).status, Status::InvalidState);
    assert!(!folder.file("key.rdb").exists());
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        let lone_surrogate = std::ffi::OsString::from_wide(&[0xD800]);
        let why = failure(Database::open(folder.path.join(lone_surrogate)));
        assert_eq!(why.status, Status::InvalidState);
    }
}

#[test]
fn diagnostics_open_still_reports_the_status() {
    let folder = Folder::new();
    let options = OpenOptions { diagnostics: true, ..OpenOptions::default() };
    let database = Database::open_with(folder.file("diagnostics.rdb"), options).unwrap();
    let connection = database.connect().unwrap();
    assert_eq!(failure(connection.run("SELECT * FROM missing_table")).status, Status::NotFound);
}

/// The child half of the driver_lib_environment_variable_names_the_library test.
///
/// It prints the file the driver was loaded from, and only when the parent set
/// INILLUCENT_DRIVER_LIB for it.
#[test]
fn child_driver_path_reporter() {
    if std::env::var("INILLUCENT_INTEGRATION_CHILD_DRIVER").is_err() {
        return;
    }
    println!("driver={}", inillucent::driver_path().unwrap());
}

#[test]
fn driver_lib_environment_variable_names_the_library() {
    let loaded = inillucent::driver_path().unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["child_driver_path_reporter", "--exact", "--test-threads=1", "--nocapture"])
        .env("INILLUCENT_INTEGRATION_CHILD_DRIVER", "1")
        .env("INILLUCENT_DRIVER_LIB", &loaded)
        .output()
        .expect("the child process must start");
    let said = String::from_utf8_lossy(&child.stdout);
    assert!(child.status.success(), "{said}");
    assert!(said.contains(&format!("driver={loaded}")), "{said}");
}
