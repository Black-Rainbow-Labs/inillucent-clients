// A first program: create a table, write rows, read them back, and ask the
// engine what it can do before composing anything unusual.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { connect, supports, Support, version, UnsupportedError } from '../dist/index.js';

const path = join(tmpdir(), `inillucent-quickstart-${process.pid}.rdb`);
rmSync(path, { force: true });

const db = connect(path);
console.log(version());

db.execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)');
db.execute('INSERT INTO authors VALUES (?1, ?2, ?3)', [1, 'Octavia Butler', 4.8]);
db.execute('INSERT INTO authors VALUES (?1, ?2, ?3)', [2, 'Ursula Le Guin', null]);

for (const author of db.query('SELECT id, name, rating FROM authors ORDER BY id')) {
  console.log(author.id, author.name, author.rating);
}

const page = db.execute('SELECT id, name FROM authors ORDER BY id', [], 1);
console.log(`showing ${page.length} of ${page.total}${page.more ? ', more to come' : ''}`);

// A transaction is a handle, so what a write did can be checked before commit.
const txn = db.transaction();
const changed = txn.execute("INSERT INTO authors VALUES (3, 'Ted Chiang', 4.9)");
if (changed === 1) txn.commit();
else txn.rollback();

console.log('authors:', db.scalar('SELECT COUNT(*) FROM authors'));
console.log('cancel supported:', supports('cancel') === Support.Yes);

try {
  db.cancel();
} catch (why) {
  if (why instanceof UnsupportedError) console.log('cancel refused, and it named:', why.feature);
  else throw why;
}

db.close();
rmSync(path, { force: true });
