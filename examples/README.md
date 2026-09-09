# The person example

The same program in all eight languages: create a `person` table, insert rows,
read them back by column name, update one, and read it again.

It is the example the per language READMEs and
[inillucent.com/docs](https://inillucent.com/docs#clients) show, and every
output printed there is this program's real output rather than something typed
into a document.

```sql
CREATE TABLE person (
  id         INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  email      TEXT,
  age        INTEGER,
  height_m   REAL
)
```

Run them all and compare the output:

```sh
node scripts/run-person-examples.mjs
```

Each one lives beside its client: `python/examples/person.py`,
`typescript/examples/person.ts`, and so on.
