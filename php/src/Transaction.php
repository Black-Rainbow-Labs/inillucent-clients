<?php

declare(strict_types=1);

namespace Inillucent;

/**
 * One transaction, held open while the caller decides whether to commit.
 *
 * This is a handle rather than a pair of calls because a check on what a write
 * did has to happen before the commit. A postcondition tested afterwards is a
 * report about something that has already happened.
 *
 * Letting it go out of scope without committing rolls it back.
 */
final class Transaction
{
    /** @var int[] how many rows each statement in this transaction changed, in order */
    public array $affected = [];

    private mixed $handle;

    /**
     * @param mixed $handle the C transaction handle
     */
    public function __construct(mixed $handle)
    {
        $this->handle = $handle;
    }

    /**
     * Runs one statement inside the transaction and returns the rows it changed.
     *
     * A failure rolls the whole transaction back before it throws, so a caller
     * that stops at the first error has already undone everything.
     *
     * @param string $sql the statement to run
     */
    public function execute(string $sql): int
    {
        $ffi = Driver::ffi();
        $changed = $ffi->new('unsigned long long[1]');
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check(
            $ffi->inillucent_txn_execute($this->handle, $sql, $changed, $error),
            $error
        );
        $this->affected[] = $changed[0];
        return $changed[0];
    }

    /** Commits the transaction. The handle is spent either way. */
    public function commit(): void
    {
        if ($this->handle === null) {
            return;
        }
        $ffi = Driver::ffi();
        $committing = $this->handle;
        $this->handle = null;
        $error = $ffi->new('inillucent_error*[1]');
        $status = $ffi->inillucent_txn_commit($committing, $error);
        try {
            InillucentException::check($status, $error);
        } finally {
            $ffi->inillucent_txn_rollback($committing);
        }
    }

    /** Rolls the transaction back and frees it. Rolling back twice is safe. */
    public function rollback(): void
    {
        if ($this->handle === null) {
            return;
        }
        Driver::ffi()->inillucent_txn_rollback($this->handle);
        $this->handle = null;
    }

    /** Rolls back when the transaction was never committed. */
    public function __destruct()
    {
        $this->rollback();
    }
}
