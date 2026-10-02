<?php

declare(strict_types=1);

// Runs every scenario in conformance/integration.md against this client.
//
// suite.json grades what a statement does. These scenarios grade the library
// around the statement: opening, closing and reopening a file, a transaction
// object, a prepared statement run many times, a backup, a cancel and a second
// process writing the same file. Each one runs against a real database file in
// a fresh temporary folder, through the public API, and the folder is deleted
// when the scenario ends.
//
// Run it with `php tests/integration.php`. It exits 0 when every scenario passed
// and 1 otherwise. Started with the arguments `child <path>` it is instead the
// second process of another_process_writes_and_this_one_reads_it.

require __DIR__ . '/../autoload.php';

use Inillucent\Blob;
use Inillucent\Capability;
use Inillucent\Connection;
use Inillucent\Database;
use Inillucent\Driver;
use Inillucent\InillucentException;
use Inillucent\Rows;
use Inillucent\Status;
use Inillucent\Support;
use Inillucent\UnsupportedFeatureException;

/** A scenario's expectation that did not hold. */
final class ScenarioFailed extends RuntimeException
{
}

/**
 * Throws with a message unless a condition holds.
 *
 * @param bool $condition what must be true
 * @param string $message what went wrong when it is not
 */
function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new ScenarioFailed($message);
    }
}

/**
 * Throws unless two values are identical, naming both.
 *
 * @param mixed $want the expected value
 * @param mixed $got the value that came back
 * @param string $what what the value is
 */
function same(mixed $want, mixed $got, string $what): void
{
    check($want === $got, $what . ' is ' . var_export($got, true) . ' and should be ' . var_export($want, true));
}

/**
 * Runs a call that must fail with a status, and returns the failure.
 *
 * @param Status $status the status it must fail with
 * @param callable $action the call that must fail
 * @param string $what what the call was, for the message
 */
function refused(Status $status, callable $action, string $what): InillucentException
{
    try {
        $action();
    } catch (InillucentException $failure) {
        check(
            $failure->status === $status,
            "$what failed with {$failure->status->label()} and should fail with {$status->label()}: "
            . $failure->getMessage()
        );
        return $failure;
    }
    throw new ScenarioFailed("$what succeeded and should fail with {$status->label()}");
}

/**
 * Returns the number of rows in a table.
 *
 * @param Connection $connection the connection to ask
 * @param string $table the table to count
 */
function row_count(Connection $connection, string $table): int
{
    return $connection->scalar("SELECT count(*) FROM $table");
}

/**
 * Creates a fresh temporary folder for one scenario and returns its path.
 */
function make_folder(): string
{
    $folder = sys_get_temp_dir() . DIRECTORY_SEPARATOR
        . 'inillucent-php-integration-' . getmypid() . '-' . bin2hex(random_bytes(6));
    mkdir($folder, 0777, true);
    return $folder;
}

/**
 * Deletes a folder this runner created and everything in it, including the
 * engine's .rdb-wal files.
 *
 * @param string $folder the folder make_folder returned
 */
function remove_folder(string $folder): void
{
    foreach (scandir($folder) ?: [] as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        $path = $folder . DIRECTORY_SEPARATOR . $entry;
        is_dir($path) ? remove_folder($path) : unlink($path);
    }
    rmdir($folder);
}

/**
 * Runs one scenario in a fresh temporary folder, deletes the folder, and
 * prints whether it passed.
 *
 * @param string $name the scenario's function name
 */
function run_scenario(string $name): bool
{
    $folder = make_folder();
    try {
        $name($folder);
        echo '  ok    ', $name, PHP_EOL;
        return true;
    } catch (Throwable $failure) {
        echo '  FAIL  ', $name, PHP_EOL;
        echo '          ', get_class($failure), ': ', $failure->getMessage(), PHP_EOL;
        echo '          at ', $failure->getFile(), ':', $failure->getLine(), PHP_EOL;
        return false;
    } finally {
        // Anything the scenario still holds is released before its files go.
        gc_collect_cycles();
        remove_folder($folder);
    }
}

/**
 * The child process: opens the file, inserts one row, closes and exits 0.
 *
 * @param string $path the database file the parent holds open
 */
function run_child(string $path): int
{
    $told = getenv('INILLUCENT_DRIVER_LIB');
    if (!is_string($told) || realpath($told) !== realpath(Driver::path())) {
        fwrite(STDERR, 'the child loaded ' . Driver::path() . ' and was told ' . var_export($told, true) . PHP_EOL);
        return 2;
    }
    $database = Database::open($path);
    $connection = $database->connect();
    $connection->execute('INSERT INTO t (v) VALUES (?1)', ['from the child']);
    $database->close();
    return 0;
}

// ---------------------------------------------------------------- Files

/**
 * Writes two rows, closes, reopens the same path and reads both rows back.
 *
 * @param string $folder the scenario's temporary folder
 */
function file_survives_close_and_reopen(string $folder): void
{
    $path = $folder . DIRECTORY_SEPARATOR . 'kept.rdb';
    $database = Database::open($path);
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    $connection->execute('INSERT INTO t VALUES (?1, ?2)', [1, 'one']);
    $connection->execute('INSERT INTO t VALUES (?1, ?2)', [2, 'two']);
    $database->close();

    $database = Database::open($path);
    $connection = $database->connect();
    same(realpath($path), realpath($database->path()), 'the database path');
    same([[1, 'one'], [2, 'two']], $connection->execute('SELECT id, v FROM t ORDER BY id')->rows, 'the rows after reopening');
    $database->close();
}

/**
 * Opening a missing path with create turned off fails as not_found and leaves
 * no file behind.
 *
 * @param string $folder the scenario's temporary folder
 */
function missing_file_without_create_is_not_found(string $folder): void
{
    $path = $folder . DIRECTORY_SEPARATOR . 'absent.rdb';
    refused(Status::NotFound, static fn () => Database::open($path, create: false)->close(), 'opening a missing file without create');
    check(!file_exists($path), 'opening without create made a file at the path');
}

/**
 * A read only open answers a SELECT and refuses an INSERT as readonly.
 *
 * @param string $folder the scenario's temporary folder
 */
function read_only_open_reads_and_refuses_writes(string $folder): void
{
    $path = $folder . DIRECTORY_SEPARATOR . 'read-only.rdb';
    $database = Database::open($path);
    $database->connect()->executeBatch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a'); INSERT INTO t VALUES ('b')");
    $database->close();

    $database = Database::open($path, create: false, readOnly: true);
    $connection = $database->connect();
    same(2, count($connection->query('SELECT v FROM t')), 'the rows read through a read only open');
    refused(Status::ReadOnly, static fn () => $connection->execute("INSERT INTO t VALUES ('c')"), 'an INSERT on a read only open');
    same(2, row_count($connection, 't'), 'the row count after the refused INSERT');
    $database->close();
}

/**
 * Two handles on one file in one process: a row written through the first is
 * read through the second.
 *
 * @param string $folder the scenario's temporary folder
 */
function second_handle_in_the_same_process_sees_committed_rows(string $folder): void
{
    $path = $folder . DIRECTORY_SEPARATOR . 'shared.rdb';
    $first = Database::open($path);
    $writer = $first->connect();
    $writer->execute('CREATE TABLE t (v TEXT)');
    $second = Database::open($path);
    $reader = $second->connect();
    // On inillucent 1.0.33 a database that was just opened holds a read lock on
    // the file until a statement runs on it, so a write through the first handle
    // at this point waits out busy_timeout and fails with Status::Busy. The
    // second handle therefore reads once first, which also shows it empty.
    same(0, row_count($reader, 't'), 'the rows the second handle sees before the insert');
    $writer->execute('INSERT INTO t VALUES (?1)', ['seen']);
    same('seen', $reader->scalar('SELECT v FROM t'), 'the row read through the second handle');
    $second->close();
    $first->close();
}

/**
 * A child process writes a row into a file this process holds open, and this
 * process reads it without reopening.
 *
 * @param string $folder the scenario's temporary folder
 */
function another_process_writes_and_this_one_reads_it(string $folder): void
{
    $path = $folder . DIRECTORY_SEPARATOR . 'two-processes.rdb';
    $database = Database::open($path);
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    // The child finds the same library through INILLUCENT_DRIVER_LIB, the first
    // place every client looks, so that lookup is exercised too.
    $environment = getenv();
    $environment['INILLUCENT_DRIVER_LIB'] = Driver::path();
    $child = proc_open(
        [PHP_BINARY, __FILE__, 'child', $path],
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        null,
        $environment
    );
    check(is_resource($child), 'the child process did not start');
    $said = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($child);
    same(0, $code, "the child's exit code (it said: $said)");
    same('from the child', $connection->scalar('SELECT v FROM t'), 'the row the child wrote');
    $database->close();
}

// ---------------------------------------------------------------- Statements

/**
 * One prepared INSERT runs 100 times with new values, a parameter left unbound
 * on a later run reads as NULL, and a value past the last placeholder is
 * refused as invalid_state.
 *
 * @param string $folder the scenario's temporary folder
 */
function prepared_statement_runs_many_times_with_fresh_bindings(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'prepared.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (n INTEGER, label TEXT)');
    $insert = $connection->prepare('INSERT INTO t (n, label) VALUES (?1, ?2)');
    check($insert->connection() === $connection, 'the statement names another connection');
    for ($n = 0; $n < 100; $n++) {
        same(1, $insert->execute([$n, "row $n"])->affected, "the rows insert $n changed");
    }
    $insert->close();
    same(100, row_count($connection, 't'), 'the row count');
    same(4950, $connection->scalar('SELECT sum(n) FROM t'), 'the sum of the values');
    same('row 42', $connection->scalar('SELECT label FROM t WHERE n = 42'), 'the label of row 42');

    $add = $connection->prepare('SELECT ?1 + ?2');
    same(3, $add->execute([1, 2])->scalar(), '?1 + ?2 with both bound');
    same(null, $add->execute([1])->scalar(), '?1 + ?2 with only ?1 bound');
    $add->close();
    // The engine refuses a value past the last placeholder. The client used to
    // ignore the bind status and drop the value silently.
    refused(Status::InvalidState, static fn () => $connection->execute('SELECT ?1', [1, 2]), 'SELECT ?1 with two values');
    $database->close();
}

/**
 * A write reports affected and its tag, and a limited SELECT reports the rows
 * handed back, the exact total, more, and its columns.
 *
 * @param string $folder the scenario's temporary folder
 */
function rows_report_counts_columns_and_limits(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'rows.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    $written = $connection->execute("INSERT INTO t (v) VALUES ('a'), ('b')");
    same(2, $written->affected, 'affected for a two row INSERT');
    same('INSERT 2', $written->tag, 'the tag for a two row INSERT');
    $connection->execute("INSERT INTO t (v) VALUES ('c'), ('d'), ('e')");

    $page = $connection->execute('SELECT id, v FROM t ORDER BY id', [], 2);
    same(2, count($page), 'rows handed back under a limit of 2');
    same(5, $page->total, 'total under a limit of 2');
    same(true, $page->more, 'more under a limit of 2');
    same(null, $page->affected, 'affected for a SELECT');
    same(['id', 'v'], $page->columns, 'the column names');
    // The engine returns "" for a plain column's declared type on 1.0.33, so
    // only the count is asserted. See integration.md.
    same(2, count($page->columnTypes), 'the declared type entries');
    check($page->elapsedMicros >= 0, 'elapsedMicros is negative');
    same(1, $page->get(0, 'id'), 'get by column name');
    same(null, $page->get(0, 'missing'), 'get for a column that is not there');
    same(1, $page->columnIndex('v'), 'columnIndex of v');
    same('a', $page->objects()[0]['v'], 'objects keyed by name');
    same([1, 'a'], $page->one(), 'one');
    same(2, iterator_count($page->getIterator()), 'the rows walked by the iterator');
    $database->close();
}

/**
 * The last insert rowid follows each insert, and total changes goes up by the
 * rows each write changed.
 *
 * @param string $folder the scenario's temporary folder
 */
function last_insert_rowid_and_total_changes(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'rowid.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    $before = $connection->totalChanges();
    $connection->execute("INSERT INTO t (id, v) VALUES (10, 'a')");
    same(10, $connection->lastInsertRowid(), 'the last insert rowid after the first insert');
    $connection->execute("INSERT INTO t (id, v) VALUES (11, 'b')");
    same(11, $connection->lastInsertRowid(), 'the last insert rowid after the second insert');
    same($before + 2, $connection->totalChanges(), 'total changes after two inserts');
    $connection->execute("UPDATE t SET v = 'c'");
    same($before + 4, $connection->totalChanges(), 'total changes after updating two rows');
    $database->close();
}

/**
 * The schema cookie holds across a SELECT and an INSERT and moves on a CREATE
 * TABLE.
 *
 * @param string $folder the scenario's temporary folder
 */
function schema_cookie_changes_when_the_schema_does(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'cookie.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (v TEXT)');
    $cookie = $connection->schemaCookie();
    $connection->execute('SELECT * FROM t');
    $connection->execute("INSERT INTO t VALUES ('a')");
    same($cookie, $connection->schemaCookie(), 'the schema cookie after a SELECT and an INSERT');
    $connection->execute('CREATE TABLE u (v TEXT)');
    check($cookie !== $connection->schemaCookie(), 'the schema cookie did not change after CREATE TABLE');
    $database->close();
}

/**
 * A batch runs every statement, and a batch with an invalid statement fails as
 * syntax.
 *
 * @param string $folder the scenario's temporary folder
 */
function execute_batch_runs_every_statement(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'batch.rdb');
    $connection = $database->connect();
    $connection->executeBatch('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)');
    same(3, row_count($connection, 't'), 'the rows after the batch');
    refused(
        Status::Syntax,
        static fn () => $connection->executeBatch('INSERT INTO t VALUES (4); INSERT INTO t VALUES ('),
        'a batch whose second statement is invalid'
    );
    $database->close();
}

/**
 * A one megabyte blob of every byte value and a one megabyte text outside the
 * basic multilingual plane read back equal.
 *
 * @param string $folder the scenario's temporary folder
 */
function large_values_round_trip(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'large.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB, s TEXT)');
    $bytes = str_repeat(implode('', array_map('chr', range(0, 255))), 4096);
    $piece = "\u{1F600} a \u{10348} \u{E9} ";
    $text = str_repeat($piece, intdiv(1 << 20, strlen($piece)) + 1);
    $connection->execute('INSERT INTO t VALUES (1, ?1, ?2)', [new Blob($bytes), $text]);
    $row = $connection->execute('SELECT b, s FROM t WHERE id = 1')->one();
    check($row[0] instanceof Blob && $row[0]->bytes === $bytes, 'the blob read back different');
    check($row[1] === $text, 'the text read back different');
    same(1 << 20, $row[0]->length(), 'the blob length');
    $database->close();
}

/**
 * A bound FTS5 term finds its rowids, and a bound vector probe orders the
 * nearest row first.
 *
 * @param string $folder the scenario's temporary folder
 */
function search_with_bound_parameters(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'search.rdb');
    $connection = $database->connect();
    $connection->executeBatch('CREATE VIRTUAL TABLE docs USING fts5(body);'
        . "INSERT INTO docs(rowid, body) VALUES (1, 'the quick brown fox');"
        . "INSERT INTO docs(rowid, body) VALUES (2, 'a lazy dog');"
        . "INSERT INTO docs(rowid, body) VALUES (3, 'brown bread')");
    $found = $connection->execute('SELECT rowid FROM docs WHERE docs MATCH ?1 ORDER BY rowid', ['brown']);
    same([[1], [3]], $found->rows, 'the rowids matching brown');

    // pack('g') writes a little endian float, which is what a VECTOR column holds.
    $connection->execute('CREATE TABLE place (id INTEGER PRIMARY KEY, at VECTOR(2))');
    $connection->execute('INSERT INTO place VALUES (1, ?1)', [new Blob(pack('g*', 1.0, 0.0))]);
    $connection->execute('INSERT INTO place VALUES (2, ?1)', [new Blob(pack('g*', 0.0, 1.0))]);
    $connection->execute('INSERT INTO place VALUES (3, ?1)', [new Blob(pack('g*', -1.0, 0.0))]);
    $nearest = $connection->execute(
        'SELECT id FROM place ORDER BY vector_distance_cos(at, ?1)',
        [new Blob(pack('g*', 0.1, 0.9))]
    );
    same(2, $nearest->scalar(), 'the nearest row to (0.1, 0.9)');
    $database->close();
}

// ---------------------------------------------------------------- Transactions and errors

/**
 * Two inserts in a transaction report their affected counts before the commit,
 * and every row is there after it.
 *
 * @param string $folder the scenario's temporary folder
 */
function transaction_commits_all_of_it(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'commit.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (v TEXT)');
    $transaction = $connection->begin();
    same(1, $transaction->execute("INSERT INTO t VALUES ('a')"), "the first insert's affected count");
    same(2, $transaction->execute("INSERT INTO t VALUES ('b'), ('c')"), "the second insert's affected count");
    same([1, 2], $transaction->affected, 'the affected counts in order');
    check($connection->inTransaction(), 'inTransaction is false while the transaction is open');
    $transaction->commit();
    $transaction->commit();
    same(3, row_count($connection, 't'), 'the rows after commit');
    check(!$connection->inTransaction(), 'inTransaction is true after commit');
    $database->close();
}

/**
 * Inserts one row in a transaction and returns without committing, so the
 * transaction goes out of scope and its destructor rolls it back.
 *
 * @param Connection $connection the connection to use
 */
function insert_and_abandon(Connection $connection): void
{
    $abandoned = $connection->begin();
    $abandoned->execute("INSERT INTO t VALUES ('abandoned')");
}

/**
 * An explicit rollback undoes its row, and so does a transaction that goes out
 * of scope without a commit.
 *
 * @param string $folder the scenario's temporary folder
 */
function transaction_rolls_back_when_asked_and_when_abandoned(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'rollback.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (v TEXT)');
    $asked = $connection->begin();
    $asked->execute("INSERT INTO t VALUES ('rolled back')");
    $asked->rollback();
    $asked->rollback();
    same(0, row_count($connection, 't'), 'the rows after an explicit rollback');

    insert_and_abandon($connection);
    same(0, row_count($connection, 't'), 'the rows after a transaction left without commit');
    check(!$connection->inTransaction(), 'inTransaction is true after the transaction went out of scope');
    $database->close();
}

/**
 * A constraint failure inside a transaction rolls it all back, and the spent
 * transaction then refuses execute and commit as invalid_state.
 *
 * @param string $folder the scenario's temporary folder
 */
function a_failing_statement_rolls_the_transaction_back(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'failing.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    $connection->execute('INSERT INTO t VALUES (1)');
    $transaction = $connection->begin();
    $transaction->execute('INSERT INTO t VALUES (2)');
    refused(Status::Constraint, static fn () => $transaction->execute('INSERT INTO t VALUES (1)'), 'a duplicate key inside a transaction');
    same(1, row_count($connection, 't'), 'the rows after the failed transaction');
    check(!$connection->inTransaction(), 'inTransaction is true after the failure');
    refused(Status::InvalidState, static fn () => $transaction->execute('INSERT INTO t VALUES (3)'), 'execute on a spent transaction');
    refused(Status::InvalidState, static fn () => $transaction->commit(), 'commit on a spent transaction');
    refused(Status::InvalidState, static fn () => $transaction->execute('INSERT INTO t VALUES (4)'), 'execute after the commit was refused');
    $database->close();
}

/**
 * Errors carry their status, offset, message and, for an unsupported construct,
 * the construct's name on its own exception type.
 *
 * @param string $folder the scenario's temporary folder
 */
function errors_carry_status_offset_and_message(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'errors.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    $syntax = refused(Status::Syntax, static fn () => $connection->execute('SELECT * FROM t WHERE'), 'a truncated WHERE');
    same(21, $syntax->offset, "the syntax error's byte offset");
    check($syntax->plainMessage !== '', 'the syntax error has no message');
    check(str_contains($syntax->getMessage(), '[syntax] at byte 21'), 'the message is ' . $syntax->getMessage());
    same(Status::Syntax->value, $syntax->getCode(), 'the exception code');
    $missing = refused(Status::NotFound, static fn () => $connection->execute('SELECT * FROM missing_table'), 'a missing table');
    same(-1, $missing->offset, 'the offset of a missing table error');
    $connection->execute('INSERT INTO t VALUES (1)');
    refused(Status::Constraint, static fn () => $connection->execute('INSERT INTO t VALUES (1)'), 'a duplicate key');
    $unsupported = refused(
        Status::Unsupported,
        static fn () => $connection->execute('CREATE VIRTUAL TABLE f USING fts5(a, detail=none)'),
        'fts5 detail=none'
    );
    check($unsupported instanceof UnsupportedFeatureException, 'an unsupported refusal is not UnsupportedFeatureException');
    check($unsupported->isUnsupported(), 'isUnsupported is false for an unsupported refusal');
    check(str_contains((string) $unsupported->feature, 'detail=none'), 'the feature is ' . var_export($unsupported->feature, true));
    $database->close();
}

/**
 * Closing a database with a statement still open fails as invalid_state and
 * keeps the database; the statement still runs, and once it is closed the
 * database closes.
 *
 * @param string $folder the scenario's temporary folder
 */
function closing_refuses_while_a_statement_is_open(string $folder): void
{
    $path = $folder . DIRECTORY_SEPARATOR . 'held.rdb';
    $database = Database::open($path);
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (v INTEGER)');
    $statement = $connection->prepare('INSERT INTO t VALUES (?1)');
    refused(Status::InvalidState, static fn () => $database->close(), 'closing with a statement open');
    same(1, $statement->execute([7])->affected, 'the statement run after the refused close');
    same(realpath($path), realpath($database->path()), 'the path after the refused close');
    $statement->close();
    $database->close();
    refused(Status::InvalidState, static fn () => $database->connect(), 'connect after the database closed');

    $reopened = Database::open($path);
    same(7, $reopened->connect()->scalar('SELECT v FROM t'), 'the row the statement wrote');
    // A statement that is dropped without close() is freed by its destructor,
    // so it does not keep the database from closing.
    $reopened->connect()->prepare('SELECT 1');
    $reopened->close();
}

/**
 * A call on anything that has been closed is an invalid_state error, and a
 * second close does nothing.
 *
 * @param string $folder the scenario's temporary folder
 */
function use_after_close_is_an_error_not_a_crash(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'after-close.rdb');
    $connection = $database->connect();
    $connection->execute('CREATE TABLE t (v INTEGER)');
    $statement = $connection->prepare('SELECT 1');
    $statement->close();
    $statement->close();
    refused(Status::InvalidState, static fn () => $statement->execute(), 'execute on a closed statement');
    refused(Status::InvalidState, static fn () => $statement->bind(1, 1), 'bind on a closed statement');
    $transaction = $connection->begin();
    $transaction->commit();
    refused(Status::InvalidState, static fn () => $transaction->execute('SELECT 1'), 'execute on a committed transaction');
    $connection->close();
    $connection->close();
    foreach (['execute', 'prepare', 'begin', 'executeBatch', 'cancel', 'totalChanges', 'lastInsertRowid',
        'inTransaction', 'schemaCookie'] as $method) {
        $arguments = in_array($method, ['execute', 'prepare', 'executeBatch'], true) ? ['SELECT 1'] : [];
        refused(Status::InvalidState, static fn () => $connection->$method(...$arguments), "$method on a closed connection");
    }
    $database->close();
    $database->close();
    foreach (['checkpoint', 'integrityCheck', 'path'] as $method) {
        refused(Status::InvalidState, static fn () => $database->$method(), "$method on a closed database");
    }
    refused(Status::InvalidState, static fn () => $database->backupTo('unused.rdb'), 'backupTo on a closed database');
}

// ---------------------------------------------------------------- Engine facts

/**
 * The capability table has named entries, four capabilities answer what the
 * engine declares, and the versions are the ones this client needs.
 *
 * @param string $folder the scenario's temporary folder, unused
 */
function capabilities_and_versions(string $folder): void
{
    $capabilities = Driver::capabilities();
    check($capabilities !== [], 'the capability list is empty');
    foreach ($capabilities as $capability) {
        check($capability->name !== '', 'a capability has no name');
    }
    same(Support::Partial, Driver::supports('cancel'), 'supports(cancel)');
    same(Support::Yes, Driver::supports('encryption'), 'supports(encryption)');
    same(Support::No, Driver::supports('load_extension'), 'supports(load_extension)');
    same(Support::Unknown, Driver::supports('a_capability_nobody_declared'), 'supports(a made up name)');
    // Any release: this said '1.0.' and failed when the engine became 2.0. The ABI is what matters.
    check(preg_match('/^inillucent-driver \d+\.\d+\.\d+ \(engine \d+\.\d+\.\d+\)$/', Driver::version()) === 1, 'the version is ' . Driver::version());
    check(version_compare(Driver::abiVersion(), '1.1.0', '>='), 'the ABI version is ' . Driver::abiVersion());
    check(is_file(Driver::path()), 'the driver path ' . Driver::path() . ' is not a file');
}

/**
 * Checkpoint and integrity check succeed, a backup opens with the same rows,
 * and a second backup to the same path succeeds.
 *
 * @param string $folder the scenario's temporary folder
 */
function checkpoint_integrity_check_and_backup(string $folder): void
{
    $copy = $folder . DIRECTORY_SEPARATOR . 'copy.rdb';
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'original.rdb');
    $connection = $database->connect();
    $connection->executeBatch('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)');
    $database->checkpoint();
    $database->integrityCheck();
    $database->backupTo($copy);
    $connection->execute('INSERT INTO t VALUES (3)');
    $database->backupTo($copy);
    $database->close();

    $restored = Database::open($copy, create: false);
    same(6, $restored->connect()->scalar('SELECT sum(v) FROM t'), 'the sum of the rows in the backup');
    $restored->integrityCheck();
    $restored->close();
}

/**
 * A cancel with nothing running cancels nothing, and the next statement
 * succeeds.
 *
 * PHP runs one call at a time in a process, and an FFI call holds that one
 * thread until the engine returns, so nothing can call cancel while a
 * statement is running. That half of the scenario is skipped with the reason.
 *
 * @param string $folder the scenario's temporary folder
 */
function cancel_from_another_thread_interrupts_and_the_connection_survives(string $folder): void
{
    echo '        skipping the cancel of a running statement: PHP cannot make a second call while an FFI call',
        ' is blocked in the engine, so nothing can call cancel until the statement has finished', PHP_EOL;
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'cancel.rdb');
    $connection = $database->connect();
    $connection->cancel();
    same(2, $connection->scalar('SELECT 2'), 'the statement after a cancel with nothing running');
    $connection->cancel();
    $connection->cancel();
    same(3, $connection->scalar('SELECT 1 + 2'), 'the statement after two cancels with nothing running');
    $database->close();
}

/**
 * An encrypted file holds no plaintext, reads back with its key, reports its
 * cipher, and refuses no key and a wrong key as corrupt.
 *
 * @param string $folder the scenario's temporary folder
 */
function encryption(string $folder): void
{
    $path = $folder . DIRECTORY_SEPARATOR . 'vault.rdb';
    $key = "x'" . str_repeat('5a', 32) . "'";
    $secret = 'the vault code is 7461';
    $database = Database::open($path, key: $key);
    $connection = $database->connect();
    $connection->execute('CREATE TABLE vault (note TEXT)');
    $connection->execute('INSERT INTO vault (note) VALUES (?1)', [$secret]);
    $database->close();
    foreach (glob($folder . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
        check(!str_contains((string) file_get_contents($file), $secret), basename($file) . ' holds the plaintext');
    }

    $database = Database::open($path, key: $key);
    $connection = $database->connect();
    same($secret, $connection->scalar('SELECT note FROM vault'), 'the row read back with the key');
    same('xchacha20-poly1305', $connection->scalar('PRAGMA encryption'), 'PRAGMA encryption');
    $database->close();
    refused(Status::Corrupt, static fn () => Database::open($path)->close(), 'opening without the key');
    refused(Status::Corrupt, static fn () => Database::open($path, key: 'a different passphrase')->close(), 'opening with a different key');
}

// ---------------------------------------------------------------- The rest of the public API

/**
 * Covers the parts of the public API no scenario in integration.md reaches, so
 * that every public method is called by at least one test.
 *
 * @param string $folder the scenario's temporary folder
 */
function the_rest_of_the_public_api(string $folder): void
{
    $database = Database::open($folder . DIRECTORY_SEPARATOR . 'rest.rdb', diagnostics: true);
    $connection = $database->connect();
    check($connection->database() === $database, 'the connection names another database');
    same(Driver::NO_LIMIT, Connection::capped(null), 'capped(null)');
    same(5, Connection::capped(5), 'capped(5)');
    check_every_bound_type($connection);
    check_query_and_empty_results($connection);
    check_value_helpers();
    $database->close();
}

/**
 * Binds each PHP type the client maps to an engine value, reads back the kind
 * the engine stored, and refuses a type it does not map.
 *
 * @param Connection $connection the connection to use
 */
function check_every_bound_type(Connection $connection): void
{
    $kind = $connection->prepare('SELECT typeof(?1), ?1');
    $cases = [
        [null, 'null', null],
        [true, 'integer', 1],
        [7, 'integer', 7],
        [2.5, 'real', 2.5],
        ['', 'text', ''],
    ];
    foreach ($cases as [$value, $name, $back]) {
        same([$name, $back], $kind->execute([$value])->one(), 'a bound ' . get_debug_type($value));
    }
    $empty = $kind->execute([new Blob('')])->one();
    check($empty[0] === 'blob' && $empty[1] instanceof Blob && $empty[1]->bytes === '', 'an empty blob read back as something else');
    refused(Status::InvalidState, static fn () => $kind->bind(0, 1), 'binding position 0');
    refused(Status::InvalidState, static fn () => $kind->bind(2, 1), 'binding past the last parameter');
    try {
        $kind->bind(1, new DateTimeImmutable());
        throw new ScenarioFailed('binding a DateTimeImmutable succeeded');
    } catch (InvalidArgumentException) {
    }
    $kind->close();
}

/**
 * Reads rows through query and scalar with bound values and a limit, and the
 * empty cases of a result.
 *
 * @param Connection $connection the connection to use
 */
function check_query_and_empty_results(Connection $connection): void
{
    $connection->execute('CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT)');
    $connection->execute('INSERT INTO person VALUES (?1, ?2), (?3, ?4)', [1, 'Ada', 2, 'Grace']);
    same([['id' => 1, 'name' => 'Ada']], $connection->query('SELECT id, name FROM person WHERE id = ?1', [1]), 'query with a value');
    same(1, count($connection->query('SELECT id FROM person ORDER BY id', [], 1)), 'query with a limit');
    same('Grace', $connection->scalar('SELECT name FROM person WHERE id = ?1', [2]), 'scalar with a value');
    $none = $connection->execute('SELECT id FROM person WHERE id = 3');
    check($none instanceof Rows, 'execute did not return Rows');
    same(null, $none->one(), 'one on an empty result');
    same(null, $none->scalar(), 'scalar on an empty result');
    same(null, $none->get(0, 'id'), 'get past the last row');
    same(null, $none->columnIndex('name'), 'columnIndex of a column the result does not have');
    same([], $none->objects(), 'objects of an empty result');
}

/** Reads the helpers on Blob, Capability, Support and Status. */
function check_value_helpers(): void
{
    $blob = new Blob("a\0b");
    same(3, $blob->length(), 'the length of a blob holding a NUL');
    same("a\0b", (string) $blob, 'a blob as a string');
    $byName = [];
    foreach (Driver::capabilities() as $capability) {
        $byName[$capability->name] = $capability;
    }
    check($byName['cancel']->isSupported(), 'cancel is partial and counts as supported');
    check(!$byName['load_extension']->isSupported(), 'load_extension counts as supported');
    check($byName['cancel']->note !== '', 'cancel has no note');
    same('partial', Support::Partial->label(), 'the label of partial');
    same('yes', Support::Yes->label(), 'the label of yes');
    same('no', Support::No->label(), 'the label of no');
    same('unknown', Support::fromCode(42)->label(), 'the label of a support state nobody declared');
    check(!(new Capability('made up', Support::Unknown, ''))->isSupported(), 'unknown counts as supported');
    same(Status::Unknown, Status::fromCode(99), 'a status nobody declared');
    $labels = array_map(static fn (Status $status): string => $status->label(), Status::cases());
    same(count(Status::cases()), count(array_unique($labels)), 'distinct status labels');
    check(in_array(Driver::path(), Driver::searchPaths(), true) || getenv('INILLUCENT_DRIVER_LIB') !== false, 'the loaded path is not one of the search paths');
}

// ---------------------------------------------------------------- Running them

if (($argv[1] ?? '') === 'child' && isset($argv[2])) {
    exit(run_child($argv[2]));
}

echo Driver::version(), '  ABI ', Driver::abiVersion(), PHP_EOL;
echo 'driver: ', Driver::path(), PHP_EOL, PHP_EOL;

$scenarios = [
    'file_survives_close_and_reopen',
    'missing_file_without_create_is_not_found',
    'read_only_open_reads_and_refuses_writes',
    'second_handle_in_the_same_process_sees_committed_rows',
    'another_process_writes_and_this_one_reads_it',
    'prepared_statement_runs_many_times_with_fresh_bindings',
    'rows_report_counts_columns_and_limits',
    'last_insert_rowid_and_total_changes',
    'schema_cookie_changes_when_the_schema_does',
    'execute_batch_runs_every_statement',
    'large_values_round_trip',
    'search_with_bound_parameters',
    'transaction_commits_all_of_it',
    'transaction_rolls_back_when_asked_and_when_abandoned',
    'a_failing_statement_rolls_the_transaction_back',
    'errors_carry_status_offset_and_message',
    'closing_refuses_while_a_statement_is_open',
    'use_after_close_is_an_error_not_a_crash',
    'capabilities_and_versions',
    'checkpoint_integrity_check_and_backup',
    'cancel_from_another_thread_interrupts_and_the_connection_survives',
    'encryption',
    'the_rest_of_the_public_api',
];

$failed = 0;
foreach ($scenarios as $name) {
    if (!run_scenario($name)) {
        $failed++;
    }
}
echo PHP_EOL, count($scenarios) - $failed, ' of ', count($scenarios), ' scenarios pass',
    $failed > 0 ? ", $failed FAILED" : '', PHP_EOL;
exit($failed === 0 ? 0 : 1);
