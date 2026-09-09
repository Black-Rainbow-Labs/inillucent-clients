<?php

declare(strict_types=1);

namespace Inillucent;

/**
 * One connection to a database, and one session.
 *
 * Temp tables, ATTACH and the connection pragmas are scoped to the session this
 * connection holds, so they last as long as it does. It keeps a reference to its
 * Database so the database is not collected first.
 */
final class Connection
{
    private mixed $handle;

    /**
     * @param Database $database the database this connection is on
     * @param mixed $handle the C connection handle
     */
    public function __construct(private readonly Database $database, mixed $handle)
    {
        $this->handle = $handle;
    }

    /**
     * Runs one statement and returns everything it produced.
     *
     * The limit caps the rows handed back, not the rows produced. Rows::$total
     * is exact either way, because the engine materialises and the count was
     * taken rather than estimated.
     *
     * @param string $sql the statement to run
     * @param array<int, mixed> $params values for ?1, ?2 and so on, in order
     * @param int|null $limit rows to hand back, or null for every row
     */
    public function execute(string $sql, array $params = [], ?int $limit = null): Rows
    {
        if ($params !== []) {
            $statement = $this->prepare($sql);
            try {
                return $statement->execute($params, $limit);
            } finally {
                $statement->close();
            }
        }
        $ffi = Driver::ffi();
        $out = $ffi->new('inillucent_rows*[1]');
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check(
            $ffi->inillucent_execute($this->handle, $sql, self::capped($limit), $out, $error),
            $error
        );
        return Rows::take($out[0]);
    }

    /**
     * Runs one statement and returns its rows as arrays keyed by column name.
     *
     * @param string $sql the statement to run
     * @param array<int, mixed> $params values for ?1, ?2 and so on, in order
     * @param int|null $limit rows to hand back, or null for every row
     * @return array<int, array<string, mixed>>
     */
    public function query(string $sql, array $params = [], ?int $limit = null): array
    {
        return $this->execute($sql, $params, $limit)->objects();
    }

    /**
     * Runs one statement and returns the first column of its first row.
     *
     * @param string $sql the statement to run
     * @param array<int, mixed> $params values for ?1, ?2 and so on, in order
     */
    public function scalar(string $sql, array $params = []): mixed
    {
        return $this->execute($sql, $params, 1)->scalar();
    }

    /**
     * Runs several statements separated by semicolons, for their effect.
     *
     * @param string $sql the statements to run
     */
    public function executeBatch(string $sql): void
    {
        $ffi = Driver::ffi();
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check(
            $ffi->inillucent_execute_batch($this->handle, $sql, $error),
            $error
        );
    }

    /**
     * Compiles a statement so it can be run more than once.
     *
     * @param string $sql the statement to compile
     */
    public function prepare(string $sql): Statement
    {
        $ffi = Driver::ffi();
        $out = $ffi->new('inillucent_stmt*[1]');
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check(
            $ffi->inillucent_prepare($this->handle, $sql, $out, $error),
            $error
        );
        return new Statement($this, $out[0]);
    }

    /** Opens a transaction. */
    public function begin(): Transaction
    {
        $ffi = Driver::ffi();
        $out = $ffi->new('inillucent_txn*[1]');
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check(
            $ffi->inillucent_txn_begin($this->handle, $out, $error),
            $error
        );
        return new Transaction($out[0]);
    }

    /** Returns the rowid the most recent insert on this connection produced. */
    public function lastInsertRowid(): int
    {
        return Driver::ffi()->inillucent_last_insert_rowid($this->handle);
    }

    /** Returns how many rows every statement on this connection has changed. */
    public function totalChanges(): int
    {
        return Driver::ffi()->inillucent_total_changes($this->handle);
    }

    /** Returns whether a transaction is open on this connection. */
    public function inTransaction(): bool
    {
        return Driver::ffi()->inillucent_in_transaction($this->handle) !== 0;
    }

    /**
     * Returns the schema's generation, which changes when the schema does.
     *
     * Compare it to know whether a cached table description is stale.
     */
    public function schemaCookie(): int
    {
        return Driver::ffi()->inillucent_schema_cookie($this->handle);
    }

    /**
     * Asks a running statement to stop.
     *
     * This always throws UnsupportedFeatureException today, and
     * Driver::supports('cancel') says so before an application draws a Stop
     * button: the engine runs a statement whole rather than a row at a time, so
     * there is no point at which it could notice.
     */
    public function cancel(): void
    {
        $ffi = Driver::ffi();
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check($ffi->inillucent_cancel($this->handle, $error), $error);
    }

    /** Returns the database this connection is on. */
    public function database(): Database
    {
        return $this->database;
    }

    /**
     * Returns the C limit for a caller's limit, where null is every row.
     *
     * @param int|null $limit rows to hand back, or null
     */
    public static function capped(?int $limit): int
    {
        return $limit === null ? Driver::NO_LIMIT : $limit;
    }

    /** Frees the connection. Closing twice is safe. */
    public function close(): void
    {
        if ($this->handle === null) {
            return;
        }
        Driver::ffi()->inillucent_conn_free($this->handle);
        $this->handle = null;
    }
}
