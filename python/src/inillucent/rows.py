"""One materialised result, copied out of the C handle into Python."""

from __future__ import annotations

import ctypes
from ctypes import c_size_t
from typing import Any, Dict, Iterator, List, Optional, Sequence

from ._library import lib

NULL = 0
INTEGER = 1
REAL = 2
TEXT = 3
BLOB = 4


def read_cell(handle, row: int, column: int) -> Any:
    """Read one cell as the kind it actually is.

    Text is not NUL terminated and may contain a NUL byte, so the length is read
    rather than the bytes scanned.

    @param handle - the C result handle
    @param row - the row index
    @param column - the column index
    """
    library = lib()
    kind = library.inillucent_value_type(handle, row, column)
    if kind == NULL:
        return None
    if kind == INTEGER:
        return library.inillucent_value_int(handle, row, column)
    if kind == REAL:
        return library.inillucent_value_real(handle, row, column)
    length = c_size_t()
    pointer = library.inillucent_value_bytes(handle, row, column, ctypes.byref(length))
    if not pointer:
        return None
    raw = bytes(bytearray(pointer[: length.value]))
    return raw.decode("utf-8") if kind == TEXT else raw


def decode(pointer) -> Optional[str]:
    """Copy a C string out of the library into a Python string.

    Every string is copied on the way out, because it points inside a handle the
    caller may free.

    @param pointer - the bytes ctypes read, or None
    """
    if pointer is None:
        return None
    return pointer.decode("utf-8", "replace")


class Rows:
    """Everything one statement produced.

    The result is materialised by the engine and copied into Python here, so this
    object stays usable after the C handle is freed. That is what lets it be
    returned from a function and iterated later, which is the idiom a Python
    caller expects.
    """

    def __init__(self, handle) -> None:
        library = lib()
        try:
            count = library.inillucent_rows_column_count(handle)
            self.columns: List[str] = [
                decode(library.inillucent_rows_column_name(handle, nth)) or ""
                for nth in range(count)
            ]
            self.column_types: List[str] = [
                decode(library.inillucent_rows_column_type(handle, nth)) or ""
                for nth in range(count)
            ]
            self.rows: List[List[Any]] = [
                [read_cell(handle, row, column) for column in range(count)]
                for row in range(library.inillucent_rows_count(handle))
            ]
            self.total: int = library.inillucent_rows_total(handle)
            self.more: bool = bool(library.inillucent_rows_more(handle))
            changed = library.inillucent_rows_affected(handle)
            self.affected: Optional[int] = None if changed < 0 else changed
            self.elapsed_us: int = library.inillucent_rows_elapsed_us(handle)
            self.tag: str = decode(library.inillucent_rows_tag(handle)) or ""
        finally:
            library.inillucent_rows_free(handle)

    def objects(self) -> List[Dict[str, Any]]:
        """Return every row as a dictionary keyed by column name.

        A duplicate column name would silently lose a value, so the later one
        wins and the caller who needs both reads `rows` instead.
        """
        return [dict(zip(self.columns, row)) for row in self.rows]

    def one(self) -> Optional[Sequence[Any]]:
        """Return the first row, or None when the statement produced none."""
        return self.rows[0] if self.rows else None

    def scalar(self) -> Any:
        """Return the first column of the first row, or None when there is none.

        This is the shape of a COUNT or a MAX, where wrapping one number in two
        lists is a cost the caller pays on every line.
        """
        first = self.one()
        return first[0] if first else None

    def column(self, nth_or_name) -> List[Any]:
        """Return one column of every row.

        @param nth_or_name - the column index, or its name
        """
        index = nth_or_name if isinstance(nth_or_name, int) else self.columns.index(nth_or_name)
        return [row[index] for row in self.rows]

    def __len__(self) -> int:
        return len(self.rows)

    def __iter__(self) -> Iterator[Sequence[Any]]:
        return iter(self.rows)

    def __getitem__(self, nth: int) -> Sequence[Any]:
        return self.rows[nth]

    def __repr__(self) -> str:
        return f"<Rows {self.tag}: {len(self.rows)} of {self.total}>"
