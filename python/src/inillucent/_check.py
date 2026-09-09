"""Turning a failed C call into the right Python exception."""

from __future__ import annotations

from ._library import lib
from .errors import UNSUPPORTED, InillucentError, UnsupportedError, status_name
from .rows import decode


def raise_from_error(handle) -> None:
    """Build the exception a C error describes, and free the error either way.

    The free happens in a finally because an exception built from an error must
    not leak it.

    @param handle - the C error handle, which is owned by this call
    """
    library = lib()
    try:
        status = library.inillucent_error_status(handle)
        message = decode(library.inillucent_error_message(handle)) or ""
        feature = decode(library.inillucent_error_feature(handle))
        detail = decode(library.inillucent_error_detail(handle))
        offset = library.inillucent_error_offset(handle)
    finally:
        library.inillucent_error_free(handle)
    kind = UnsupportedError if status == UNSUPPORTED else InillucentError
    raise kind(status, message, feature, detail, offset)


def check(status: int, error) -> None:
    """Raise when a call failed, using the error it produced.

    A non zero status with no error still raises: a call that failed and said
    nothing is not a reason to carry on.

    @param status - what the call returned
    @param error - the error out parameter the call was given
    """
    if status == 0:
        return
    if error:
        raise_from_error(error)
    raise InillucentError(status, f"the call failed with {status_name(status)}")
