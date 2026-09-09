"""What the engine says it can do, and how to ask before composing a statement."""

from __future__ import annotations

import ctypes
from ctypes import c_char_p, c_int32
from typing import List, NamedTuple

from ._library import lib
from .rows import decode

SUPPORT_NO = 0
SUPPORT_YES = 1
SUPPORT_PARTIAL = -1
SUPPORT_UNKNOWN = -2

SUPPORT_NAMES = {
    SUPPORT_NO: "no",
    SUPPORT_YES: "yes",
    SUPPORT_PARTIAL: "partial",
    SUPPORT_UNKNOWN: "unknown",
}


class Capability(NamedTuple):
    """One row of the engine's capability table."""

    name: str
    support: int
    note: str

    @property
    def support_name(self) -> str:
        """Return the support state as a word."""
        return SUPPORT_NAMES.get(self.support, f"state {self.support}")

    @property
    def supported(self) -> bool:
        """Return whether the engine will do this at all.

        Partial counts as supported, and the note says what the limit is. A
        caller that needs the limit reads `note` rather than this.
        """
        return self.support in (SUPPORT_YES, SUPPORT_PARTIAL)


def capabilities() -> List[Capability]:
    """Return every capability the engine declares.

    Ask this before composing a statement rather than after. Every row is
    checked against the running engine by a test in both directions, so a claim
    of support that fails and a claim of absence that now works each turn it red.
    """
    library = lib()
    found: List[Capability] = []
    for nth in range(library.inillucent_capability_count()):
        name = c_char_p()
        state = c_int32()
        note = c_char_p()
        status = library.inillucent_capability(
            nth, ctypes.byref(name), ctypes.byref(state), ctypes.byref(note)
        )
        if status != 0:
            continue
        found.append(Capability(decode(name.value) or "", state.value, decode(note.value) or ""))
    return found


def supports(name: str) -> int:
    """Return whether the engine does something, by name.

    SUPPORT_UNKNOWN means this build has never heard of the capability, and it
    should be treated as no rather than as yes: one that was never declared was
    certainly never checked.

    @param name - the capability name
    """
    return lib().inillucent_supports(name.encode("utf-8"))


def version() -> str:
    """Return what the driver calls itself."""
    return decode(lib().inillucent_version()) or ""


def abi_version() -> str:
    """Return the shared library's ABI version as major.minor.patch."""
    reported = lib().inillucent_abi_version()
    return f"{reported // 1_000_000}.{(reported // 1000) % 1000}.{reported % 1000}"


def driver_path() -> str:
    """Return the file the shared library was loaded from."""
    return getattr(lib(), "loaded_from", "")
