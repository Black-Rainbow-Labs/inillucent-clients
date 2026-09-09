"""The Inillucent client for Python.

Inillucent is an embedded database written in Rust. There is no server: your
program opens a file, sends SQL to a library in the same process, and gets typed
rows back.

    import inillucent

    with inillucent.connect("library.rdb") as db:
        db.execute("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)")
        db.execute("INSERT INTO authors VALUES (?1, ?2)", [1, "Octavia Butler"])
        for row in db.query("SELECT id, name FROM authors"):
            print(row["id"], row["name"])

Two things about this engine shape the whole library.

Values stay typed. NULL, integer, real, text and bytes come back as None, int,
float, str and bytes, and NULL is not the empty string.

The engine refuses what it has not built rather than answering it wrongly, and
that refusal has its own exception type, UnsupportedError, carrying the name of
the construct it could not do. Ask `supports(...)` or read `capabilities()`
before composing a statement, and every row of that table is checked against the
running engine by a test in both directions.
"""

from .capabilities import (SUPPORT_NO, SUPPORT_PARTIAL, SUPPORT_UNKNOWN,
                           SUPPORT_YES, Capability, abi_version, capabilities,
                           driver_path, supports, version)
from .database import (OPEN_CREATE, OPEN_DIAGNOSTICS, OPEN_READONLY, Connection,
                       Database, Statement, Transaction, connect)
from .errors import (BUSY, CONSTRAINT, CORRUPT, FULL, INTERNAL, INTERRUPTED,
                     INVALID_STATE, IO, NOT_FOUND, OK, READONLY, SYNTAX,
                     TOO_BIG, UNSUPPORTED, DriverLoadError, InillucentError,
                     UnsupportedError, status_name)
from .rows import BLOB, INTEGER, NULL, REAL, TEXT, Rows

__version__ = "0.1.0"

__all__ = [
    "connect",
    "Database",
    "Connection",
    "Statement",
    "Transaction",
    "Rows",
    "Capability",
    "InillucentError",
    "UnsupportedError",
    "DriverLoadError",
    "capabilities",
    "supports",
    "version",
    "abi_version",
    "driver_path",
    "status_name",
    "OPEN_CREATE",
    "OPEN_READONLY",
    "OPEN_DIAGNOSTICS",
    "SUPPORT_NO",
    "SUPPORT_YES",
    "SUPPORT_PARTIAL",
    "SUPPORT_UNKNOWN",
    "NULL",
    "INTEGER",
    "REAL",
    "TEXT",
    "BLOB",
    "OK",
    "UNSUPPORTED",
    "SYNTAX",
    "NOT_FOUND",
    "CONSTRAINT",
    "READONLY",
    "BUSY",
    "INTERRUPTED",
    "CORRUPT",
    "IO",
    "FULL",
    "TOO_BIG",
    "INVALID_STATE",
    "INTERNAL",
    "__version__",
]
