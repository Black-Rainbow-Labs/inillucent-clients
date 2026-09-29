// Proves the same installed package works from plain JavaScript with ES modules,
// and that the two entry points describe the same driver.
//
// The TypeScript directory tests the client's behaviour. This tests that a
// JavaScript project, which installs the package rather than building it, gets a
// working import of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

import { connect, version, driverPath, UnsupportedError, InillucentError, Status } from 'inillucent-client';

test('an ES module import gives a working database', () => {
  const path = join(tmpdir(), `inillucent-esm-${process.pid}-${Date.now()}.rdb`);
  rmSync(path, { force: true });
  const db = connect(path);
  try {
    db.execute('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)');
    db.execute('INSERT INTO note (body) VALUES (?1)', ['hello']);
    assert.deepEqual(db.query('SELECT id, body FROM note'), [{ id: 1, body: 'hello' }]);
    assert.equal(db.scalar('SELECT COUNT(*) FROM note'), 1);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('an empty string is stored as an empty string, not as NULL', () => {
  // The C ABI reads a null value pointer as NULL, and a zero length buffer
  // reaches it as one, so this is the binding mistake most worth a test.
  const path = join(tmpdir(), `inillucent-esm-empty-${process.pid}-${Date.now()}.rdb`);
  rmSync(path, { force: true });
  const db = connect(path);
  try {
    db.execute('CREATE TABLE n (a INTEGER PRIMARY KEY, b TEXT)');
    db.execute('INSERT INTO n VALUES (1, ?1)', [null]);
    db.execute('INSERT INTO n VALUES (2, ?1)', ['']);
    assert.equal(db.scalar('SELECT b FROM n WHERE a = 1'), null);
    assert.equal(db.scalar('SELECT b FROM n WHERE a = 2'), '');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('an unsupported refusal arrives as its own error type', () => {
  const path = join(tmpdir(), `inillucent-esm-refuse-${process.pid}-${Date.now()}.rdb`);
  rmSync(path, { force: true });
  const db = connect(path);
  try {
    assert.throws(() => db.execute('ATTACH DATABASE ? AS vault', ['vault.rdb']), (why) => {
      assert.ok(why instanceof UnsupportedError);
      assert.ok(why.feature, 'an unsupported refusal must name the construct');
      return true;
    });
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('both entry points load the same driver from the same file', () => {
  const required = createRequire(import.meta.url)('inillucent-client');
  assert.equal(required.version(), version());
  assert.equal(required.driverPath(), driverPath());
});

test('an encrypted database keeps its text out of the file and needs its key to open', () => {
  const folder = mkdtempSync(join(tmpdir(), 'inillucent-encrypted-esm-'));
  const path = join(folder, 'vault.rdb');
  const key = "x'" + '5a'.repeat(32) + "'";
  const secret = 'the vault code is 7461';
  try {
    const db = connect(path, { key });
    db.execute('CREATE TABLE vault (id INTEGER PRIMARY KEY, note TEXT)');
    db.execute('INSERT INTO vault (note) VALUES (?1)', [secret]);
    db.close();

    for (const name of readdirSync(folder)) {
      assert.ok(!readFileSync(join(folder, name)).includes(secret), `${name} holds the plaintext`);
    }
    const again = connect(path, { key });
    try {
      assert.deepEqual(again.query('SELECT note FROM vault').map((row) => row.note), [secret]);
      assert.equal(Object.values(again.query('PRAGMA encryption')[0])[0], 'xchacha20-poly1305');
    } finally {
      again.close();
    }

    const wrongKey = "x'" + '3c'.repeat(32) + "'";
    for (const options of [{}, { key: wrongKey }]) {
      assert.throws(
        () => connect(path, options),
        (why) => why instanceof InillucentError && why.status === Status.Corrupt,
      );
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
