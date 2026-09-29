// Runs conformance/suite.json against this client.
//
// The suite is the driver's behaviour written as data rather than as prose, and
// every client library in this repository runs the same file. When two of them
// disagree, one of them is wrong; when they agree, the specification is one that
// can actually be followed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Database, InillucentError, UnsupportedError, Status, Support, capabilities, supports } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// INILLUCENT_SUITE names a different suite file. It exists so a copy with one
// expected value changed can prove the runner notices, without touching the
// real suite that every other client reads.
const SUITE = process.env.INILLUCENT_SUITE ?? resolve(here, '..', '..', 'conformance', 'suite.json');

// What this runner can do, out of the suite's `capabilities`. It holds one real
// connection across a case, and that connection is one session, so a case that
// asks for `"connection": "per_call"` is satisfied without doing anything: the
// session is already continued from one statement to the next.
const CAPABILITIES = new Set(['session']);

/**
 * Keeps every integer in the suite exact.
 *
 * JSON.parse reads a number through a double, so 9223372036854775807 would
 * arrive as 9223372036854775808 and a check against it would pass for the wrong
 * value. The reviver reads the number's own source text, and an integer outside
 * the range a double holds exactly becomes a bigint, which is what the client
 * returns for it.
 *
 * @param key - the property being read
 * @param value - what JSON.parse made of it
 * @param context - carries the source text of a primitive value
 */
function exactIntegers(key, value, context) {
  if (typeof value !== 'number' || Number.isSafeInteger(value)) return value;
  const source = context?.source;
  return typeof source === 'string' && /^-?\d+$/.test(source) ? BigInt(source) : value;
}

/**
 * Reads the suite with every integer exact, and refuses to run on a node whose
 * JSON.parse does not hand a reviver the source text.
 * @param path - the suite file
 */
function readSuite(path) {
  const probe = JSON.parse('{"n": 9223372036854775807}', exactIntegers);
  if (probe.n !== 9223372036854775807n) {
    throw new Error('this node gives JSON.parse revivers no source text, so the suite cannot be read without losing 64 bit integers');
  }
  return JSON.parse(readFileSync(path, 'utf8'), exactIntegers);
}

/**
 * Returns the capabilities a case needs and this runner does not have.
 * @param theCase - one entry from the suite's cases
 */
function missingFor(theCase) {
  return (theCase.needs ?? []).filter((need) => !CAPABILITIES.has(need));
}

/**
 * Reads a value out of the suite's one key object form.
 *
 * One key rather than a bare literal, so that NULL and the empty string can
 * never be confused by the file itself.
 *
 * @param described - a value object such as {"int": 7}
 */
function valueOf(described) {
  if ('null' in described) return null;
  if ('int' in described) return described.int;
  if ('real' in described) return described.real;
  if ('text' in described) return described.text;
  if ('blob' in described) return Buffer.from(described.blob);
  throw new Error(`${JSON.stringify(described)} names no value kind`);
}

/**
 * Compares an expected value to what came back.
 *
 * A real and an integer are different kinds, so 1 and 1.0 must not be treated as
 * equal by accident. The suite's reals all have a fractional part or are written
 * as reals, and the engine reports the kind, so this compares the JavaScript
 * values it produced.
 *
 * @param want - what the suite says
 * @param got - what the client returned
 */
function same(want, got) {
  if (want === null || got === null) return want === null && got === null;
  if (Buffer.isBuffer(want) || Buffer.isBuffer(got)) {
    return Buffer.isBuffer(want) && Buffer.isBuffer(got) && want.equals(got);
  }
  if (typeof want === 'bigint' || typeof got === 'bigint') return BigInt(want) === BigInt(got);
  return want === got;
}

/**
 * Renders a value for a failure message.
 * @param value - an expected or returned value
 */
function shown(value) {
  if (value === null) return 'NULL';
  if (Buffer.isBuffer(value)) return `${value.length} bytes [${[...value]}]`;
  if (typeof value === 'bigint') return `${value}n`;
  return JSON.stringify(value);
}

/**
 * Checks the rows a successful step handed back.
 * @param step - the case step, which asserts only the keys it carries
 * @param rows - what the client returned
 * @param wrong - collects one line per disagreement
 */
function checkRows(step, rows, wrong) {
  if (step.rows.length !== rows.rows.length) {
    wrong.push(`there are ${rows.rows.length} rows and there should be ${step.rows.length}`);
    return;
  }
  step.rows.forEach((row, nth) => {
    const got = rows.rows[nth];
    if (row.length !== got.length) {
      wrong.push(`row ${nth} has ${got.length} cells and should have ${row.length}`);
      return;
    }
    row.forEach((cell, column) => {
      const expected = valueOf(cell);
      if (!same(expected, got[column])) {
        wrong.push(`row ${nth} column ${column} is ${shown(got[column])} and should be ${shown(expected)}`);
      }
    });
  });
}

/** Checks a step that was expected to succeed. */
function checkSuccess(step, rows, wrong) {
  if (step.status !== undefined) {
    wrong.push(`expected it to fail with \`${step.status}\` and it succeeded`);
    return;
  }
  if (step.columns && JSON.stringify(step.columns) !== JSON.stringify(rows.columns)) {
    wrong.push(`columns are ${JSON.stringify(rows.columns)} and should be ${JSON.stringify(step.columns)}`);
  }
  if (step.rows) checkRows(step, rows, wrong);
  if ('affected' in step && rows.affected !== step.affected) {
    wrong.push(`affected is ${rows.affected} and should be ${step.affected}`);
  }
  if ('total' in step && rows.total !== step.total) {
    wrong.push(
      `total is ${rows.total} and should be ${step.total}, and total is exact, so this is a ` +
        'real disagreement rather than an estimate being off',
    );
  }
  if ('more' in step && rows.more !== step.more) {
    wrong.push(`more is ${rows.more} and should be ${step.more}`);
  }
}

/** Checks a step that was expected to fail. */
function checkFailure(step, failure, wrong) {
  if (step.status === undefined) {
    wrong.push(`it was expected to succeed and it failed: ${failure.message}`);
    return;
  }
  if (failure.statusName !== step.status) {
    wrong.push(`it failed with \`${failure.statusName}\` and should have failed with \`${step.status}\`, saying: ${failure.message}`);
  }
  if (step.message_contains && !failure.message.includes(step.message_contains)) {
    wrong.push(`the message is ${JSON.stringify(failure.message)} and should hold ${JSON.stringify(step.message_contains)}`);
  }
  if (step.feature_contains !== undefined) {
    if (!failure.feature) {
      wrong.push('it named no construct, and an unsupported refusal has to name one or an application cannot say what it hit');
    } else if (!failure.feature.includes(step.feature_contains)) {
      wrong.push(`it named ${JSON.stringify(failure.feature)} and should have named something holding ${JSON.stringify(step.feature_contains)}`);
    }
  }
  if (failure.status === Status.Unsupported) {
    if (!(failure instanceof UnsupportedError)) {
      wrong.push('an unsupported refusal did not arrive as UnsupportedError, which is the whole of this design arriving in JavaScript');
    }
    if (!failure.feature) wrong.push('an unsupported refusal must carry a feature');
  }
}

/**
 * Runs one case and returns one line per disagreement.
 * @param theCase - one entry from the suite's cases
 */
function runCase(theCase) {
  // A folder per case rather than a file, because the engine writes its log
  // beside the database as `.rdb-wal.NNNN` files, and deleting only the .rdb
  // would leave them behind in the temporary directory.
  const folder = mkdtempSync(join(tmpdir(), 'inillucent-conformance-ts-'));
  const path = join(folder, `${theCase.name}.rdb`);
  const wrong = [];
  const database = new Database(path);
  const connection = database.connect();
  try {
    for (const statement of theCase.setup ?? []) {
      try {
        connection.execute(statement);
      } catch (why) {
        wrong.push(`the setup statement \`${statement}\` was refused: ${why.message}`);
      }
    }
    if (wrong.length === 0) {
      for (const step of theCase.steps ?? []) {
        const said = [];
        const params = (step.params ?? []).map(valueOf);
        try {
          checkSuccess(step, connection.execute(step.sql, params, step.limit), said);
        } catch (failure) {
          if (!(failure instanceof InillucentError)) throw failure;
          checkFailure(step, failure, said);
        }
        for (const problem of said) wrong.push(`\`${step.sql}\`: ${problem}`);
      }
    }
  } finally {
    connection.close();
    database.close();
    rmSync(folder, { recursive: true, force: true });
  }
  return wrong;
}

const suite = readSuite(SUITE);
let ran = 0;

for (const theCase of suite.cases) {
  const missing = missingFor(theCase);
  if (missing.length > 0) {
    test(`conformance: ${theCase.name}`, { skip: `skipping: this runner lacks ${missing.join(', ')}` }, () => {});
    continue;
  }
  ran += 1;
  test(`conformance: ${theCase.name}`, () => {
    const wrong = runCase(theCase);
    assert.deepEqual(wrong, [], `${theCase.name} disagreed:\n  ${wrong.join('\n  ')}`);
  });
}

console.log(`typescript conformance: ${ran} of ${suite.cases.length} cases, from ${SUITE}`);
test(`conformance ran ${ran} of ${suite.cases.length} cases`, () => {
  assert.equal(ran, suite.cases.length, 'this runner has every capability the suite names, so it runs every case');
});

test('the capability table can be read', () => {
  // Reading it here also proves the C strings it hands back survive being copied
  // out, which is the rule a binding is most likely to get wrong.
  const rows = capabilities();
  assert.ok(rows.length > 0, 'the engine declares no capabilities at all');
  assert.ok(
    rows.every((row) => typeof row.name === 'string' && row.name.length > 0),
    'every capability must have a name',
  );
  assert.equal(
    supports('cancel'),
    Support.Partial,
    'cancel is partial: a running statement stops at the next point the executor checks, not instantly',
  );
  assert.equal(
    supports('time_travel'),
    Support.Unknown,
    'a capability nobody declared must answer Unknown rather than No: they mean different things, and one of them is a checked absence',
  );
});

/**
 * Opens the database at a path with an optional key, reads one value and closes it.
 * @param path - the database file
 * @param options - open options, usually holding the key
 * @param sql - a statement to run and return the rows of
 */
function readWith(path, options, sql) {
  const database = new Database(path, options);
  try {
    const connection = database.connect();
    try {
      return connection.query(sql);
    } finally {
      connection.close();
    }
  } finally {
    database.close();
  }
}

test('an encrypted database keeps its text out of the file and needs its key to open', () => {
  const folder = mkdtempSync(join(tmpdir(), 'inillucent-encrypted-ts-'));
  const path = join(folder, 'vault.rdb');
  const key = "x'" + '5a'.repeat(32) + "'";
  const secret = 'the vault code is 7461';
  try {
    const database = new Database(path, { key });
    const connection = database.connect();
    connection.execute('CREATE TABLE vault (id INTEGER PRIMARY KEY, note TEXT)');
    connection.execute('INSERT INTO vault (note) VALUES (?1)', [secret]);
    connection.close();
    database.close();

    for (const name of readdirSync(folder)) {
      assert.ok(!readFileSync(join(folder, name)).includes(secret), `${name} holds the plaintext`);
    }
    assert.deepEqual(readWith(path, { key }, 'SELECT note FROM vault').map((row) => row.note), [secret]);
    const pragma = readWith(path, { key }, 'PRAGMA encryption');
    assert.equal(Object.values(pragma[0])[0], 'xchacha20-poly1305');

    const wrongKey = "x'" + '3c'.repeat(32) + "'";
    for (const options of [{}, { key: wrongKey }]) {
      assert.throws(
        () => new Database(path, options),
        (why) => why instanceof InillucentError && why.status === Status.Corrupt,
      );
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
