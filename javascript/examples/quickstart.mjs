// The same quickstart, in plain JavaScript with ES modules.
//
// There is no separate JavaScript package: `inillucent` is written in TypeScript
// and published with both an ESM and a CommonJS entry point plus type
// declarations, so a JavaScript project installs exactly the same thing and gets
// editor completion from the declarations without writing any types itself.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { connect, supports, Support, version, UnsupportedError } from 'inillucent-client';

const path = join(tmpdir(), `inillucent-js-quickstart-${process.pid}.rdb`);
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

const txn = db.transaction();
if (txn.execute("INSERT INTO authors VALUES (3, 'Ted Chiang', 4.9)") === 1) txn.commit();
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
