// Create a person table, insert rows, read them by column name, and update one.
//
// The same program as the TypeScript one, reached with require() instead of
// import. Run it with `node examples/person.cjs`.

const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { rmSync } = require('node:fs');
const { connect } = require('inillucent-client');

const path = join(tmpdir(), `person-js-${process.pid}.rdb`);
rmSync(path, { force: true });

const db = connect(path);

db.execute(`
  CREATE TABLE person (
    id         INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name  TEXT NOT NULL,
    email      TEXT,
    age        INTEGER,
    height_m   REAL
  )
`);

// Insert. Values go in as ?1, ?2 and so on, never pasted into the text.
db.execute(
  'INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)',
  ['Ada', 'Lovelace', 'ada@example.com', 36, 1.65],
);
db.execute(
  'INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)',
  ['Grace', 'Hopper', null, 85, 1.57],
);

// Read. query() gives an object per row, keyed by column name.
for (const person of db.query(
  'SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id',
)) {
  console.log(person.id, person.first_name, person.last_name, person.email, person.age, person.height_m);
}

// One value.
console.log('people:', db.scalar('SELECT COUNT(*) FROM person'));

// Update, and read the row back.
const changed = db.execute('UPDATE person SET email = ?1 WHERE last_name = ?2', [
  'grace@example.com',
  'Hopper',
]);
console.log('updated:', changed.affected);
console.log('email now:', db.scalar('SELECT email FROM person WHERE last_name = ?1', ['Hopper']));

db.close();
rmSync(path, { force: true });
