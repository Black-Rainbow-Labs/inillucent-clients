// Runs conformance/suite.json through the package's CommonJS entry point.
//
// This is not a second copy of the TypeScript client. It is the same package,
// reached the other way, and it exists because the CommonJS bundle is a separate
// build artifact: `import.meta.url` has no meaning there, so the code that finds
// the shared library is the one thing most likely to work in ES modules and fail
// under require(). A test that only ever imports would not notice.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const {
  Database,
  InillucentError,
  UnsupportedError,
  Status,
  Support,
  capabilities,
  supports,
  version,
  driverPath,
} = require('inillucent-client');

// INILLUCENT_SUITE names a different suite file, so a copy with one expected
// value changed can prove the runner notices without touching the real suite.
const SUITE = process.env.INILLUCENT_SUITE ?? resolve(__dirname, '..', '..', 'conformance', 'suite.json');

// What this runner can do, out of the suite's `capabilities`. It holds one
// connection across a case, and that connection is one session, so a case that
// asks for `"connection": "per_call"` is already satisfied.
const CAPABILITIES = new Set(['session']);

/**
 * Keeps every integer in the suite exact.
 *
 * JSON.parse reads a number through a double, so 9223372036854775807 would
 * arrive as 9223372036854775808. The reviver reads the number's source text, and
 * an integer outside the range a double holds exactly becomes a bigint, which is
 * what the client returns for it.
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
 * Reads a value out of the suite's one key object form.
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
 * @param want - what the suite says
 * @param got - what the client returned
 */
function same(want, got) {
  if (want === null || got === null) return want === null && got === null;
  if (Buffer.isBuffer(want) || Buffer.isBuffer(got)) {
    return Buffer.isBuffer(want) && Buffer.isBuffer(got) && want.equals(got);
  }
  if (want === undefined || got === undefined) return false;
  if (typeof want === 'bigint' || typeof got === 'bigint') return BigInt(want) === BigInt(got);
  return want === got;
}

/**
 * Renders a value for a failure message.
 * @param value - an expected or returned value
 */
function shown(value) {
  if (value === null) return 'NULL';
  if (Buffer.isBuffer(value)) return `${value.length} bytes`;
  if (typeof value === 'bigint') return `${value}n`;
  return JSON.stringify(value);
}

/**
 * Checks what a successful step handed back against every key the step carries.
 * @param step - the case step
 * @param rows - what the client returned
 * @param wrong - collects one line per disagreement
 */
function checkSuccess(step, rows, wrong) {
  if (step.status !== undefined) wrong.push(`expected \`${step.status}\` and it succeeded`);
  if (step.columns && JSON.stringify(step.columns) !== JSON.stringify(rows.columns)) {
    wrong.push(`columns are ${JSON.stringify(rows.columns)} and should be ${JSON.stringify(step.columns)}`);
  }
  if (step.rows && step.rows.length !== rows.rows.length) {
    wrong.push(`there are ${rows.rows.length} rows and there should be ${step.rows.length}`);
  }
  (step.rows ?? []).forEach((row, nth) => {
    row.forEach((cell, column) => {
      const want = valueOf(cell);
      const got = rows.rows[nth]?.[column];
      if (!same(want, got)) wrong.push(`row ${nth} column ${column} is ${shown(got)} and should be ${shown(want)}`);
    });
  });
  for (const key of ['total', 'affected', 'more']) {
    if (key in step && rows[key] !== step[key]) wrong.push(`${key} is ${rows[key]} and should be ${step[key]}`);
  }
}

/**
 * Checks a failure against the status and text a step expects.
 * @param step - the case step
 * @param failure - the error the client threw
 * @param wrong - collects one line per disagreement
 */
function checkFailure(step, failure, wrong) {
  if (step.status === undefined) {
    wrong.push(`expected it to succeed and it failed: ${failure.message}`);
  } else if (failure.statusName !== step.status) {
    wrong.push(`failed with \`${failure.statusName}\` and should have failed with \`${step.status}\``);
  } else if (failure.status === Status.Unsupported && !(failure instanceof UnsupportedError)) {
    wrong.push('an unsupported refusal was not an UnsupportedError');
  }
  if (step.message_contains && !failure.message.includes(step.message_contains)) {
    wrong.push(`the message ${JSON.stringify(failure.message)} does not hold ${JSON.stringify(step.message_contains)}`);
  }
  if (step.feature_contains !== undefined && !(failure.feature ?? '').includes(step.feature_contains)) {
    wrong.push(`the feature ${JSON.stringify(failure.feature)} does not hold ${JSON.stringify(step.feature_contains)}`);
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
  const folder = mkdtempSync(join(tmpdir(), 'inillucent-cjs-'));
  const path = join(folder, `${theCase.name}.rdb`);
  const wrong = [];
  const database = new Database(path);
  const connection = database.connect();
  try {
    for (const statement of theCase.setup ?? []) connection.execute(statement);
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
  } finally {
    connection.close();
    database.close();
    rmSync(folder, { recursive: true, force: true });
  }
  return wrong;
}

const suite = readSuite(SUITE);
let ran = 0;

test('the package loads through require() and finds its driver', () => {
  assert.match(version(), /inillucent-driver/);
  assert.ok(driverPath().length > 0, 'the CommonJS build must resolve the shared library too');
});

for (const theCase of suite.cases) {
  const missing = (theCase.needs ?? []).filter((need) => !CAPABILITIES.has(need));
  if (missing.length > 0) {
    test(`commonjs conformance: ${theCase.name}`, { skip: `skipping: this runner lacks ${missing.join(', ')}` }, () => {});
    continue;
  }
  ran += 1;
  test(`commonjs conformance: ${theCase.name}`, () => {
    const wrong = runCase(theCase);
    assert.deepEqual(wrong, [], `${theCase.name} disagreed:\n  ${wrong.join('\n  ')}`);
  });
}

console.log(`javascript commonjs conformance: ${ran} of ${suite.cases.length} cases, from ${SUITE}`);
test(`commonjs conformance ran ${ran} of ${suite.cases.length} cases`, () => {
  assert.equal(ran, suite.cases.length, 'this runner has every capability the suite names, so it runs every case');
});

test('the capability table reads through require() as well', () => {
  assert.ok(capabilities().length > 0);
  assert.equal(supports('cancel'), Support.Partial, 'cancel is partial: a running statement stops at the next point the executor checks');
  assert.equal(supports('time_travel'), Support.Unknown);
});
