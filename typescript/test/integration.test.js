// Runs every scenario in conformance/integration.md against the built package.
//
// conformance/suite.json grades what a statement does. These grade what the
// library around the statement does: opening, closing and reopening a file, a
// transaction object, a prepared statement reused with new values, a backup, a
// cancel sent while a statement runs on another thread, and a second process
// writing the same file. Each test uses a real database file in a fresh
// temporary folder and deletes the folder when it ends. Nothing is mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  Database,
  InillucentError,
  UnsupportedError,
  Rows,
  Status,
  Support,
  abiVersion,
  capabilities,
  connect,
  driverPath,
  statusName,
  supports,
  version,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CHILD_WRITER = resolve(here, 'fixtures', 'child-writer.mjs');
const COUNT_TO_A_HUNDRED_MILLION =
  'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000000) SELECT count(*) FROM n';

/**
 * Runs a test body with a fresh temporary folder, and deletes the folder after.
 * @param body - receives the folder path, and may return a promise
 */
async function inFolder(body) {
  const folder = mkdtempSync(join(tmpdir(), 'inillucent-integration-ts-'));
  try {
    return await body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Asserts that a call throws an InillucentError with the given status, and
 * returns the error so the caller can check more of it.
 * @param call - the call expected to fail
 * @param status - the status it must fail with
 */
function failsWith(call, status) {
  let caught;
  try {
    call();
  } catch (why) {
    caught = why;
  }
  assert.ok(caught instanceof InillucentError, `expected an InillucentError with ${statusName(status)}, got ${caught}`);
  assert.equal(caught.statusName, statusName(status), caught.message);
  return caught;
}

/**
 * Opens a database with one connection on it, creates a one column note table,
 * and returns both.
 * @param path - the database file
 */
function withNotes(path) {
  const database = new Database(path);
  const connection = database.connect();
  connection.execute('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)');
  return { database, connection };
}

// Files

test('file_survives_close_and_reopen', () =>
  inFolder((folder) => {
    const path = join(folder, 'survive.rdb');
    const { database, connection } = withNotes(path);
    connection.execute('INSERT INTO note (body) VALUES (?1), (?2)', ['first', 'second']);
    assert.equal(database.path, path);
    database.close();

    const again = new Database(path);
    try {
      const rows = again.connect().query('SELECT id, body FROM note ORDER BY id');
      assert.deepEqual(rows, [{ id: 1, body: 'first' }, { id: 2, body: 'second' }]);
    } finally {
      again.close();
    }
  }));

test('missing_file_without_create_is_not_found', () =>
  inFolder((folder) => {
    const path = join(folder, 'absent.rdb');
    failsWith(() => new Database(path, { create: false }), Status.NotFound);
    assert.equal(existsSync(path), false, 'a refused open must not create the file');
  }));

test('read_only_open_reads_and_refuses_writes', () =>
  inFolder((folder) => {
    const path = join(folder, 'readonly.rdb');
    const { database, connection } = withNotes(path);
    connection.execute("INSERT INTO note (body) VALUES ('kept')");
    database.close();

    const reader = connect(path, { readOnly: true });
    try {
      assert.deepEqual(reader.query('SELECT body FROM note'), [{ body: 'kept' }]);
      failsWith(() => reader.execute("INSERT INTO note (body) VALUES ('refused')"), Status.ReadOnly);
      assert.equal(reader.scalar('SELECT count(*) FROM note'), 1);
    } finally {
      reader.close();
    }
  }));

test('second_handle_in_the_same_process_sees_committed_rows', () =>
  inFolder((folder) => {
    const path = join(folder, 'two-handles.rdb');
    const first = withNotes(path);
    const second = connect(path);
    try {
      // The second handle reads before the first one writes. On 1.0.33 a freshly
      // opened handle holds a read lock on the file until it runs its first
      // statement, so a write through the first handle before that waits the
      // whole 5 second busy_timeout and fails with `busy`. That is an engine
      // defect, reproduced through the C ABI alone, and reported in task-2156.
      assert.equal(second.scalar('SELECT count(*) FROM note'), 0);
      first.connection.execute("INSERT INTO note (body) VALUES ('from the first handle')");
      assert.deepEqual(second.query('SELECT body FROM note'), [{ body: 'from the first handle' }]);
    } finally {
      second.close();
      first.database.close();
    }
  }));

test('another_process_writes_and_this_one_reads_it', () =>
  inFolder((folder) => {
    const path = join(folder, 'shared.rdb');
    const { database, connection } = withNotes(path);
    try {
      const child = spawnSync(process.execPath, [CHILD_WRITER, path, 'from the child'], { encoding: 'utf8' });
      assert.equal(child.status, 0, `the child process failed: ${child.stderr}`);
      assert.deepEqual(connection.query('SELECT body FROM note'), [{ body: 'from the child' }]);
    } finally {
      database.close();
    }
  }));

// Statements

test('prepared_statement_runs_many_times_with_fresh_bindings', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'prepared.rdb'));
    try {
      db.execute('CREATE TABLE t (n INTEGER, label TEXT)');
      const insert = db.prepare('INSERT INTO t (n, label) VALUES (?1, ?2)');
      for (let n = 0; n < 100; n += 1) assert.equal(insert.execute([n, `row ${n}`]).affected, 1);
      insert.close();
      assert.equal(db.scalar('SELECT count(*) FROM t'), 100);
      assert.equal(db.scalar('SELECT sum(n) FROM t'), 4950);
      assert.equal(db.scalar('SELECT label FROM t WHERE n = 42'), 'row 42');

      const add = db.prepare('SELECT ?1 + ?2');
      assert.equal(add.execute([2, 3]).scalar(), 5);
      assert.equal(add.execute([2]).scalar(), null, 'bindings are cleared, so ?2 is NULL');
      add.close();

      const one = db.prepare('SELECT ?1');
      const refused = failsWith(() => one.execute([1, 2]), Status.InvalidState);
      assert.match(refused.message, /\?2/);
      assert.equal(one.execute([3]).scalar(), 3, 'the statement is still usable after the refusal');
      one.close();
      failsWith(() => db.execute('SELECT ?1', [1, 2]), Status.InvalidState);
    } finally {
      db.close();
    }
  }));

test('rows_report_counts_columns_and_limits', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'rows.rdb'));
    try {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      const written = db.execute("INSERT INTO t (v) VALUES ('a'), ('b')");
      assert.equal(written.affected, 2);
      assert.equal(written.tag, 'INSERT 2');
      db.execute("INSERT INTO t (v) VALUES ('c'), ('d'), ('e')");

      const page = db.execute('SELECT id, v FROM t ORDER BY id', [], 2);
      assert.equal(page.rows.length, 2);
      assert.equal(page.length, 2);
      assert.equal(page.total, 5);
      assert.equal(page.more, true);
      assert.equal(page.affected, null);
      assert.deepEqual(page.columns, ['id', 'v']);
      // The engine returns '' for a declared column type on 1.0.33 (see
      // integration.md), so only the count is asserted.
      assert.equal(page.columnTypes.length, 2);
      assert.ok(page.elapsedMicros >= 0);
    } finally {
      db.close();
    }
  }));

test('last_insert_rowid_and_total_changes', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'rowid.rdb'));
    try {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      const before = db.totalChanges;
      db.execute("INSERT INTO t (v) VALUES ('one')");
      assert.equal(db.totalChanges, before + 1);
      db.execute("INSERT INTO t (v) VALUES ('two')");
      assert.equal(db.lastInsertRowid, db.scalar("SELECT id FROM t WHERE v = 'two'"));
      assert.equal(db.lastInsertRowid, 2);
      db.execute("UPDATE t SET v = v || '!'");
      assert.equal(db.totalChanges, before + 4);
    } finally {
      db.close();
    }
  }));

test('schema_cookie_changes_when_the_schema_does', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'cookie.rdb'));
    try {
      db.execute('CREATE TABLE t (v INTEGER)');
      const cookie = db.schemaCookie;
      db.execute('SELECT * FROM t');
      db.execute('INSERT INTO t VALUES (1)');
      assert.equal(db.schemaCookie, cookie);
      db.execute('CREATE TABLE u (v INTEGER)');
      assert.notEqual(db.schemaCookie, cookie);
    } finally {
      db.close();
    }
  }));

test('execute_batch_runs_every_statement', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'batch.rdb'));
    try {
      db.executeBatch('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)');
      assert.equal(db.scalar('SELECT count(*) FROM t'), 3);
      failsWith(() => db.executeBatch('INSERT INTO t VALUES (4); INSERT INTO; INSERT INTO t VALUES (5)'), Status.Syntax);
    } finally {
      db.close();
    }
  }));

/**
 * Returns one megabyte of text made of characters outside the basic
 * multilingual plane, each of which is four bytes in UTF-8 and a surrogate pair
 * in JavaScript.
 */
function astralText() {
  const pieces = ['\u{1F600}', '\u{1D11E}', '\u{10348}', '\u{1F3B5}'].join('');
  return pieces.repeat((1024 * 1024) / Buffer.byteLength(pieces, 'utf8'));
}

test('large_values_round_trip', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'large.rdb'));
    try {
      db.execute('CREATE TABLE big (id INTEGER PRIMARY KEY, b BLOB, t TEXT)');
      const blob = Buffer.alloc(1024 * 1024);
      for (let at = 0; at < blob.length; at += 1) blob[at] = at % 256;
      const text = astralText();
      db.execute('INSERT INTO big (id, b, t) VALUES (1, ?1, ?2)', [blob, text]);
      const [row] = db.execute('SELECT b, t FROM big WHERE id = 1').rows;
      assert.ok(Buffer.isBuffer(row[0]));
      assert.ok(blob.equals(row[0]), 'the blob came back different');
      assert.equal(row[1], text);
    } finally {
      db.close();
    }
  }));

/**
 * Returns a little endian float32 vector as bytes, the form a VECTOR column binds.
 * @param values - the vector's components
 */
function vectorBytes(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, nth) => bytes.writeFloatLE(value, nth * 4));
  return bytes;
}

test('search_with_bound_parameters', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'search.rdb'));
    try {
      db.execute('CREATE VIRTUAL TABLE docs USING fts5(body)');
      db.execute("INSERT INTO docs(rowid, body) VALUES (1, 'the quick brown fox'), (2, 'a lazy dog'), (3, 'brown bread')");
      const found = db.execute('SELECT rowid FROM docs WHERE docs MATCH ?1 ORDER BY rowid', ['brown']);
      assert.deepEqual(found.column(0), [1, 3]);

      db.execute('CREATE TABLE place (id INTEGER PRIMARY KEY, at VECTOR(2))');
      const insert = db.prepare('INSERT INTO place (id, at) VALUES (?1, ?2)');
      insert.execute([1, vectorBytes([1, 0])]);
      insert.execute([2, vectorBytes([0, 1])]);
      insert.execute([3, vectorBytes([0.7, 0.7])]);
      insert.close();
      const nearest = db.execute('SELECT id FROM place ORDER BY vector_distance_cos(at, ?1)', [vectorBytes([0.1, 1])]);
      assert.equal(nearest.scalar(), 2);
      assert.deepEqual(nearest.column('id'), [2, 3, 1]);
    } finally {
      db.close();
    }
  }));

// Transactions

test('transaction_commits_all_of_it', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'commit.rdb'));
    try {
      db.execute('CREATE TABLE t (v INTEGER)');
      const txn = db.transaction();
      assert.equal(txn.execute('INSERT INTO t VALUES (1)'), 1);
      assert.equal(txn.execute('INSERT INTO t VALUES (2), (3)'), 2);
      assert.deepEqual(txn.affected, [1, 2]);
      assert.equal(db.inTransaction, true);
      txn.commit();
      assert.equal(db.inTransaction, false);
      assert.equal(db.scalar('SELECT count(*) FROM t'), 3);
      failsWith(() => txn.commit(), Status.InvalidState);
    } finally {
      db.close();
    }
  }));

test('transaction_rolls_back_when_asked_and_when_abandoned', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'rollback.rdb'));
    try {
      db.execute('CREATE TABLE t (v INTEGER)');
      const asked = db.transaction();
      asked.execute('INSERT INTO t VALUES (1)');
      asked.rollback();
      asked.rollback();
      assert.equal(db.scalar('SELECT count(*) FROM t'), 0);

      // JavaScript's scope mechanism: `using` calls Symbol.dispose, and on a
      // node without `using` try/finally is the same call.
      const abandoned = db.transaction();
      try {
        abandoned.execute('INSERT INTO t VALUES (2)');
      } finally {
        abandoned[Symbol.dispose]();
      }
      assert.equal(db.inTransaction, false);
      assert.equal(db.scalar('SELECT count(*) FROM t'), 0);
    } finally {
      db.close();
    }
  }));

test('a_failing_statement_rolls_the_transaction_back', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'failing.rdb'));
    try {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const txn = db.transaction();
      txn.execute('INSERT INTO t VALUES (1)');
      failsWith(() => txn.execute('INSERT INTO t VALUES (1)'), Status.Constraint);
      assert.equal(db.scalar('SELECT count(*) FROM t'), 0);
      assert.equal(db.inTransaction, false);
      failsWith(() => txn.execute('INSERT INTO t VALUES (2)'), Status.InvalidState);
      failsWith(() => txn.commit(), Status.InvalidState);
      assert.equal(db.scalar('SELECT count(*) FROM t'), 0);
    } finally {
      db.close();
    }
  }));

// Errors

test('errors_carry_status_offset_and_message', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'errors.rdb'));
    try {
      const syntax = failsWith(() => db.execute('SELECT * FROM t WHERE'), Status.Syntax);
      assert.equal(syntax.offset, 21);
      assert.match(syntax.message, /at byte 21/);
      const missing = failsWith(() => db.execute('SELECT * FROM missing_table'), Status.NotFound);
      assert.ok(missing.message.length > 0);
      assert.equal(missing.feature, undefined);

      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      db.execute('INSERT INTO t VALUES (1)');
      failsWith(() => db.execute('INSERT INTO t VALUES (1)'), Status.Constraint);

      const refused = failsWith(() => db.execute('CREATE VIRTUAL TABLE f USING fts5(a, detail=none)'), Status.Unsupported);
      assert.ok(refused instanceof UnsupportedError);
      assert.equal(refused.name, 'UnsupportedError');
      assert.ok(refused.feature.includes('detail=none'), refused.feature);
    } finally {
      db.close();
    }
  }));

test('closing_refuses_while_a_statement_is_open', () =>
  inFolder((folder) => {
    const database = new Database(join(folder, 'refuse.rdb'));
    const connection = database.connect();
    const statement = connection.prepare('SELECT 1 + ?1');
    failsWith(() => database.close(), Status.InvalidState);
    assert.equal(statement.execute([1]).scalar(), 2, 'the statement still executes');
    // The refused close kept the database, and the connection, open and usable.
    database.checkpoint();
    assert.equal(connection.scalar('SELECT 40 + 2'), 42);
    statement.close();
    statement.close();
    database.close();
    database.close();
  }));

test('closing_refuses_while_a_transaction_is_open, through connect()', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'refuse-owned.rdb'));
    const txn = db.transaction();
    failsWith(() => db.close(), Status.InvalidState);
    txn.rollback();
    db.close();
    db.close();
    failsWith(() => db.execute('SELECT 1'), Status.InvalidState);
  }));

test('use_after_close_is_an_error_not_a_crash', () =>
  inFolder((folder) => {
    const database = new Database(join(folder, 'after-close.rdb'));
    const connection = database.connect();
    const statement = connection.prepare('SELECT 1');
    statement.close();
    failsWith(() => statement.execute(), Status.InvalidState);
    connection.close();
    connection.close();
    failsWith(() => connection.execute('SELECT 1'), Status.InvalidState);
    failsWith(() => connection.executeBatch('SELECT 1'), Status.InvalidState);
    failsWith(() => connection.prepare('SELECT 1'), Status.InvalidState);
    failsWith(() => connection.transaction(), Status.InvalidState);
    assert.ok(database.connect().scalar('SELECT 1') === 1, 'the database is still open');
    database.close();
    database.close();
    failsWith(() => database.connect(), Status.InvalidState);
    failsWith(() => database.checkpoint(), Status.InvalidState);
  }));

// Engine facts

/**
 * Returns an ABI version string as a number that orders correctly.
 * @param text - such as '1.1.0'
 */
function abiNumber(text) {
  const [major, minor, patch] = text.split('.').map(Number);
  return major * 1_000_000 + minor * 1000 + patch;
}

test('capabilities_and_versions', () => {
  const rows = capabilities();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(row.name.length > 0, 'every capability has a name');
    assert.equal(typeof row.note, 'string');
    assert.equal(row.supported, row.support === Support.Yes || row.support === Support.Partial);
  }
  assert.equal(supports('cancel'), Support.Partial);
  assert.equal(supports('encryption'), Support.Yes);
  assert.equal(supports('load_extension'), Support.No);
  assert.equal(supports('a_capability_nobody_declared'), Support.Unknown);
  assert.ok(version().includes('1.0.'), version());
  assert.ok(abiNumber(abiVersion()) >= abiNumber('1.1.0'), abiVersion());
  assert.ok(existsSync(driverPath()), driverPath());
});

test('checkpoint_integrity_check_and_backup', () =>
  inFolder((folder) => {
    const database = new Database(join(folder, 'source.rdb'));
    const connection = database.connect();
    try {
      connection.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      connection.execute("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')");
      database.checkpoint();
      database.integrityCheck();
      const copy = join(folder, 'copy.rdb');
      database.backupTo(copy);
      database.backupTo(copy);
      const restored = connect(copy);
      try {
        assert.deepEqual(restored.query('SELECT v FROM t ORDER BY id').map((row) => row.v), ['a', 'b', 'c']);
      } finally {
        restored.close();
      }
    } finally {
      database.close();
    }
  }));

test('cancel_from_another_thread_interrupts_and_the_connection_survives', () =>
  inFolder(async (folder) => {
    // execute() blocks the event loop, so nothing on this thread could call
    // cancel() while it runs. executeAsync() runs the statement on a koffi
    // worker thread, and cancel() is called from this thread 100 ms later.
    const db = connect(join(folder, 'cancel.rdb'));
    try {
      const started = Date.now();
      const running = db.executeAsync(COUNT_TO_A_HUNDRED_MILLION);
      failsWith(() => db.execute('SELECT 1'), Status.Busy);
      const timer = setTimeout(() => db.cancel(), 100);
      await assert.rejects(running, (why) => why instanceof InillucentError && why.status === Status.Interrupted);
      clearTimeout(timer);
      const elapsed = Date.now() - started;
      console.log(`cancel interrupted the statement after ${elapsed} ms`);
      assert.ok(elapsed < 10_000, `the cancel took ${elapsed} ms to stop the statement`);
      assert.equal(db.scalar('SELECT 1 + 1'), 2, 'the connection survives the cancel');

      db.cancel();
      assert.equal(db.scalar('SELECT 2 + 2'), 4, 'a cancel with nothing running cancels nothing');
    } finally {
      db.close();
    }
  }));

test('execute_async_returns_rows_and_binds_values', () =>
  inFolder(async (folder) => {
    const db = connect(join(folder, 'async.rdb'));
    try {
      db.execute('CREATE TABLE t (v INTEGER)');
      const written = await db.executeAsync('INSERT INTO t VALUES (?1), (?2)', [5, 7]);
      assert.equal(written.affected, 2);
      const rows = await db.executeAsync('SELECT v FROM t ORDER BY v', [], 1);
      assert.deepEqual(rows.rows, [[5]]);
      assert.equal(rows.more, true);
      await assert.rejects(db.executeAsync('SELECT * FROM missing_table'), (why) => why.status === Status.NotFound);
      await assert.rejects(db.executeAsync('SELECT ?1', [{}]), TypeError);
      assert.equal(db.scalar('SELECT count(*) FROM t'), 2, 'nothing is left marked busy');
    } finally {
      db.close();
    }
  }));

test('encryption', () =>
  inFolder((folder) => {
    const path = join(folder, 'vault.rdb');
    const key = "x'" + '5a'.repeat(32) + "'";
    const secret = 'the vault code is 7461';
    const db = connect(path, { key });
    db.execute('CREATE TABLE vault (id INTEGER PRIMARY KEY, note TEXT)');
    db.execute('INSERT INTO vault (note) VALUES (?1)', [secret]);
    db.close();

    for (const name of readdirSync(folder)) {
      assert.ok(!readFileSync(join(folder, name)).includes(secret), `${name} holds the plaintext`);
    }
    const again = connect(path, { key });
    try {
      assert.deepEqual(again.query('SELECT note FROM vault').map((row) => row.note), [secret]);
      assert.equal(again.scalar('PRAGMA encryption'), 'xchacha20-poly1305');
    } finally {
      again.close();
    }
    const wrongKey = "x'" + '3c'.repeat(32) + "'";
    for (const options of [{}, { key: wrongKey }]) failsWith(() => connect(path, options), Status.Corrupt);
  }));

// Finding the shared library.

/**
 * Copies the built package into a folder with no shared library in or beside
 * it, runs a child process that loads it and prints what driverPath() says or
 * what failed, and returns that output.
 * @param folder - an empty temporary folder
 * @param searchPath - the PATH the child process gets, the OS library search path on Windows
 */
function loadFromBareCopy(folder, searchPath) {
  const dist = join(folder, 'pkg', 'dist');
  cpSync(resolve(here, '..', 'dist'), dist, { recursive: true });
  writeFileSync(join(folder, 'pkg', 'package.json'), '{"type": "module"}');
  const script =
    `import(${JSON.stringify(pathToFileURL(join(dist, 'index.js')).href)})` +
    '.then((m) => console.log("loaded " + m.driverPath()))' +
    '.catch((why) => console.log(why.name + ": " + why.message))';
  // Windows spells the variable Path, so every spelling is replaced by one.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^path$/i.test(name) && name !== 'INILLUCENT_DRIVER_LIB'),
  );
  Object.assign(env, { NODE_PATH: resolve(here, '..', 'node_modules'), PATH: searchPath });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
  return `${child.stdout}${child.stderr}`;
}

test('the shared library is found on the operating system search path, and its absence is named', () =>
  inFolder((folder) => {
    const nowhere = loadFromBareCopy(join(folder, 'nowhere'), dirname(process.execPath));
    assert.match(nowhere, /^DriverLoadError: cannot find the inillucent driver shared library/);
    assert.match(nowhere, /library search path/);

    const onPath = loadFromBareCopy(join(folder, 'on-path'), `${dirname(driverPath())}${delimiter}${dirname(process.execPath)}`);
    assert.match(onPath, /^loaded (inillucent_driver_capi\.dll|libinillucent_driver_capi\.(so|dylib))/);
  }));

// The rest of the public API, so every method is exercised at least once.

test('values bind by their JavaScript type and read back as the same kind', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'values.rdb'));
    try {
      const row = db.execute('SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8', [
        true, false, 9007199254740993n, 2.5, null, new Uint8Array([1, 2, 3]), '', Buffer.alloc(0),
      ]).one();
      assert.deepEqual(row.slice(0, 5), [1, 0, 9007199254740993n, 2.5, null]);
      assert.deepEqual([...row[5]], [1, 2, 3]);
      assert.equal(row[6], '');
      assert.equal(row[7].length, 0);
      const statement = db.prepare('SELECT typeof(?1)');
      statement.bind(1, undefined);
      assert.equal(statement.execute().scalar(), 'null', 'execute with no values clears the bindings');
      assert.throws(() => statement.bind(1, { not: 'a value' }), TypeError);
      statement[Symbol.dispose]();
    } finally {
      db[Symbol.dispose]();
    }
  }));

test('a result can be read as rows, objects, one column or one value', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'shapes.rdb'));
    try {
      const rows = db.execute("SELECT 1 AS a, 'x' AS b UNION ALL SELECT 2, 'y'");
      assert.ok(rows instanceof Rows);
      assert.deepEqual([...rows], [[1, 'x'], [2, 'y']]);
      assert.deepEqual(rows.one(), [1, 'x']);
      assert.deepEqual(rows.column('b'), ['x', 'y']);
      assert.throws(() => rows.column('c'), RangeError);
      assert.deepEqual(rows.objects(), [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
      const none = db.execute('SELECT 1 WHERE 0');
      assert.equal(none.one(), undefined);
      assert.equal(none.scalar(), undefined);
    } finally {
      db.close();
    }
  }));

test('a database closes its connections, and disposing does the same', () =>
  inFolder((folder) => {
    const database = new Database(join(folder, 'dispose.rdb'), { diagnostics: true });
    const connection = database.connect();
    connection.execute('CREATE TABLE t (v INTEGER)');
    database[Symbol.dispose]();
    failsWith(() => connection.execute('SELECT 1'), Status.InvalidState);
    connection[Symbol.dispose]();
    assert.equal(statusName(99), 'status 99');
  }));
