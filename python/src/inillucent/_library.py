"""Finding the shared library, loading it, and declaring every signature.

The signature declarations are not optional. ctypes assumes an undeclared
function returns a 32 bit int, so an undeclared function that returns a pointer
has its top half cut off on a 64 bit build, and the crash lands nowhere near the
call that caused it.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import sys
from ctypes import (POINTER, c_char_p, c_double, c_int32, c_int64, c_size_t,
                    c_uint8, c_uint32, c_uint64, c_void_p)
from typing import List

from .errors import DriverLoadError

# The ABI this package was written against. Only the major has to match: a minor
# bump adds symbols, a major bump moves one.
ABI_MAJOR = 1


def library_names() -> List[str]:
    """Return the shared library file names this platform uses."""
    if sys.platform == "win32":
        return ["inillucent_driver_capi.dll"]
    if sys.platform == "darwin":
        return ["libinillucent_driver_capi.dylib"]
    return ["libinillucent_driver_capi.so"]


def search_paths() -> List[str]:
    """Return every place the shared library is looked for, in order.

    The order is the same in all eight client libraries, so an application that
    works in one works in the rest: an explicit path first, then this
    repository's native folder, then an engine checkout beside it.
    """
    named = os.environ.get("INILLUCENT_DRIVER_LIB")
    candidates = [named] if named else []
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    engines = [os.path.join(repo, "..", "inillucent"),
               os.path.join(repo, "..", "..", "inillucent")]
    for name in library_names():
        candidates.append(os.path.join(repo, "native", name))
        for engine in engines:
            for profile in ("release", "debug"):
                candidates.append(os.path.join(engine, "target", profile, name))
    return [os.path.abspath(path) for path in candidates if path]


def resolve_library() -> str:
    """Return the path of the shared library, or raise saying where it looked.

    A message that names every place it tried is the difference between a
    problem somebody can fix and one they have to guess at.
    """
    for candidate in search_paths():
        if os.path.isfile(candidate):
            return candidate
    for name in library_names():
        found = ctypes.util.find_library(name)
        if found:
            return found
    looked = "\n  ".join(search_paths())
    raise DriverLoadError(
        "cannot find the inillucent driver shared library. Looked in:\n  "
        + looked
        + "\nBuild it with\n"
        "  cargo build --release --manifest-path <engine>/Cargo.toml -p inillucent-driver-capi\n"
        "then run scripts/fetch-native.mjs, or set INILLUCENT_DRIVER_LIB to its path."
    )


def check_abi(library, path: str) -> None:
    """Refuse a major ABI mismatch by name, before anything else is called.

    @param library - the loaded shared library
    @param path - where it was loaded from, so the message can name it
    """
    reported = library.inillucent_abi_version()
    major = reported // 1_000_000
    minor = (reported // 1000) % 1000
    patch = reported % 1000
    if major != ABI_MAJOR:
        raise DriverLoadError(
            f"{path} reports ABI {major}.{minor}.{patch}, and this package was written "
            f"for ABI {ABI_MAJOR}.x. A major bump moves a signature, so calling it would "
            "fail in a way nobody can read. Install a matching driver."
        )


def declare_library_functions(lib) -> None:
    """Declare the signatures of the version and capability calls."""
    lib.inillucent_abi_version.restype = c_uint32
    lib.inillucent_version.restype = c_char_p
    lib.inillucent_capability_count.restype = c_size_t
    lib.inillucent_capability.argtypes = [c_size_t, POINTER(c_char_p),
                                          POINTER(c_int32), POINTER(c_char_p)]
    lib.inillucent_capability.restype = c_int32
    lib.inillucent_supports.argtypes = [c_char_p]
    lib.inillucent_supports.restype = c_int32


def declare_database_functions(lib) -> None:
    """Declare the signatures of the database and connection calls."""
    lib.inillucent_open.argtypes = [c_char_p, c_uint32, POINTER(c_void_p), POINTER(c_void_p)]
    lib.inillucent_open.restype = c_int32
    for name in ("inillucent_close", "inillucent_checkpoint", "inillucent_integrity_check"):
        getattr(lib, name).argtypes = [c_void_p, POINTER(c_void_p)]
        getattr(lib, name).restype = c_int32
    lib.inillucent_backup_to.argtypes = [c_void_p, c_char_p, POINTER(c_void_p)]
    lib.inillucent_backup_to.restype = c_int32
    lib.inillucent_path.argtypes = [c_void_p]
    lib.inillucent_path.restype = c_char_p

    lib.inillucent_connect.argtypes = [c_void_p, POINTER(c_void_p), POINTER(c_void_p)]
    lib.inillucent_connect.restype = c_int32
    lib.inillucent_conn_free.argtypes = [c_void_p]
    lib.inillucent_conn_free.restype = None
    lib.inillucent_execute.argtypes = [c_void_p, c_char_p, c_uint64,
                                       POINTER(c_void_p), POINTER(c_void_p)]
    lib.inillucent_execute.restype = c_int32
    lib.inillucent_execute_batch.argtypes = [c_void_p, c_char_p, POINTER(c_void_p)]
    lib.inillucent_execute_batch.restype = c_int32
    lib.inillucent_last_insert_rowid.argtypes = [c_void_p]
    lib.inillucent_last_insert_rowid.restype = c_int64
    lib.inillucent_total_changes.argtypes = [c_void_p]
    lib.inillucent_total_changes.restype = c_int64
    lib.inillucent_in_transaction.argtypes = [c_void_p]
    lib.inillucent_in_transaction.restype = c_int32
    lib.inillucent_schema_cookie.argtypes = [c_void_p]
    lib.inillucent_schema_cookie.restype = c_uint64
    lib.inillucent_cancel.argtypes = [c_void_p, POINTER(c_void_p)]
    lib.inillucent_cancel.restype = c_int32


def declare_statement_functions(lib) -> None:
    """Declare the signatures of the prepared statement and binding calls."""
    lib.inillucent_prepare.argtypes = [c_void_p, c_char_p, POINTER(c_void_p), POINTER(c_void_p)]
    lib.inillucent_prepare.restype = c_int32
    lib.inillucent_stmt_free.argtypes = [c_void_p]
    lib.inillucent_stmt_free.restype = None
    lib.inillucent_bind_null.argtypes = [c_void_p, c_uint32]
    lib.inillucent_bind_null.restype = c_int32
    lib.inillucent_bind_int.argtypes = [c_void_p, c_uint32, c_int64]
    lib.inillucent_bind_int.restype = c_int32
    lib.inillucent_bind_real.argtypes = [c_void_p, c_uint32, c_double]
    lib.inillucent_bind_real.restype = c_int32
    lib.inillucent_bind_text.argtypes = [c_void_p, c_uint32, c_char_p, c_size_t]
    lib.inillucent_bind_text.restype = c_int32
    lib.inillucent_bind_blob.argtypes = [c_void_p, c_uint32, POINTER(c_uint8), c_size_t]
    lib.inillucent_bind_blob.restype = c_int32
    lib.inillucent_clear_bindings.argtypes = [c_void_p]
    lib.inillucent_clear_bindings.restype = None
    lib.inillucent_stmt_execute.argtypes = [c_void_p, c_uint64,
                                            POINTER(c_void_p), POINTER(c_void_p)]
    lib.inillucent_stmt_execute.restype = c_int32


def declare_rows_functions(lib) -> None:
    """Declare the signatures of the result reading calls."""
    lib.inillucent_rows_free.argtypes = [c_void_p]
    lib.inillucent_rows_free.restype = None
    lib.inillucent_rows_column_count.argtypes = [c_void_p]
    lib.inillucent_rows_column_count.restype = c_size_t
    for name in ("inillucent_rows_column_name", "inillucent_rows_column_type"):
        getattr(lib, name).argtypes = [c_void_p, c_size_t]
        getattr(lib, name).restype = c_char_p
    for name in ("inillucent_rows_count", "inillucent_rows_total"):
        getattr(lib, name).argtypes = [c_void_p]
        getattr(lib, name).restype = c_size_t
    lib.inillucent_rows_more.argtypes = [c_void_p]
    lib.inillucent_rows_more.restype = c_int32
    lib.inillucent_rows_affected.argtypes = [c_void_p]
    lib.inillucent_rows_affected.restype = c_int64
    lib.inillucent_rows_elapsed_us.argtypes = [c_void_p]
    lib.inillucent_rows_elapsed_us.restype = c_uint64
    lib.inillucent_rows_tag.argtypes = [c_void_p]
    lib.inillucent_rows_tag.restype = c_char_p
    lib.inillucent_value_type.argtypes = [c_void_p, c_size_t, c_size_t]
    lib.inillucent_value_type.restype = c_int32
    lib.inillucent_value_int.argtypes = [c_void_p, c_size_t, c_size_t]
    lib.inillucent_value_int.restype = c_int64
    lib.inillucent_value_real.argtypes = [c_void_p, c_size_t, c_size_t]
    lib.inillucent_value_real.restype = c_double
    lib.inillucent_value_bytes.argtypes = [c_void_p, c_size_t, c_size_t, POINTER(c_size_t)]
    lib.inillucent_value_bytes.restype = POINTER(c_uint8)


def declare_transaction_and_error_functions(lib) -> None:
    """Declare the signatures of the transaction and error calls."""
    lib.inillucent_txn_begin.argtypes = [c_void_p, POINTER(c_void_p), POINTER(c_void_p)]
    lib.inillucent_txn_begin.restype = c_int32
    lib.inillucent_txn_execute.argtypes = [c_void_p, c_char_p,
                                           POINTER(c_uint64), POINTER(c_void_p)]
    lib.inillucent_txn_execute.restype = c_int32
    lib.inillucent_txn_commit.argtypes = [c_void_p, POINTER(c_void_p)]
    lib.inillucent_txn_commit.restype = c_int32
    lib.inillucent_txn_rollback.argtypes = [c_void_p]
    lib.inillucent_txn_rollback.restype = None

    lib.inillucent_error_status.argtypes = [c_void_p]
    lib.inillucent_error_status.restype = c_int32
    for name in ("inillucent_error_message", "inillucent_error_feature",
                 "inillucent_error_detail"):
        getattr(lib, name).argtypes = [c_void_p]
        getattr(lib, name).restype = c_char_p
    lib.inillucent_error_offset.argtypes = [c_void_p]
    lib.inillucent_error_offset.restype = c_int32
    lib.inillucent_error_free.argtypes = [c_void_p]
    lib.inillucent_error_free.restype = None


def load():
    """Locate, load, version check and declare the shared library."""
    path = resolve_library()
    library = ctypes.CDLL(path)
    library.inillucent_abi_version.restype = c_uint32
    check_abi(library, path)
    declare_library_functions(library)
    declare_database_functions(library)
    declare_statement_functions(library)
    declare_rows_functions(library)
    declare_transaction_and_error_functions(library)
    library.loaded_from = path
    return library


_LIB = None


def lib():
    """Return the loaded shared library, loading it the first time it is asked for."""
    global _LIB
    if _LIB is None:
        _LIB = load()
    return _LIB
