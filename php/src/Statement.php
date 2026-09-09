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
        $ffi->inillucent_clear_bindings($this->handle);
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
            $ffi->inillucent_stmt_execute($this->handle, Connection::capped($limit), $out, $error),
            $error
        );
        unset($held);
        return Rows::take($out[0]);
    }

    /**
     * Binds one value, choosing the call by the PHP type.
     *
     * Returns whatever buffer the bind points at, so the caller can hold it
     * until the statement has run.
     *
     * @param int $index the one based parameter position
     * @param mixed $value what to bind
     */
    public function bind(int $index, mixed $value): mixed
    {
        $ffi = Driver::ffi();
        if ($value === null) {
            $ffi->inillucent_bind_null($this->handle, $index);
            return null;
        }
        if (is_bool($value)) {
            $ffi->inillucent_bind_int($this->handle, $index, $value ? 1 : 0);
            return null;
        }
        if (is_int($value)) {
            $ffi->inillucent_bind_int($this->handle, $index, $value);
            return null;
        }
        if (is_float($value)) {
            $ffi->inillucent_bind_real($this->handle, $index, $value);
            return null;
        }
        if ($value instanceof Blob) {
            $buffer = Driver::buffer($value->bytes);
            $ffi->inillucent_bind_blob(
                $this->handle,
                $index,
                FFI::cast('unsigned char*', FFI::addr($buffer[0])),
                $value->length()
            );
            return $buffer;
        }
        if (is_string($value)) {
            $buffer = Driver::buffer($value);
            // The address of the first element, not a cast of the array itself:
            // casting a char[3] to a pointer is casting three bytes to eight, and
            // FFI refuses it. A short bound string is exactly where that happens.
            $ffi->inillucent_bind_text(
                $this->handle,
                $index,
                FFI::addr($buffer[0]),
                strlen($value)
            );
            return $buffer;
        }
        throw new InvalidArgumentException(sprintf(
            'cannot bind a %s. The engine stores NULL, integers, reals, text and bytes, and'
            . ' converting anything else would be this library deciding what your value means.',
            get_debug_type($value)
        ));
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
}
