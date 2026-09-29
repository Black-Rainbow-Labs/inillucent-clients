// A short integration test through the package's ES module entry point.
//
// The TypeScript folder runs every scenario in conformance/integration.md. This
// proves the parts a person calls most also work through import: open, write,
// close, reopen, read, a transaction, the error types, and a cancel sent while a
// statement runs on another thread. It uses a real file in a temporary folder
// and deletes the folder when it ends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database, InillucentError, UnsupportedError, Status, connect } from 'inillucent-client';

/**
 * Runs a test body with a fresh temporary folder, and deletes the folder after.
 * @param body - receives the folder path, and may return a promise
 */
async function inFolder(body) {
  const folder = mkdtempSync(join(tmpdir(), 'inillucent-integration-esm-'));
  try {
    return await body(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('esm: open, write, close, reopen and read', () =>
  inFolder((folder) => {
    const path = join(folder, 'notes.rdb');
    const db = connect(path);
    db.execute('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)');
    db.execute('INSERT INTO note (body) VALUES (?1), (?2)', ['first', 'second']);
    db.close();

    const again = new Database(path);
    try {
      const rows = again.connect().query('SELECT id, body FROM note ORDER BY id');
      assert.deepEqual(rows, [{ id: 1, body: 'first' }, { id: 2, body: 'second' }]);
    } finally {
      again.close();
    }
  }));

test('esm: a transaction commits, and a failing statement rolls it back', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'txn.rdb'));
    try {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const kept = db.transaction();
      assert.equal(kept.execute('INSERT INTO t VALUES (1)'), 1);
      kept.commit();
      const lost = db.transaction();
      lost.execute('INSERT INTO t VALUES (2)');
      assert.throws(() => lost.execute('INSERT INTO t VALUES (1)'), (why) => why.status === Status.Constraint);
      assert.throws(() => lost.commit(), (why) => why.status === Status.InvalidState);
      assert.deepEqual(db.execute('SELECT id FROM t').column(0), [1]);
    } finally {
      db.close();
    }
  }));

test('esm: failures arrive as the right error types', () =>
  inFolder((folder) => {
    const db = connect(join(folder, 'errors.rdb'));
    try {
      assert.throws(() => db.execute('SELECT * FROM missing_table'), (why) => {
        assert.ok(why instanceof InillucentError);
        assert.equal(why.statusName, 'not_found');
        return true;
      });
      assert.throws(() => db.execute('CREATE VIRTUAL TABLE f USING fts5(a, detail=none)'), UnsupportedError);
      const statement = db.prepare('SELECT 1');
      assert.throws(() => db.close(), (why) => why.status === Status.InvalidState);
      statement.close();
    } finally {
      db.close();
    }
  }));

test('esm: cancel stops a statement started with executeAsync', () =>
  inFolder(async (folder) => {
    const db = connect(join(folder, 'cancel.rdb'));
    try {
      const running = db.executeAsync(
        'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000000) SELECT count(*) FROM n',
      );
      setTimeout(() => db.cancel(), 100);
      await assert.rejects(running, (why) => why.status === Status.Interrupted);
      assert.equal(db.scalar('SELECT 1'), 1);
    } finally {
      db.close();
    }
  }));
