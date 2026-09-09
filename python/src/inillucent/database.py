"""The database, connection, statement and transaction objects.

Every handle is owned by exactly one Python object, freed once, and a child
holds a strong reference to its parent. Without that reference the two could be
finalised in either order, and one of those orders frees a database that still
has a live connection on it.
"""

from __future__ import annotations

import ctypes
from ctypes import c_uint8, c_uint64, c_void_p
from typing import Any, List, Optional, Sequence

from ._check import check
from ._library import lib
from .rows import Rows, decode

OPEN_CREATE = 0x0001
OPEN_READONLY = 0x0002
OPEN_DIAGNOSTICS = 0x0004

# The C limit parameter caps rows handed back. No limit is every row.
NO_LIMIT = (1 << 64) - 1


def capped(limit: Optional[int]) -> int:
    """Return the C limit for a Python limit, where None means every row.

    @param limit - rows to hand back, or None
    """
    return NO_LIMIT if limit is None else int(limit)


class Transaction:
    """One transaction, held open while the caller decides whether to commit.

    The caller holds it open, runs statements, reads how many rows each one
    changed, and only then commits. A check made after the commit cannot stop
    the write it was checking.

    As a context manager it commits on a clean exit and rolls back on an
    exception, which is what a caller means either way.
    """

    def __init__(self, connection: "Connection", handle) -> None:
        self._connection = connection
        self._handle = handle
        self.affected: List[int] = []

    def execute(self, sql: str) -> int:
        """Run one statement inside the transaction and return the rows it changed.

        A failure rolls the whole transaction back before it raises, so a caller
        that stops at the first error has already undone everything.

        @param sql - the statement to run
        """
        changed = c_uint64()
        error = c_void_p()
        status = lib().inillucent_txn_execute(
            self._handle, sql.encode("utf-8"), ctypes.byref(changed), ctypes.byref(error)
        )
        check(status, error)
        self.affected.append(changed.value)
        return changed.value

    def commit(self) -> None:
        """Commit the transaction. The handle is spent either way."""
        if not self._handle:
            return
        error = c_void_p()
        status = lib().inillucent_txn_commit(self._handle, ctypes.byref(error))
        handle, self._handle = self._handle, None
        try:
            check(status, error)
        finally:
            lib().inillucent_txn_rollback(handle)

    def rollback(self) -> None:
        """Roll the transaction back and free it."""
        if self._handle:
            lib().inillucent_txn_rollback(self._handle)
            self._handle = None

    def __enter__(self) -> "Transaction":
        return self

    def __exit__(self, kind, value, trace) -> bool:
        if kind is None:
            self.commit()
        else:
            self.rollback()
        return False

    def __del__(self) -> None:
        self.rollback()


class Statement:
    """A compiled statement and the values bound to it."""

    def __init__(self, connection: "Connection", handle) -> None:
        self._connection = connection
        self._handle = handle

    def execute(self, params: Sequence[Any] = (), limit: Optional[int] = None) -> Rows:
        """Bind these values, run the statement, and return what it produced.

        @param params - values for ?1, ?2 and so on, in order
        @param limit - rows to hand back, or None for every row
        """
        library = lib()
        library.inillucent_clear_bindings(self._handle)
        for nth, value in enumerate(params, start=1):
            self.bind(nth, value)
        rows = c_void_p()
        error = c_void_p()
        status = library.inillucent_stmt_execute(
            self._handle, capped(limit), ctypes.byref(rows), ctypes.byref(error)
        )
        check(status, error)
        return Rows(rows)

    def bind(self, index: int, value: Any) -> None:
        """Bind one value, choosing the call by the Python type.

        bool is checked before int because it is a subclass of it, and binding
        True as text would be a quietly different value.

        @param index - the one based parameter position
        @param value - what to bind
        """
        library = lib()
        if value is None:
            library.inillucent_bind_null(self._handle, index)
        elif isinstance(value, bool):
            library.inillucent_bind_int(self._handle, index, int(value))
        elif isinstance(value, int):
            library.inillucent_bind_int(self._handle, index, value)
        elif isinstance(value, float):
            library.inillucent_bind_real(self._handle, index, value)
        elif isinstance(value, str):
            raw = value.encode("utf-8")
            library.inillucent_bind_text(self._handle, index, raw, len(raw))
        elif isinstance(value, (bytes, bytearray, memoryview)):
            raw = bytes(value)
            buffer = (c_uint8 * len(raw)).from_buffer_copy(raw) if raw else (c_uint8 * 0)()
            library.inillucent_bind_blob(self._handle, index, buffer, len(raw))
        else:
            raise TypeError(
                f"cannot bind a {type(value).__name__}. The engine stores NULL, integers, "
                "reals, text and bytes, and converting anything else would be this library "
                "deciding what your value means."
            )

    def close(self) -> None:
        """Free the statement."""
        if self._handle:
            lib().inillucent_stmt_free(self._handle)
            self._handle = None

    def __enter__(self) -> "Statement":
        return self

    def __exit__(self, kind, value, trace) -> bool:
        self.close()
        return False

    def __del__(self) -> None:
        self.close()


class Connection:
    """One connection to a database, and one session.

    temp tables, ATTACH and the connection pragmas are scoped to the session
    this connection holds, so they survive for as long as it does.
    """

    def __init__(self, database: "Database", handle, owns_database: bool = False) -> None:
        self._database = database
        self._handle = handle
        self._owns_database = owns_database

    def execute(self, sql: str, params: Sequence[Any] = (), limit: Optional[int] = None) -> Rows:
        """Run one statement and return everything it produced.

        limit caps the rows handed back, not the rows produced. Rows.total is
        exact either way, because the engine materialises and the count was
        taken rather than estimated.

        @param sql - the statement to run
        @param params - values for ?1, ?2 and so on, in order
        @param limit - rows to hand back, or None for every row
        """
        if params:
            with self.prepare(sql) as statement:
                return statement.execute(params, limit)
        rows = c_void_p()
        error = c_void_p()
        status = lib().inillucent_execute(
            self._handle, sql.encode("utf-8"), capped(limit),
            ctypes.byref(rows), ctypes.byref(error)
        )
        check(status, error)
        return Rows(rows)

    def query(self, sql: str, params: Sequence[Any] = (),
              limit: Optional[int] = None) -> List[dict]:
        """Run one statement and return its rows as dictionaries.

        @param sql - the statement to run
        @param params - values for ?1, ?2 and so on, in order
        @param limit - rows to hand back, or None for every row
        """
        return self.execute(sql, params, limit).objects()

    def scalar(self, sql: str, params: Sequence[Any] = ()) -> Any:
        """Run one statement and return the first column of its first row.

        @param sql - the statement to run
        @param params - values for ?1, ?2 and so on, in order
        """
        return self.execute(sql, params, 1).scalar()

    def execute_batch(self, sql: str) -> None:
        """Run several statements separated by semicolons, for their effect.

        @param sql - the statements to run
        """
        error = c_void_p()
        status = lib().inillucent_execute_batch(
            self._handle, sql.encode("utf-8"), ctypes.byref(error)
        )
        check(status, error)

    def prepare(self, sql: str) -> Statement:
        """Compile a statement so it can be run more than once.

        @param sql - the statement to compile
        """
        handle = c_void_p()
        error = c_void_p()
        status = lib().inillucent_prepare(
            self._handle, sql.encode("utf-8"), ctypes.byref(handle), ctypes.byref(error)
        )
        check(status, error)
        return Statement(self, handle)

    def transaction(self) -> Transaction:
        """Open a transaction."""
        handle = c_void_p()
        error = c_void_p()
        status = lib().inillucent_txn_begin(self._handle, ctypes.byref(handle), ctypes.byref(error))
        check(status, error)
        return Transaction(self, handle)

    @property
    def last_insert_rowid(self) -> int:
        """The rowid the most recent insert on this connection produced."""
        return lib().inillucent_last_insert_rowid(self._handle)

    @property
    def total_changes(self) -> int:
        """How many rows every statement on this connection has changed."""
        return lib().inillucent_total_changes(self._handle)

    @property
    def in_transaction(self) -> bool:
        """Whether a transaction is open on this connection."""
        return bool(lib().inillucent_in_transaction(self._handle))

    @property
    def schema_cookie(self) -> int:
        """The schema's generation, which changes when the schema does.

        Compare it to know whether a cached table description is stale.
        """
        return lib().inillucent_schema_cookie(self._handle)

    def cancel(self) -> None:
        """Ask a running statement to stop.

        This always raises Unsupported today, and supports("cancel") says so
        before an application draws a Stop button: the engine runs a statement
        whole rather than a row at a time, so there is no point at which it
        could notice. It is here so a binding can wire it once and have it start
        working the day the capability changes.
        """
        error = c_void_p()
        check(lib().inillucent_cancel(self._handle, ctypes.byref(error)), error)

    def close(self) -> None:
        """Free the connection, and the database too when this connection owns it.

        A connection from `connect()` owns its database, because the caller was
        never handed one to close. The handle is cleared before the database is
        closed, so the database closing its connections back does not recurse.
        """
        if self._handle:
            lib().inillucent_conn_free(self._handle)
            self._handle = None
            if self._owns_database:
                self._database.close()

    def __enter__(self) -> "Connection":
        return self

    def __exit__(self, kind, value, trace) -> bool:
        self.close()
        return False

    def __del__(self) -> None:
        self.close()


class Database:
    """One open database file.

    One file is one buffer pool and the engine is single threaded, so confine a
    Database and everything under it to one thread, or serialise every call on
    it with a lock of your own. There is no lock inside.
    """

    def __init__(self, path: str, create: bool = True, read_only: bool = False,
                 diagnostics: bool = False) -> None:
        flags = 0
        if create:
            flags |= OPEN_CREATE
        if read_only:
            flags |= OPEN_READONLY
        if diagnostics:
            flags |= OPEN_DIAGNOSTICS
        handle = c_void_p()
        error = c_void_p()
        status = lib().inillucent_open(
            path.encode("utf-8"), flags, ctypes.byref(handle), ctypes.byref(error)
        )
        check(status, error)
        self._handle = handle
        self._connections: List[Connection] = []

    def connect(self) -> Connection:
        """Open a connection, and with it a session."""
        handle = c_void_p()
        error = c_void_p()
        status = lib().inillucent_connect(self._handle, ctypes.byref(handle), ctypes.byref(error))
        check(status, error)
        connection = Connection(self, handle)
        self._connections.append(connection)
        return connection

    @property
    def path(self) -> str:
        """The file this database is in."""
        return decode(lib().inillucent_path(self._handle)) or ""

    def checkpoint(self) -> None:
        """Make everything written so far durable in the file."""
        error = c_void_p()
        check(lib().inillucent_checkpoint(self._handle, ctypes.byref(error)), error)

    def integrity_check(self) -> None:
        """Walk every tree and raise on the first thing that is wrong."""
        error = c_void_p()
        check(lib().inillucent_integrity_check(self._handle, ctypes.byref(error)), error)

    def backup_to(self, path: str) -> None:
        """Copy the database to a path, opening and checking the copy first.

        A backup nobody checked is a file that is assumed to be a database.

        @param path - where to write the copy
        """
        error = c_void_p()
        check(
            lib().inillucent_backup_to(self._handle, path.encode("utf-8"), ctypes.byref(error)),
            error,
        )

    def close(self) -> None:
        """Checkpoint and close, closing every connection first.

        The C library refuses to close a database that still has connections on
        it, which is deliberate: freeing it then would leave them pointing at
        memory that is gone.
        """
        if not self._handle:
            return
        for connection in self._connections:
            connection.close()
        self._connections.clear()
        error = c_void_p()
        status = lib().inillucent_close(self._handle, ctypes.byref(error))
        self._handle = None
        check(status, error)

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, kind, value, trace) -> bool:
        self.close()
        return False

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            # A finaliser that raises during interpreter shutdown prints a
            # message nobody can act on and hides whatever was really happening.
            # An explicit close() reports properly.
            pass


def connect(path: str, **options: Any) -> Connection:
    """Open a database and return a connection on it, in one call.

    This is the shape most applications want, and it is what sqlite3.connect and
    psycopg.connect look like. The connection holds the database alive, so
    closing the connection is enough.

    @param path - the database file
    @param options - passed to Database: create, read_only, diagnostics
    """
    database = Database(path, **options)
    connection = database.connect()
    connection._owns_database = True
    return connection
