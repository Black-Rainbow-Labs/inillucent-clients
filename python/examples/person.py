"""Create a person table, insert rows, read them by column name, and update one.

Run it with:

    PYTHONPATH=python/src python python/examples/person.py
"""

import os
import tempfile

import inillucent

path = os.path.join(tempfile.gettempdir(), f"person-py-{os.getpid()}.rdb")
if os.path.exists(path):
    os.remove(path)

with inillucent.connect(path) as db:
    db.execute("""
        CREATE TABLE person (
          id         INTEGER PRIMARY KEY,
          first_name TEXT NOT NULL,
          last_name  TEXT NOT NULL,
          email      TEXT,
          age        INTEGER,
          height_m   REAL
        )
    """)

    # Insert. Values go in as ?1, ?2 and so on, never pasted into the text.
    db.execute(
        "INSERT INTO person (first_name, last_name, email, age, height_m) "
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        ["Ada", "Lovelace", "ada@example.com", 36, 1.65],
    )
    db.execute(
        "INSERT INTO person (first_name, last_name, email, age, height_m) "
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        ["Grace", "Hopper", None, 85, 1.57],
    )

    # Read. query() gives a dict per row, keyed by column name.
    for person in db.query("SELECT id, first_name, last_name, email, age, height_m "
                           "FROM person ORDER BY id"):
        print(person["id"], person["first_name"], person["last_name"],
              person["email"], person["age"], person["height_m"])

    # One value.
    print("people:", db.scalar("SELECT COUNT(*) FROM person"))

    # Update, and read the row back.
    changed = db.execute("UPDATE person SET email = ?1 WHERE last_name = ?2",
                         ["grace@example.com", "Hopper"])
    print("updated:", changed.affected)
    print("email now:", db.scalar("SELECT email FROM person WHERE last_name = ?1", ["Hopper"]))

os.remove(path)
