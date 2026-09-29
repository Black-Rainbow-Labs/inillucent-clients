# Integration scenarios

`suite.json` grades what a statement does. It cannot grade what the library around the statement
does: opening a file, closing it, reopening it, a transaction object, a prepared statement reused
with new values, a backup, a cancel sent from another thread, or a second process writing the same
file. Those are the parts of a client a person calls most, and before task-2156 no client tested
any of them.

This file lists those scenarios. Every client runs every one of them against a real database file
in a fresh temporary folder, through its own public API, with no mocks. The test for each scenario
uses the scenario's name, converted to the language's naming style, so `node scripts/test-all.mjs`
output can be read across languages.

The expected answers below were taken from the engine (inillucent 1.0.33, ABI 1.1.0), not guessed.

A client that cannot run a scenario skips it and prints the reason on a line that contains
`skipping`. Only the cancel scenario may be skipped, and only by a client that cannot make a call
while another call is still running in the same process (PHP).

## Files

**file_survives_close_and_reopen.** Open a new file, create a table, insert two rows, close the
database. Open the same path again and read both rows back with their values. The database's path
property returns the path that was opened.

**missing_file_without_create_is_not_found.** Opening a path that does not exist with create turned
off fails with status `not_found`, and no file is created at that path.

**read_only_open_reads_and_refuses_writes.** Write a table and close. Open the file read only: a
`SELECT` returns the rows, and an `INSERT` fails with status `readonly`. The row count is unchanged
afterwards.

**second_handle_in_the_same_process_sees_committed_rows.** Open the same file twice in one process.
Run one `SELECT` on the second handle. A row inserted through the first handle is then read through
the second.

The `SELECT` is there because of an engine defect on 1.0.33: a database that has been opened and
has run no statement yet holds a read lock on the file. A write through another handle waits the
whole 5,000 ms busy timeout and then fails with `busy` ("another process holds the file for
reading"). Running one statement on the idle handle releases the lock.

**another_process_writes_and_this_one_reads_it.** Hold a database open. Start a child process of the
same language that opens the same file through this client, inserts one row, closes and exits 0.
The parent then reads the new row without reopening.

## Statements

**prepared_statement_runs_many_times_with_fresh_bindings.** Prepare one `INSERT` and execute it 100
times with different values. The table then has 100 rows with those values. Executing a prepared
`SELECT ?1 + ?2` with only one value returns NULL, because the bindings are cleared between
executions and a parameter with no value is NULL. Binding more values than the statement has
placeholders, as in `SELECT ?1` with two values, fails with status `invalid_state`. The header says
near line 270 that binding past the end grows the list with NULLs, but the engine refuses it, which
matches the misuse note near line 120. A client must report that refusal and not drop the extra
value silently.

**rows_report_counts_columns_and_limits.** For `INSERT INTO t (v) VALUES ('a'), ('b')` the result
has `affected` 2 and, where the client exposes it, the tag `INSERT 2`. For a `SELECT` of 5 rows with
a limit of 2: two rows are handed back, `total` is 5, `more` is true, `affected` is null, the column
names are in order, and where the client exposes declared types there is one entry per column.

The header says `inillucent_rows_column_type` returns "the type the schema declared", but on 1.0.33
it returns an empty string for a plain table column too: `SELECT id, v FROM t` on
`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)` reports `['', '']`. That is an engine defect, so
the scenario asserts only the count and does not assert a declared type the engine does not return.

**last_insert_rowid_and_total_changes.** After two single row inserts into a table with an integer
primary key, the last insert rowid is the second row's id. The total changes count goes up by the
number of rows each write changed.

**schema_cookie_changes_when_the_schema_does.** The schema cookie is the same before and after a
`SELECT` and an `INSERT`, and different after a `CREATE TABLE`.

**execute_batch_runs_every_statement.** A batch of a `CREATE TABLE` and three `INSERT` statements
separated by semicolons leaves three rows. A batch whose second statement is invalid fails with
status `syntax`.

**large_values_round_trip.** A one megabyte blob containing every byte value, and a one megabyte
text value containing characters outside the basic multilingual plane, are bound as parameters and
read back byte for byte equal.

**search_with_bound_parameters.** An FTS5 table is searched with `MATCH ?1` where the term is bound,
and returns the matching rowids. A `VECTOR(2)` column is filled with bound little endian float
blobs and ordered by `vector_distance_cos(at, ?1)` with the probe bound as a blob. The nearest row
comes first.

## Transactions

**transaction_commits_all_of_it.** Begin a transaction, run two inserts, and read each one's
affected count before committing. While it is open, `in_transaction` is true. After commit both rows
are there and `in_transaction` is false.

**transaction_rolls_back_when_asked_and_when_abandoned.** Roll back an explicit transaction: its row
is gone. Begin another, insert, and end it without commit or rollback using the language's scope
mechanism (`with`, `using`, `defer`, `Drop`, `try`/`finally`, or dispose). Its row is gone too.

**a_failing_statement_rolls_the_transaction_back.** Inside a transaction, insert a row and then
insert a row that breaks a unique constraint. The second insert fails with status `constraint`, the
first row is gone, `in_transaction` is false, and a further execute or commit on the same
transaction fails with status `invalid_state`.

## Errors

**errors_carry_status_offset_and_message.** `SELECT * FROM t WHERE` fails with status `syntax` and
byte offset 21. `SELECT * FROM missing_table` fails with `not_found`. A duplicate primary key fails
with `constraint`. `CREATE VIRTUAL TABLE f USING fts5(a, detail=none)` fails with the client's
unsupported error type, status `unsupported`, and a feature that contains `detail=none`.

**closing_refuses_while_a_statement_is_open.** Prepare a statement and keep it. Closing the database
fails with status `invalid_state`. The statement still executes. After the statement is closed, the
database closes cleanly. A client that closes statements for the caller instead must still leave
nothing open, and must not lose the database handle when the engine refuses a close.

**use_after_close_is_an_error_not_a_crash.** Executing on a connection that has been closed fails
with an error (status `invalid_state` where the call reaches the engine). Closing a database or
connection a second time does nothing.

## Engine facts

**capabilities_and_versions.** The capability list is not empty and every entry has a name.
`supports('cancel')` is partial, `supports('encryption')` is yes, `supports('load_extension')` is
no, and a made up name is unknown. The version text contains `1.0.` and the ABI version is at least
1.1.0.

**checkpoint_integrity_check_and_backup.** After some writes, checkpoint and integrity check both
succeed. Backing up to a new path produces a file that opens and holds the same rows. Backing up to
the same path a second time succeeds.

**cancel_from_another_thread_interrupts_and_the_connection_survives.** Run
`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000000) SELECT count(*) FROM n`
and call cancel from another thread about 100 ms later. The statement fails with status
`interrupted` (measured at 0.1 s), and the next statement on the same connection succeeds. A cancel
with nothing running cancels nothing: the next statement succeeds.

Do not use `generate_series` or a filtered cross join here. On 1.0.33 a cancel does not stop
`SELECT count(*) FROM generate_series(1, 2000000000)` at all (it ran 132 s and returned the count),
and `SELECT count(*) FROM big a, big b WHERE a.x + b.x = 7` over 300,000 rows took 40 s to stop.

**encryption.** Each client already has this test from task-2142: an encrypted file holds no
plaintext, reads back with its key, reports `PRAGMA encryption`, and refuses with `corrupt` when
opened without the key or with the wrong key.
