<?php

declare(strict_types=1);

namespace Inillucent;

use FFI;
use InvalidArgumentException;

/** A compiled statement and the values bound to it. */
final class Statement
{
    private mixed $handle;

    /**
     * @param Connection $connection the connection this statement was compiled on
     * @param mixed $handle the C statement handle
     */
    public function __construct(private readonly Connection $connection, mixed $handle)
    {
        $this->handle = $handle;
    }

    /**
     * Binds these values, runs the statement, and returns what it produced.
     *
     * @param array<int, mixed> $params values for ?1, ?2 and so on, in order
     * @param int|null $limit rows to hand back, or null for every row
     */
    public function execute(array $params = [], ?int $limit = null): Rows
    {
        $ffi = Driver::ffi();
        $ffi->inillucent_clear_bindings($this->live());
        // The buffers are held until the call returns. Every one is copied by
        // the bind, but PHP would otherwise free them at the end of the loop.
        $held = [];
        $index = 1;
        foreach ($params as $value) {
            $held[] = $this->bind($index, $value);
            $index++;
        }
        $out = $ffi->new('inillucent_rows*[1]');
        $error = $ffi->new('inillucent_error*[1]');
        InillucentException::check(
            $ffi->inillucent_stmt_execute($this->live(), Connection::capped($limit), $out, $error),
            $error
        );
        unset($held);
        return Rows::take($out[0]);
    }

    /**
     * Binds one value, choosing the call by the PHP type, and throws when the
     * engine refuses it, such as a position of 0 or one past the statement's
     * last parameter.
     *
     * Returns whatever buffer the bind points at, so the caller can hold it
     * until the statement has run.
     *
     * @param int $index the one based parameter position
     * @param mixed $value what to bind
     */
    public function bind(int $index, mixed $value): mixed
    {
        $handle = $this->live();
        $ffi = Driver::ffi();
        $buffer = null;
        $status = match (true) {
            $value === null => $ffi->inillucent_bind_null($handle, $index),
            is_bool($value) => $ffi->inillucent_bind_int($handle, $index, $value ? 1 : 0),
            is_int($value) => $ffi->inillucent_bind_int($handle, $index, $value),
            is_float($value) => $ffi->inillucent_bind_real($handle, $index, $value),
            $value instanceof Blob => self::bindBlob($handle, $index, $value, $buffer),
            is_string($value) => self::bindText($handle, $index, $value, $buffer),
            default => throw new InvalidArgumentException(sprintf(
                'cannot bind a %s. The engine stores NULL, integers, reals, text and bytes, and'
                . ' converting anything else would be this library deciding what your value means.',
                get_debug_type($value)
            )),
        };
        // The bind calls return a status and no error handle. It used to be
        // ignored, so a refused bind left the parameter NULL and the statement ran.
        InillucentException::check($status, null);
        return $buffer;
    }

    /**
     * Binds bytes as a blob and returns the call's status.
     *
     * @param mixed $handle the C statement handle
     * @param int $index the one based parameter position
     * @param Blob $value the bytes to bind
     * @param mixed $buffer receives the memory the bind reads, for the caller to hold
     */
    private static function bindBlob(mixed $handle, int $index, Blob $value, mixed &$buffer): int
    {
        $buffer = Driver::buffer($value->bytes);
        return Driver::ffi()->inillucent_bind_blob(
            $handle,
            $index,
            FFI::cast('unsigned char*', FFI::addr($buffer[0])),
            $value->length()
        );
    }

    /**
     * Binds a string as text and returns the call's status.
     *
     * The address of the first element is passed, not a cast of the array
     * itself: casting a char[3] to a pointer is casting three bytes to eight, and
     * FFI refuses it. A short bound string is exactly where that happens.
     *
     * @param mixed $handle the C statement handle
     * @param int $index the one based parameter position
     * @param string $value the text to bind
     * @param mixed $buffer receives the memory the bind reads, for the caller to hold
     */
    private static function bindText(mixed $handle, int $index, string $value, mixed &$buffer): int
    {
        $buffer = Driver::buffer($value);
        return Driver::ffi()->inillucent_bind_text($handle, $index, FFI::addr($buffer[0]), strlen($value));
    }

    /** Returns the connection this statement was compiled on. */
    public function connection(): Connection
    {
        return $this->connection;
    }

    /** Frees the statement. Closing twice is safe. */
    public function close(): void
    {
        if ($this->handle === null) {
            return;
        }
        Driver::ffi()->inillucent_stmt_free($this->handle);
        $this->handle = null;
    }

    /**
     * Frees the statement when the last reference to it goes.
     *
     * A statement nobody closed keeps its connection alive, and the database
     * then refuses to close, so a statement that is dropped is freed here
     * rather than held until the process ends.
     */
    public function __destruct()
    {
        $this->close();
    }

    /**
     * Returns the C handle, or throws Status::InvalidState once the statement is
     * closed, so a call after close() is an error and never a null pointer
     * handed to the engine.
     */
    private function live(): mixed
    {
        if ($this->handle === null) {
            throw InillucentException::closed('statement');
        }
        return $this->handle;
    }
}
