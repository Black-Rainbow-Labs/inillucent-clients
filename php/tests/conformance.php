<?php

declare(strict_types=1);

// Runs conformance/suite.json against this client.
//
// The suite is the driver's behaviour written as data rather than as prose, and
// every client library in this repository runs the same file. When two of them
// disagree, one of them is wrong; when they agree, the specification is one that
// can actually be followed.
//
// Run it with `php tests/conformance.php`. It exits 0 when every case passed and
// 1 otherwise, so it can be a step in something larger. Set INILLUCENT_SUITE to
// the path of another copy of the suite to run that one instead.

require __DIR__ . '/../autoload.php';

use Inillucent\Blob;
use Inillucent\Connection;
use Inillucent\Database;
use Inillucent\Driver;
use Inillucent\InillucentException;
use Inillucent\Status;
use Inillucent\Support;
use Inillucent\UnsupportedFeatureException;

/**
 * Reads a value out of the suite's one key object form.
 *
 * One key rather than a bare literal, so that NULL and the empty string can
 * never be confused by the file itself.
 *
 * @param array<string, mixed> $described a value object such as {"int": 7}
 */
function value_of(array $described): mixed
{
    if (array_key_exists('null', $described)) {
        return null;
    }
    if (array_key_exists('int', $described)) {
        // The suite is decoded with JSON_BIGINT_AS_STRING, so an integer that
        // fits in 64 bits arrives as an exact int and one that does not arrives
        // as a string. Casting either through a float would lose the low digits,
        // which is the loss integers_at_the_edges_of_i64 exists to catch.
        if (!is_int($described['int'])) {
            throw new InvalidArgumentException(json_encode($described) . ' is not a 64 bit integer');
        }
        return $described['int'];
    }
    if (array_key_exists('real', $described)) {
        return (float) $described['real'];
    }
    if (array_key_exists('text', $described)) {
        return (string) $described['text'];
    }
    if (array_key_exists('blob', $described)) {
        $bytes = '';
        foreach ($described['blob'] as $byte) {
            $bytes .= chr((int) $byte);
        }
        return new Blob($bytes);
    }
    throw new InvalidArgumentException(json_encode($described) . ' names no value kind');
}

/**
 * Compares an expected value to what came back.
 *
 * The kinds have to match as well as the contents: an integer and a real are
 * different values, and a comparison that let 1 equal 1.0 would hide a client
 * that lost the distinction. Text and bytes are different too, which is why a
 * blob arrives as a Blob rather than as a plain string.
 */
function same(mixed $want, mixed $got): bool
{
    if ($want === null || $got === null) {
        return $want === null && $got === null;
    }
    if ($want instanceof Blob || $got instanceof Blob) {
        return $want instanceof Blob && $got instanceof Blob && $want->bytes === $got->bytes;
    }
    return $want === $got;
}

/** Renders a value for a failure message. */
function shown(mixed $value): string
{
    if ($value === null) {
        return 'NULL';
    }
    if ($value instanceof Blob) {
        return $value->length() . ' bytes [' . implode(',', array_map('ord', str_split($value->bytes ?: ''))) . ']';
    }
    return get_debug_type($value) . '(' . var_export($value, true) . ')';
}

/**
 * Checks the rows a successful step handed back.
 *
 * @param array<string, mixed> $step the case step
 * @param string[] $wrong collects one line per disagreement
 */
function check_rows(array $step, \Inillucent\Rows $rows, array &$wrong): void
{
    $want = $step['rows'];
    if (count($want) !== count($rows->rows)) {
        $wrong[] = 'there are ' . count($rows->rows) . ' rows and there should be ' . count($want);
        return;
    }
    foreach ($want as $nth => $row) {
        $got = $rows->rows[$nth];
        if (count($row) !== count($got)) {
            $wrong[] = "row $nth has " . count($got) . ' cells and should have ' . count($row);
            continue;
        }
        foreach ($row as $column => $cell) {
            $expected = value_of($cell);
            if (!same($expected, $got[$column])) {
                $wrong[] = "row $nth column $column is " . shown($got[$column])
                    . ' and should be ' . shown($expected);
            }
        }
    }
}

/**
 * Checks a step that was expected to succeed.
 *
 * @param array<string, mixed> $step the case step, which asserts only the keys it carries
 * @param string[] $wrong collects one line per disagreement
 */
function check_success(array $step, \Inillucent\Rows $rows, array &$wrong): void
{
    if (array_key_exists('status', $step)) {
        $wrong[] = "expected it to fail with `{$step['status']}` and it succeeded";
        return;
    }
    if (array_key_exists('columns', $step) && $step['columns'] !== $rows->columns) {
        $wrong[] = 'columns are [' . implode(', ', $rows->columns)
            . '] and should be [' . implode(', ', $step['columns']) . ']';
    }
    if (array_key_exists('rows', $step)) {
        check_rows($step, $rows, $wrong);
    }
    if (array_key_exists('affected', $step)) {
        $want = $step['affected'] === null ? null : (int) $step['affected'];
        if ($rows->affected !== $want) {
            $wrong[] = 'affected is ' . var_export($rows->affected, true)
                . ' and should be ' . var_export($want, true);
        }
    }
    if (array_key_exists('total', $step) && $rows->total !== (int) $step['total']) {
        $wrong[] = "total is {$rows->total} and should be {$step['total']}, and total is exact,"
            . ' so this is a real disagreement rather than an estimate being off';
    }
    if (array_key_exists('more', $step) && $rows->more !== (bool) $step['more']) {
        $wrong[] = 'more is ' . var_export($rows->more, true)
            . ' and should be ' . var_export($step['more'], true);
    }
}

/**
 * Checks a step that was expected to fail.
 *
 * @param array<string, mixed> $step the case step
 * @param string[] $wrong collects one line per disagreement
 */
function check_failure(array $step, InillucentException $failure, array &$wrong): void
{
    if (!array_key_exists('status', $step)) {
        $wrong[] = 'it was expected to succeed and it failed: ' . $failure->getMessage();
        return;
    }
    if ($failure->status->label() !== $step['status']) {
        $wrong[] = 'it failed with `' . $failure->status->label() . '` and should have failed'
            . " with `{$step['status']}`, saying: " . $failure->getMessage();
    }
    if (array_key_exists('message_contains', $step)
        && !str_contains($failure->plainMessage, $step['message_contains'])) {
        $wrong[] = 'the message is "' . $failure->plainMessage . '" and should hold "'
            . $step['message_contains'] . '"';
    }
    if (array_key_exists('feature_contains', $step)) {
        if ($failure->feature === null) {
            $wrong[] = 'it named no construct, and an unsupported refusal has to name one or an'
                . ' application cannot say what it hit';
        } elseif (!str_contains($failure->feature, $step['feature_contains'])) {
            $wrong[] = 'it named "' . $failure->feature . '" and should have named something'
                . ' holding "' . $step['feature_contains'] . '"';
        }
    }
    if ($failure->status === Status::Unsupported) {
        if (!$failure instanceof UnsupportedFeatureException) {
            $wrong[] = 'an unsupported refusal did not arrive as UnsupportedFeatureException,'
                . ' which is the whole of this design arriving in PHP';
        }
        if ($failure->feature === null) {
            $wrong[] = 'an unsupported refusal must carry a feature';
        }
    }
}

/**
 * Runs one step and returns one line per disagreement, each naming the SQL.
 *
 * @param array<string, mixed> $step the step to run
 * @return string[]
 */
function run_step(Connection $connection, array $step): array
{
    $params = array_map('value_of', $step['params'] ?? []);
    $limit = isset($step['limit']) ? (int) $step['limit'] : null;
    $said = [];
    try {
        check_success($step, $connection->execute($step['sql'], $params, $limit), $said);
    } catch (InillucentException $failure) {
        check_failure($step, $failure, $said);
    }
    return array_map(static fn (string $problem): string => "`{$step['sql']}`: $problem", $said);
}

/**
 * Runs one case and returns one line per disagreement.
 *
 * @param array<string, mixed> $theCase one entry from the suite's cases
 * @return string[]
 */
function run_case(array $theCase): array
{
    $name = $theCase['name'] ?? 'unnamed';
    $directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR
        . 'inillucent-conformance-php-' . getmypid() . '-' . bin2hex(random_bytes(6));
    mkdir($directory, 0777, true);
    $path = $directory . DIRECTORY_SEPARATOR . 'case.rdb';
    $wrong = [];

    $database = Database::open($path);
    $connection = $database->connect();
    try {
        foreach ($theCase['setup'] ?? [] as $statement) {
            try {
                $connection->execute($statement);
            } catch (InillucentException $why) {
                $wrong[] = "the setup statement `$statement` was refused: " . $why->getMessage();
            }
        }
        if ($wrong === []) {
            foreach ($theCase['steps'] ?? [] as $step) {
                $wrong = array_merge($wrong, run_step($connection, $step));
            }
        }
    } finally {
        $connection->close();
        $database->close();
        foreach (glob($directory . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($directory);
    }
    return $wrong;
}

/**
 * Checks the capability table, which is the other half of the surface.
 *
 * Reading it here also proves the C strings it hands back survive being copied
 * out, which is the rule a binding is most likely to get wrong.
 *
 * @return string[]
 */
function check_capability_table(): array
{
    $wrong = [];
    $rows = Driver::capabilities();
    echo PHP_EOL, count($rows), ' capabilities reported', PHP_EOL;
    if ($rows === []) {
        $wrong[] = 'the engine declares no capabilities at all';
    }
    foreach ($rows as $row) {
        if ($row->name === '') {
            $wrong[] = 'a capability came back with no name';
        }
        if ($row->support === Support::No) {
            echo '  not supported: ', $row->name, PHP_EOL;
        }
    }
    if (Driver::supports('cancel') !== Support::Partial) {
        $wrong[] = 'cancel is partial: a running statement stops at the next point the executor'
            . ' checks, and it is not instant';
    }
    if (Driver::supports('time_travel') !== Support::Unknown) {
        $wrong[] = 'a capability nobody declared must answer unknown rather than no: they mean'
            . ' different things, and one of them is a checked absence';
    }
    return $wrong;
}

/**
 * Checks that a keyed database hides its text and refuses a missing or wrong key.
 *
 * Writes a secret through a raw key, reads the file bytes for it, reopens with
 * the key, and opens with no key and with another key expecting Status::Corrupt.
 *
 * @return string[]
 */
function check_encryption(): array
{
    $wrong = [];
    $directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR
        . 'inillucent-encrypted-php-' . getmypid() . '-' . bin2hex(random_bytes(6));
    mkdir($directory, 0777, true);
    $path = $directory . DIRECTORY_SEPARATOR . 'vault.rdb';
    $key = "x'" . str_repeat('5a', 32) . "'";
    $secret = 'the vault code is 7461';
    try {
        $database = Database::open($path, key: $key);
        $connection = $database->connect();
        $connection->execute('CREATE TABLE vault (id INTEGER PRIMARY KEY, note TEXT)');
        $connection->execute('INSERT INTO vault (note) VALUES (?1)', [$secret]);
        $connection->close();
        $database->close();

        foreach (glob($directory . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
            if (str_contains((string) file_get_contents($file), $secret)) {
                $wrong[] = basename($file) . ' holds the plaintext';
            }
        }
        $database = Database::open($path, key: $key);
        $connection = $database->connect();
        $notes = array_column($connection->query('SELECT note FROM vault'), 'note');
        if ($notes !== [$secret]) {
            $wrong[] = 'reopened with the key it read ' . json_encode($notes);
        }
        $answer = $connection->scalar('PRAGMA encryption');
        if ($answer !== 'xchacha20-poly1305') {
            $wrong[] = 'PRAGMA encryption answered ' . json_encode($answer);
        }
        $connection->close();
        $database->close();

        $other = "x'" . str_repeat('3c', 32) . "'";
        foreach (['no key' => null, 'a different key' => $other] as $label => $attempt) {
            try {
                Database::open($path, key: $attempt)->close();
                $wrong[] = "opening with $label succeeded";
            } catch (InillucentException $why) {
                if ($why->status !== Status::Corrupt) {
                    $wrong[] = "opening with $label failed with " . $why->status->label() . ', not corrupt';
                }
            }
        }
    } finally {
        foreach (glob($directory . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($directory);
    }
    return $wrong;
}

/**
 * The capabilities this runner has, out of the suite's `capabilities` list.
 *
 * It holds one real connection for a whole case, so a transaction, a savepoint
 * or a temporary table lasts from one step to the next.
 */
const HAS = ['session'];

/**
 * Returns the capabilities a case needs that this runner does not have. An
 * empty list means the case runs.
 *
 * @param array<string, mixed> $theCase one entry from the suite's cases
 * @return string[]
 */
function lacking(array $theCase): array
{
    return array_values(array_diff($theCase['needs'] ?? [], HAS));
}

/**
 * Returns the path of the shared conformance suite, or the file named by
 * INILLUCENT_SUITE when that is set, so a changed copy can be run without
 * touching the real one.
 */
function suite_path(): string
{
    $chosen = getenv('INILLUCENT_SUITE');
    if (is_string($chosen) && $chosen !== '') {
        return $chosen;
    }
    return dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'conformance' . DIRECTORY_SEPARATOR . 'suite.json';
}

$suitePath = suite_path();
$suite = json_decode(
    (string) file_get_contents($suitePath),
    true,
    512,
    JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING
);

echo Driver::version(), '  ABI ', Driver::abiVersion(), PHP_EOL;
echo 'driver: ', Driver::path(), PHP_EOL;
echo 'suite:  ', $suitePath, PHP_EOL, PHP_EOL;

$failures = [];
$ran = 0;
foreach ($suite['cases'] as $theCase) {
    $name = $theCase['name'] ?? '(unnamed)';
    $lacks = lacking($theCase);
    if ($lacks !== []) {
        echo '  skip  ', $name, ' (this runner lacks ', implode(', ', $lacks), ')', PHP_EOL;
        continue;
    }
    $ran++;
    $wrong = run_case($theCase);
    echo '  ', $wrong === [] ? 'ok  ' : 'FAIL', '  ', $name, PHP_EOL;
    foreach ($wrong as $problem) {
        echo '          ', $problem, PHP_EOL;
        $failures[] = "$name: $problem";
    }
}

$failures = array_merge($failures, check_capability_table());

$encryption = check_encryption();
echo '  ', $encryption === [] ? 'ok  ' : 'FAIL', '  encryption', PHP_EOL;
foreach ($encryption as $problem) {
    echo '          ', $problem, PHP_EOL;
}
$failures = array_merge($failures, $encryption);

echo PHP_EOL, $ran, ' of ', count($suite['cases']), ' cases, ', count($failures), ' failures', PHP_EOL;
exit($failures === [] ? 0 : 1);
