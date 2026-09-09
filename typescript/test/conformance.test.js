// Runs conformance/suite.json against this client.
//
// The suite is the driver's behaviour written as data rather than as prose, and
// every client library in this repository runs the same file. When two of them
// disagree, one of them is wrong; when they agree, the specification is one that
// can actually be followed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Database, InillucentError, UnsupportedError, Status, Support, capabilities, supports } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SUITE = resolve(here, '..', '..', 'conformance', 'suite.json');

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

/** Renders a value for a failure message. */
function shown(value) {
  if (value === null) return 'NULL';
  if (Buffer.isBuffer(value)) return `${value.length} bytes [${[...value]}]`;
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
  const path = join(tmpdir(), `inillucent-conformance-ts-${theCase.name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.rdb`);
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
    rmSync(path, { force: true });
  }
  return wrong;
}

const suite = JSON.parse(readFileSync(SUITE, 'utf8'));

for (const theCase of suite.cases) {
  test(`conformance: ${theCase.name}`, () => {
    const wrong = runCase(theCase);
    assert.deepEqual(wrong, [], `${theCase.name} disagreed:\n  ${wrong.join('\n  ')}`);
  });
}

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
    Support.No,
    'cancel is declared unsupported, and a client that reported otherwise would have an application drawing a Stop button that cannot work',
  );
  assert.equal(
    supports('time_travel'),
    Support.Unknown,
    'a capability nobody declared must answer Unknown rather than No: they mean different things, and one of them is a checked absence',
  );
});
