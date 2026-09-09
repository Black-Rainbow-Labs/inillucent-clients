"""Failures the driver reports, and the status codes behind them."""

from __future__ import annotations

from typing import Optional

OK = 0
UNSUPPORTED = 1
SYNTAX = 2
NOT_FOUND = 3
CONSTRAINT = 4
READONLY = 5
BUSY = 6
INTERRUPTED = 7
CORRUPT = 8
IO = 9
FULL = 10
TOO_BIG = 11
INVALID_STATE = 12
INTERNAL = 13

STATUS_NAMES = {
    OK: "ok",
    UNSUPPORTED: "unsupported",
    SYNTAX: "syntax",
    NOT_FOUND: "not_found",
    CONSTRAINT: "constraint",
    READONLY: "readonly",
    BUSY: "busy",
    INTERRUPTED: "interrupted",
    CORRUPT: "corrupt",
    IO: "io",
    FULL: "full",
    TOO_BIG: "too_big",
    INVALID_STATE: "invalid_state",
    INTERNAL: "internal",
}


def status_name(status: int) -> str:
    """Return the name of a status code, or a readable placeholder for one this
    version has never heard of.

    @param status - a value from the INILLUCENT_* status range
    """
    return STATUS_NAMES.get(status, f"status {status}")


class InillucentError(Exception):
    """Something the engine refused.

    It carries the status, not only the message, because a caller that has to
    match on prose to find out what happened will break the first time the
    wording improves.
    """

    def __init__(self, status: int, message: str, feature: Optional[str] = None,
                 detail: Optional[str] = None, offset: int = -1) -> None:
        super().__init__(message)
        self.status = status
        self.status_name = status_name(status)
        self.message = message
        self.feature = feature
        self.detail = detail
        self.offset = offset if offset >= 0 else None

    def __str__(self) -> str:
        said = f"{self.message} [{self.status_name}]"
        if self.offset is not None:
            said += f" at byte {self.offset}"
        return said


class UnsupportedError(InillucentError):
    """The engine has not implemented the construct.

    This is a separate type on purpose. The engine refuses what it has not built
    rather than answering it wrongly, so an application can say "this engine
    cannot do that yet" instead of "check your spelling". `feature` names the
    construct that was refused.
    """


class DriverLoadError(Exception):
    """The shared library could not be found, or its ABI does not match."""
