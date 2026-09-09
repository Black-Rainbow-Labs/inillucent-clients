"""Runs conformance/suite.json against this client.

The suite is the driver's behaviour written as data rather than as prose, and
every client library in this repository runs the same file. When two of them
disagree, one of them is wrong; when they agree, the specification is one that
can actually be followed.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from typing import Any, List

import inillucent

SUITE = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "conformance", "suite.json")
)


def value_of(described: dict) -> Any:
    """Read a value out of the suite's one key object form.

    One key rather than a bare literal, so that NULL and the empty string can
    never be confused by the file itself.

    @param described - a value object such as {"int": 7}
    """
    if "null" in described:
        return None
    if "int" in described:
        return int(described["int"])
    if "real" in described:
        return float(described["real"])
    if "text" in described:
        return described["text"]
    if "blob" in described:
        return bytes(described["blob"])
    raise ValueError(f"{described!r} names no value kind")


def same(want: Any, got: Any) -> bool:
    """Compare an expected value to what came back.

    Floats are compared exactly. The suite's floats round trip exactly through
    IEEE 754, so an approximate comparison here would hide a client that lost
    precision.
    """
    if want is None or got is None:
        return want is None and got is None
    if isinstance(want, bytes) or isinstance(got, bytes):
        return want == got
    return want == got and type(want) is type(got)


def shown(value: Any) -> str:
    """Render a value for a failure message."""
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        return f"{len(value)} bytes {list(value)}"
    return repr(value)


def check_rows(step: dict, rows, wrong: List[str]) -> None:
    """Check the rows a successful step handed back.

    @param step - the case step, which asserts only the keys it carries
    @param rows - what the client returned
    @param wrong - collects one line per disagreement
    """
    want = step["rows"]
    if len(want) != len(rows.rows):
        wrong.append(f"there are {len(rows.rows)} rows and there should be {len(want)}")
        return
    for nth, row in enumerate(want):
        got = rows.rows[nth]
        if len(row) != len(got):
            wrong.append(f"row {nth} has {len(got)} cells and should have {len(row)}")
            continue
        for column, cell in enumerate(row):
            expected = value_of(cell)
            if not same(expected, got[column]):
                wrong.append(
                    f"row {nth} column {column} is {shown(got[column])} "
                    f"and should be {shown(expected)}"
                )


def check_success(step: dict, rows, wrong: List[str]) -> None:
    """Check a step that was expected to succeed."""
    if "status" in step:
        wrong.append(f"expected it to fail with `{step['status']}` and it succeeded")
        return
    if "columns" in step and step["columns"] != rows.columns:
        wrong.append(f"columns are {rows.columns} and should be {step['columns']}")
    if "rows" in step:
        check_rows(step, rows, wrong)
    if "affected" in step and rows.affected != step["affected"]:
        wrong.append(f"affected is {rows.affected} and should be {step['affected']}")
    if "total" in step and rows.total != step["total"]:
        wrong.append(
            f"total is {rows.total} and should be {step['total']}, and total is exact, "
            "so this is a real disagreement rather than an estimate being off"
        )
    if "more" in step and rows.more != step["more"]:
        wrong.append(f"more is {rows.more} and should be {step['more']}")


def check_failure(step: dict, failure: inillucent.InillucentError, wrong: List[str]) -> None:
    """Check a step that was expected to fail."""
    if "status" not in step:
        wrong.append(f"it was expected to succeed and it failed: {failure}")
        return
    if failure.status_name != step["status"]:
        wrong.append(
            f"it failed with `{failure.status_name}` and should have failed with "
            f"`{step['status']}`, saying: {failure}"
        )
    if "message_contains" in step and step["message_contains"] not in failure.message:
        wrong.append(
            f"the message is {failure.message!r} and should hold {step['message_contains']!r}"
        )
    if "feature_contains" in step:
        if not failure.feature:
            wrong.append(
                "it named no construct, and an unsupported refusal has to name one or an "
                "application cannot say what it hit"
            )
        elif step["feature_contains"] not in failure.feature:
            wrong.append(
                f"it named {failure.feature!r} and should have named something holding "
                f"{step['feature_contains']!r}"
            )
    if failure.status == inillucent.UNSUPPORTED:
        if not isinstance(failure, inillucent.UnsupportedError):
            wrong.append(
                "an unsupported refusal did not arrive as UnsupportedError, which is the "
                "whole of this design arriving in Python"
            )
        if not failure.feature:
            wrong.append("an unsupported refusal must carry a feature")


def scratch_path(name: str) -> str:
    """Return a database path nothing else is using.

    @param name - the case name, so a leftover file says which case left it
    """
    return os.path.join(
        tempfile.gettempdir(),
        f"inillucent-conformance-py-{name}-{os.getpid()}-{time.time_ns()}.rdb",
    )


def run_case(case: dict) -> List[str]:
    """Run one case and return one line per disagreement.

    A case may ask for a fresh connection per statement, which is the shape a
    client in another language is forced into. The session carries across them,
    so a temp table created in setup is still there in a later step.

    @param case - one entry from the suite's cases
    """
    path = scratch_path(case.get("name", "unnamed"))
    per_call = case.get("connection") == "per_call"
    wrong: List[str] = []
    database = inillucent.Database(path)
    connection = database.connect()
    try:
        for statement in case.get("setup", []):
            try:
                connection.execute(statement)
            except inillucent.InillucentError as why:
                wrong.append(f"the setup statement `{statement}` was refused: {why}")
        if not wrong:
            for step in case.get("steps", []):
                said: List[str] = []
                params = [value_of(value) for value in step.get("params", [])]
                try:
                    rows = connection.execute(step["sql"], params, step.get("limit"))
                    check_success(step, rows, said)
                except inillucent.InillucentError as failure:
                    check_failure(step, failure, said)
                for problem in said:
                    wrong.append(f"`{step['sql']}`: {problem}")
        if per_call:
            # The connection holds the session, and this client keeps one handle
            # for the life of a Connection, so a per_call case is satisfied by
            # what it already does. Asserting that here rather than assuming it.
            survived = connection.schema_cookie
            if survived is None:
                wrong.append("the session did not survive the case")
    finally:
        connection.close()
        database.close()
        try:
            os.remove(path)
        except OSError:
            pass
    return wrong


def run(verbose: bool = True) -> List[str]:
    """Run every case in the suite and return every failure line.

    @param verbose - print a line per case as it runs
    """
    with open(SUITE, encoding="utf-8") as handle:
        suite = json.load(handle)
    failures: List[str] = []
    for case in suite["cases"]:
        name = case.get("name", "(unnamed)")
        wrong = run_case(case)
        if verbose:
            print(f"  {'FAIL' if wrong else 'ok  '}  {name}")
        for problem in wrong:
            if verbose:
                print(f"          {problem}")
            failures.append(f"{name}: {problem}")
    return failures


if __name__ == "__main__":
    import sys

    print(f"{inillucent.version()}  ABI {inillucent.abi_version()}")
    print(f"driver: {inillucent.driver_path()}")
    print(f"suite:  {SUITE}\n")
    problems = run()
    print(f"\n{len(problems)} failures")
    sys.exit(1 if problems else 0)
