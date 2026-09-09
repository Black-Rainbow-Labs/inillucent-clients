// Runs conformance/suite.json through the package's CommonJS entry point.
//
// This is not a second copy of the TypeScript client. It is the same package,
// reached the other way, and it exists because the CommonJS bundle is a separate
// build artifact: `import.meta.url` has no meaning there, so the code that finds
// the shared library is the one thing most likely to work in ES modules and fail
// under require(). A test that only ever imports would not notice.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, rmSync } = require('node:fs');
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
} = require('inillucent');

const SUITE = resolve(__dirname, '..', '..', 'conformance', 'suite.json');

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
  if (typeof want === 'bigint' || typeof got === 'bigint') return BigInt(want) === BigInt(got);
  return want === got;
}

/**
 * Runs one case and returns one line per disagreement.
 * @param theCase - one entry from the suite's cases
 */
function runCase(theCase) {
  const path = join(
    tmpdir(),
    `inillucent-cjs-${theCase.name}-${process.pid}-${Math.random().toString(36).slice(2)}.rdb`,
  );
  const wrong = [];
  const database = new Database(path);
  const connection = database.connect();
  try {
    for (const statement of theCase.setup ?? []) connection.execute(statement);
    for (const step of theCase.steps ?? []) {
      const params = (step.params ?? []).map(valueOf);
      try {
        const rows = connection.execute(step.sql, params, step.limit);
        if (step.status !== undefined) {
          wrong.push(`\`${step.sql}\`: expected \`${step.status}\` and it succeeded`);
          continue;
        }
        if (step.rows) {
          step.rows.forEach((row, nth) => {
            row.forEach((cell, column) => {
              if (!same(valueOf(cell), rows.rows[nth]?.[column])) {
                wrong.push(`\`${step.sql}\`: row ${nth} column ${column} disagrees`);
              }
            });
          });
        }
        if ('total' in step && rows.total !== step.total) {
          wrong.push(`\`${step.sql}\`: total is ${rows.total} and should be ${step.total}`);
        }
        if ('affected' in step && rows.affected !== step.affected) {
          wrong.push(`\`${step.sql}\`: affected is ${rows.affected} and should be ${step.affected}`);
        }
      } catch (failure) {
        if (!(failure instanceof InillucentError)) throw failure;
        if (step.status === undefined) {
          wrong.push(`\`${step.sql}\`: expected it to succeed and it failed: ${failure.message}`);
        } else if (failure.statusName !== step.status) {
          wrong.push(
            `\`${step.sql}\`: failed with \`${failure.statusName}\` and should have failed with \`${step.status}\``,
          );
        } else if (failure.status === Status.Unsupported && !(failure instanceof UnsupportedError)) {
          wrong.push(`\`${step.sql}\`: an unsupported refusal was not an UnsupportedError`);
        }
      }
    }
  } finally {
    connection.close();
    database.close();
    rmSync(path, { force: true });
  }
  return wrong;
}

const suite = JSON.parse(readFileSync(SUITE, 'utf8'));

test('the package loads through require() and finds its driver', () => {
  assert.match(version(), /inillucent-driver/);
  assert.ok(driverPath().length > 0, 'the CommonJS build must resolve the shared library too');
});

for (const theCase of suite.cases) {
  test(`commonjs conformance: ${theCase.name}`, () => {
    const wrong = runCase(theCase);
    assert.deepEqual(wrong, [], `${theCase.name} disagreed:\n  ${wrong.join('\n  ')}`);
  });
}

test('the capability table reads through require() as well', () => {
  assert.ok(capabilities().length > 0);
  assert.equal(supports('cancel'), Support.No);
  assert.equal(supports('time_travel'), Support.Unknown);
});
