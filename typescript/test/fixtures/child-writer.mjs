// A second process for the integration test another_process_writes_and_this_one_reads_it.
//
// It opens the database file named on its command line through the built
// package, inserts one row, closes, and exits 0. Any failure exits 1 with the
// error on stderr, so the parent can say what went wrong.
//
// Run as: node child-writer.mjs <database path> <text to insert>

import { connect } from '../../dist/index.js';

const [path, note] = process.argv.slice(2);

// `node --test` with no file arguments runs everything under test/, this file
// included. Without a path there is nothing to write, and that is not a failure.
if (!path) {
  console.log('child-writer: no database path given, so there is nothing to write');
  process.exit(0);
}

try {
  const db = connect(path);
  db.execute('INSERT INTO note (body) VALUES (?1)', [note]);
  db.close();
  process.exit(0);
} catch (why) {
  console.error(why);
  process.exit(1);
}
