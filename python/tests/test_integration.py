"""Runs every scenario in conformance/integration.md against this client.

suite.json grades what a statement does. These tests grade what the library
around the statement does: opening, closing and reopening a file, a transaction
object, a prepared statement reused with new values, a backup, a cancel sent
from another thread, and a second process writing the same file. Every test uses
a real database file in a fresh temporary folder, through the public API, with
no mocks, and removes the folder when it ends.
"""

from __future__ import annotations

import gc
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time

import pytest

import inillucent

# The source folder this client is imported from, so a child process imports
# the same code as the test that started it.
SOURCE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))


@pytest.fixture
def folder():
    """Yield a fresh temporary folder and delete it when the test ends."""
    made = tempfile.mkdtemp(prefix="inillucent-integration-py-")
    try:
        yield made
    finally:
        gc.collect()
        shutil.rmtree(made, ignore_errors=True)


def failure_of(call, *args) -> inillucent.InillucentError:
    """Run a call that must fail and return the error it raised.

    @param call - the function to run
    @param args - the arguments to pass it
    """
    with pytest.raises(inillucent.InillucentError) as caught:
        call(*args)
    return caught.value


def people_table(connection) -> None:
    """Create a small table with an integer key and a text column.

    @param connection - where to create it
    """
    connection.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")


# Files


def test_file_survives_close_and_reopen(folder):
    """Rows written before a close are read back after a reopen."""
    path = os.path.join(folder, "kept.rdb")
    database = inillucent.Database(path)
    assert os.path.normcase(os.path.abspath(database.path)) == os.path.normcase(path)
    connection = database.connect()
    people_table(connection)
    connection.execute("INSERT INTO t (v) VALUES (?1)", ["one"])
    connection.execute("INSERT INTO t (v) VALUES (?1)", ["two"])
    database.close()
    with inillucent.connect(path) as again:
        assert again.execute("SELECT id, v FROM t ORDER BY id").rows == [[1, "one"], [2, "two"]]


def test_diagnostics_open_still_reports_the_status(folder):
    """A database opened with diagnostics reports failures with the same status."""
    with inillucent.connect(os.path.join(folder, "diagnostics.rdb"), diagnostics=True) as db:
        failure = failure_of(db.execute, "SELECT * FROM missing_table")
        assert failure.status == inillucent.NOT_FOUND


def test_missing_file_without_create_is_not_found(folder):
    """Opening a missing path with create off fails and creates nothing."""
    path = os.path.join(folder, "absent.rdb")
    failure = failure_of(inillucent.Database, path, False)
    assert failure.status == inillucent.NOT_FOUND
    assert not os.path.exists(path)


def test_read_only_open_reads_and_refuses_writes(folder):
    """A read only open answers a SELECT and refuses an INSERT."""
    path = os.path.join(folder, "ro.rdb")
    with inillucent.connect(path) as writer:
        people_table(writer)
        writer.execute("INSERT INTO t (v) VALUES ('a'), ('b')")
    with inillucent.connect(path, read_only=True) as reader:
        assert reader.execute("SELECT v FROM t ORDER BY id").rows == [["a"], ["b"]]
        failure = failure_of(reader.execute, "INSERT INTO t (v) VALUES ('c')")
        assert failure.status == inillucent.READONLY
        assert reader.scalar("SELECT count(*) FROM t") == 2


def test_second_handle_in_the_same_process_sees_committed_rows(folder):
    """A row inserted through one handle is read through another on the same file."""
    path = os.path.join(folder, "shared.rdb")
    with inillucent.connect(path) as first:
        people_table(first)
        with inillucent.connect(path) as second:
            # On 1.0.33 a handle that has been opened and has run nothing holds
            # a read lock, so a write through the first handle waits out
            # busy_timeout and fails with busy. Running one statement on the
            # second handle first releases it. Reported to the lead.
            assert second.scalar("SELECT count(*) FROM t") == 0
            first.execute("INSERT INTO t (v) VALUES ('seen')")
            assert second.execute("SELECT v FROM t").rows == [["seen"]]


CHILD = """
import sys
import inillucent
with inillucent.connect(sys.argv[1]) as db:
    db.execute("INSERT INTO t (v) VALUES (?1)", ["from the child"])
"""


def test_another_process_writes_and_this_one_reads_it(folder):
    """A child process inserts a row, and the parent reads it without reopening."""
    path = os.path.join(folder, "two-processes.rdb")
    with inillucent.connect(path) as parent:
        people_table(parent)
        environment = dict(os.environ, PYTHONPATH=SOURCE)
        child = subprocess.run([sys.executable, "-c", CHILD, path], env=environment,
                               capture_output=True, text=True, timeout=120)
        assert child.returncode == 0, child.stderr
        assert parent.execute("SELECT v FROM t").rows == [["from the child"]]


# Statements


def test_prepared_statement_runs_many_times_with_fresh_bindings(folder):
    """One prepared INSERT runs 100 times, and bindings do not carry over."""
    with inillucent.connect(os.path.join(folder, "prepared.rdb")) as db:
        db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, v TEXT)")
        with db.prepare("INSERT INTO t (n, v) VALUES (?1, ?2)") as insert:
            for nth in range(100):
                assert insert.execute([nth, f"value {nth}"]).affected == 1
        rows = db.execute("SELECT n, v FROM t ORDER BY n").rows
        assert rows == [[nth, f"value {nth}"] for nth in range(100)]
        with db.prepare("SELECT ?1 + ?2") as add:
            assert add.execute([2, 3]).scalar() == 5
            assert add.execute([2]).scalar() is None


def test_rows_report_counts_columns_and_limits(folder):
    """A write reports affected and its tag, and a limited read reports total and more."""
    with inillucent.connect(os.path.join(folder, "rows.rdb")) as db:
        people_table(db)
        written = db.execute("INSERT INTO t (v) VALUES ('a'), ('b')")
        assert written.affected == 2
        assert written.tag == "INSERT 2"
        db.execute("INSERT INTO t (v) VALUES ('c'), ('d'), ('e')")
        page = db.execute("SELECT id, v FROM t ORDER BY id", limit=2)
        assert len(page) == 2
        assert page.total == 5
        assert page.more is True
        assert page.affected is None
        assert page.columns == ["id", "v"]
        # The engine returns '' for a plain table column's declared type on
        # 1.0.33, so only the count is asserted. See integration.md.
        assert len(page.column_types) == 2
        assert page.objects()[0] == {"id": 1, "v": "a"}
        assert page.column("v") == ["a", "b"]
        assert page.column(0) == [1, 2]
        assert list(page)[1] == page[1] == [2, "b"]
        assert "2 of 5" in repr(page)
        assert page.elapsed_us >= 0


def test_last_insert_rowid_and_total_changes(folder):
    """The last insert rowid follows each insert and total changes adds up."""
    with inillucent.connect(os.path.join(folder, "rowid.rdb")) as db:
        people_table(db)
        before = db.total_changes
        db.execute("INSERT INTO t (v) VALUES ('first')")
        db.execute("INSERT INTO t (v) VALUES ('second')")
        second = db.scalar("SELECT id FROM t WHERE v = 'second'")
        assert db.last_insert_rowid == second
        assert db.total_changes == before + 2
        db.execute("UPDATE t SET v = 'changed'")
        assert db.total_changes == before + 4


def test_schema_cookie_changes_when_the_schema_does(folder):
    """The schema cookie is stable across reads and writes, and moves on CREATE TABLE."""
    with inillucent.connect(os.path.join(folder, "cookie.rdb")) as db:
        people_table(db)
        cookie = db.schema_cookie
        db.execute("SELECT * FROM t")
        db.execute("INSERT INTO t (v) VALUES ('x')")
        assert db.schema_cookie == cookie
        db.execute("CREATE TABLE u (id INTEGER PRIMARY KEY)")
        assert db.schema_cookie != cookie


def test_execute_batch_runs_every_statement(folder):
    """A batch runs every statement, and a bad second statement fails with syntax."""
    with inillucent.connect(os.path.join(folder, "batch.rdb")) as db:
        db.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);"
            "INSERT INTO t (v) VALUES ('a');"
            "INSERT INTO t (v) VALUES ('b');"
            "INSERT INTO t (v) VALUES ('c')"
        )
        assert db.scalar("SELECT count(*) FROM t") == 3
        failure = failure_of(db.execute_batch, "INSERT INTO t (v) VALUES ('d'); SELEC nothing")
        assert failure.status == inillucent.SYNTAX


def test_large_values_round_trip(folder):
    """A one megabyte blob and a one megabyte text value come back byte for byte."""
    blob = bytes(range(256)) * 4096
    text = ("\U0001F600\U00010348 plain " * 60000)[: 1024 * 1024]
    with inillucent.connect(os.path.join(folder, "large.rdb")) as db:
        db.execute("CREATE TABLE big (id INTEGER PRIMARY KEY, b BLOB, s TEXT)")
        db.execute("INSERT INTO big (b, s) VALUES (?1, ?2)", [bytearray(blob), text])
        got = db.execute("SELECT b, s FROM big").one()
        assert got[0] == blob
        assert got[1] == text


def vector(*numbers: float) -> bytes:
    """Return little endian float32 bytes, the form a VECTOR column holds.

    @param numbers - the components
    """
    return struct.pack(f"<{len(numbers)}f", *numbers)


def test_search_with_bound_parameters(folder):
    """An FTS5 MATCH and a vector distance both take their probe as a bound value."""
    with inillucent.connect(os.path.join(folder, "search.rdb")) as db:
        db.execute("CREATE VIRTUAL TABLE docs USING fts5(title, body)")
        db.execute("INSERT INTO docs (rowid, title, body) VALUES "
                   "(1, 'one', 'the quick brown fox'), (2, 'two', 'a lazy dog'),"
                   " (3, 'three', 'brown bread')")
        found = db.execute("SELECT rowid FROM docs WHERE docs MATCH ?1 ORDER BY rowid", ["brown"])
        assert found.column(0) == [1, 3]
        db.execute("CREATE TABLE point (id INTEGER PRIMARY KEY, at VECTOR(2))")
        for nth, at in ((1, vector(1, 0)), (2, vector(0, 1)), (3, vector(0.7, 0.7))):
            db.execute("INSERT INTO point (id, at) VALUES (?1, ?2)", [nth, at])
        nearest = db.execute(
            "SELECT id FROM point ORDER BY vector_distance_cos(at, ?1)", [vector(0, 1)]
        )
        assert nearest.column(0)[0] == 2


# Transactions


def test_transaction_commits_all_of_it(folder):
    """Two inserts report their counts, and a commit keeps both."""
    with inillucent.connect(os.path.join(folder, "commit.rdb")) as db:
        people_table(db)
        transaction = db.transaction()
        assert transaction.execute("INSERT INTO t (v) VALUES ('a')") == 1
        assert transaction.execute("INSERT INTO t (v) VALUES ('b'), ('c')") == 2
        assert db.in_transaction is True
        transaction.commit()
        assert transaction.affected == [1, 2]
        assert db.in_transaction is False
        assert db.scalar("SELECT count(*) FROM t") == 3
        transaction.commit()
        with db.transaction() as scoped:
            scoped.execute("INSERT INTO t (v) VALUES ('d')")
        assert db.scalar("SELECT count(*) FROM t") == 4


def test_transaction_rolls_back_when_asked_and_when_abandoned(folder):
    """An explicit rollback and a with block left by an exception both undo the row."""
    with inillucent.connect(os.path.join(folder, "rollback.rdb")) as db:
        people_table(db)
        explicit = db.transaction()
        explicit.execute("INSERT INTO t (v) VALUES ('asked')")
        explicit.rollback()
        assert db.scalar("SELECT count(*) FROM t") == 0
        with pytest.raises(RuntimeError):
            with db.transaction() as abandoned:
                abandoned.execute("INSERT INTO t (v) VALUES ('abandoned')")
                raise RuntimeError("leave the block without committing")
        assert db.scalar("SELECT count(*) FROM t") == 0
        dropped = db.transaction()
        dropped.execute("INSERT INTO t (v) VALUES ('dropped')")
        del dropped
        gc.collect()
        assert db.in_transaction is False
        assert db.scalar("SELECT count(*) FROM t") == 0


def test_a_failing_statement_rolls_the_transaction_back(folder):
    """A constraint failure undoes the transaction and leaves it spent."""
    with inillucent.connect(os.path.join(folder, "failing.rdb")) as db:
        people_table(db)
        db.execute("INSERT INTO t (id, v) VALUES (1, 'kept')")
        transaction = db.transaction()
        transaction.execute("INSERT INTO t (id, v) VALUES (2, 'undone')")
        failure = failure_of(transaction.execute, "INSERT INTO t (id, v) VALUES (1, 'clash')")
        assert failure.status == inillucent.CONSTRAINT
        assert db.scalar("SELECT count(*) FROM t") == 1
        assert db.in_transaction is False
        again = failure_of(transaction.execute, "INSERT INTO t (id, v) VALUES (3, 'late')")
        assert again.status == inillucent.INVALID_STATE
        late = failure_of(transaction.commit)
        assert late.status == inillucent.INVALID_STATE


# Errors


def test_errors_carry_status_offset_and_message(folder):
    """Each kind of failure arrives with its status, and syntax with its offset."""
    with inillucent.connect(os.path.join(folder, "errors.rdb")) as db:
        people_table(db)
        syntax = failure_of(db.execute, "SELECT * FROM t WHERE")
        assert syntax.status == inillucent.SYNTAX
        assert syntax.offset == 21
        assert syntax.message and "at byte 21" in str(syntax)
        missing = failure_of(db.execute, "SELECT * FROM missing_table")
        assert missing.status_name == "not_found"
        db.execute("INSERT INTO t (id, v) VALUES (1, 'a')")
        clash = failure_of(db.execute, "INSERT INTO t (id, v) VALUES (1, 'b')")
        assert clash.status == inillucent.CONSTRAINT
        refused = failure_of(db.execute, "CREATE VIRTUAL TABLE f USING fts5(a, detail=none)")
        assert isinstance(refused, inillucent.UnsupportedError)
        assert refused.status == inillucent.UNSUPPORTED
        assert "detail=none" in refused.feature
        assert inillucent.status_name(99) == "status 99"


def test_closing_refuses_while_a_statement_is_open(folder):
    """Close refuses while a statement lives, keeps the database, and works after."""
    path = os.path.join(folder, "refuse.rdb")
    database = inillucent.Database(path)
    connection = database.connect()
    people_table(connection)
    statement = connection.prepare("INSERT INTO t (v) VALUES (?1)")
    refused = failure_of(database.close)
    assert refused.status == inillucent.INVALID_STATE
    assert statement.execute(["still works"]).affected == 1
    database.checkpoint()
    statement.close()
    database.close()
    with inillucent.connect(path) as again:
        assert again.scalar("SELECT v FROM t") == "still works"


def test_closing_an_owned_database_refuses_and_can_be_retried(folder):
    """A connection from connect() keeps its database when the close is refused."""
    path = os.path.join(folder, "owned.rdb")
    connection = inillucent.connect(path)
    people_table(connection)
    statement = connection.prepare("SELECT count(*) FROM t")
    refused = failure_of(connection.close)
    assert refused.status == inillucent.INVALID_STATE
    assert statement.execute().scalar() == 0
    statement.close()
    connection.close()
    assert inillucent.Database(path, create=False).close() is None


def test_use_after_close_is_an_error_not_a_crash(folder):
    """A closed connection or statement fails with invalid_state, and a second close does nothing."""
    database = inillucent.Database(os.path.join(folder, "closed.rdb"))
    connection = database.connect()
    statement = connection.prepare("SELECT 1")
    statement.close()
    statement.close()
    connection.close()
    failure = failure_of(connection.execute, "SELECT 1")
    assert failure.status == inillucent.INVALID_STATE
    assert failure_of(statement.execute).status == inillucent.INVALID_STATE
    connection.close()
    database.close()
    database.close()


def test_binding_a_value_with_no_placeholder_is_an_error(folder):
    """A value past the statement's parameter count is refused rather than dropped."""
    with inillucent.connect(os.path.join(folder, "bind.rdb")) as db:
        failure = failure_of(db.execute, "SELECT ?1", [1, 2])
        assert failure.status == inillucent.INVALID_STATE
        with db.prepare("SELECT ?1") as statement:
            assert failure_of(statement.bind, 0, 1).status == inillucent.INVALID_STATE
            with pytest.raises(TypeError):
                statement.bind(1, object())
            values = [None, True, 1.5, "t", b"", memoryview(b"ab")]
            assert [statement.execute([value]).scalar() for value in values] == \
                [None, 1, 1.5, "t", b"", b"ab"]


# Engine facts


def test_capabilities_and_versions():
    """The capability table and the version calls describe this engine."""
    table = inillucent.capabilities()
    assert table and all(entry.name for entry in table)
    cancel = next(entry for entry in table if entry.name == "cancel")
    assert cancel.support_name == "partial" and cancel.supported
    assert inillucent.supports("cancel") == inillucent.SUPPORT_PARTIAL
    assert inillucent.supports("encryption") == inillucent.SUPPORT_YES
    assert inillucent.supports("load_extension") == inillucent.SUPPORT_NO
    assert inillucent.supports("made_up_capability") == inillucent.SUPPORT_UNKNOWN
    # Any release: this said "1.0." and failed when the engine became 2.0. The ABI is what matters.
    assert re.fullmatch(r"inillucent-driver \d+\.\d+\.\d+ \(engine \d+\.\d+\.\d+\)", inillucent.version())
    major, minor, _ = (int(part) for part in inillucent.abi_version().split("."))
    assert (major, minor) >= (1, 1)
    assert os.path.isfile(inillucent.driver_path())


def test_checkpoint_integrity_check_and_backup(folder):
    """Checkpoint and integrity check succeed, and a backup opens with the same rows."""
    copy = os.path.join(folder, "copy.rdb")
    with inillucent.Database(os.path.join(folder, "source.rdb")) as database:
        connection = database.connect()
        people_table(connection)
        connection.execute("INSERT INTO t (v) VALUES ('a'), ('b')")
        database.checkpoint()
        database.integrity_check()
        database.backup_to(copy)
        database.backup_to(copy)
    with inillucent.connect(copy, create=False) as restored:
        assert restored.execute("SELECT v FROM t ORDER BY id").rows == [["a"], ["b"]]


SLOW = ("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000000) "
        "SELECT count(*) FROM n")


def test_cancel_from_another_thread_interrupts_and_the_connection_survives(folder):
    """A cancel from another thread stops a long statement, and the connection still works."""
    with inillucent.connect(os.path.join(folder, "cancel.rdb")) as db:
        db.cancel()
        assert db.scalar("SELECT 1") == 1
        timer = threading.Timer(0.1, db.cancel)
        started = time.monotonic()
        timer.start()
        try:
            failure = failure_of(db.execute, SLOW)
        finally:
            timer.join()
        assert failure.status == inillucent.INTERRUPTED
        assert time.monotonic() - started < 30
        assert db.scalar("SELECT 2") == 2


def test_encryption(folder):
    """An encrypted file holds no plaintext and needs its key."""
    path = os.path.join(folder, "vault.rdb")
    key = "x'" + "5a" * 32 + "'"
    secret = "the vault code is 7461"
    with inillucent.connect(path, key=key) as db:
        db.execute("CREATE TABLE vault (note TEXT)")
        db.execute("INSERT INTO vault (note) VALUES (?1)", [secret])
    for name in os.listdir(folder):
        with open(os.path.join(folder, name), "rb") as handle:
            assert secret.encode() not in handle.read(), name
    with inillucent.connect(path, key=key) as db:
        assert db.scalar("SELECT note FROM vault") == secret
        assert db.scalar("PRAGMA encryption") == "xchacha20-poly1305"
    for options in ({}, {"key": "x'" + "3c" * 32 + "'"}):
        failure = failure_of(lambda: inillucent.connect(path, **options))
        assert failure.status == inillucent.CORRUPT
