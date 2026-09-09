<?php

declare(strict_types=1);

namespace Inillucent;

/**
 * A run of bytes the engine stores as a blob.
 *
 * PHP has one string type for text and for bytes, so a client that returned both
 * as a plain string would throw away which one the engine holds. That matters
 * here for the same reason NULL is not the empty string: they are different
 * facts about a row.
 *
 * Bind a Blob to store bytes; bind a plain string to store text.
 */
final class Blob
{
    /**
     * @param string $bytes the raw bytes, which may contain a NUL
     */
    public function __construct(public readonly string $bytes)
    {
    }

    /** Returns how many bytes this holds. */
    public function length(): int
    {
        return strlen($this->bytes);
    }

    /** Returns the bytes, for a caller that wants the plain string. */
    public function __toString(): string
    {
        return $this->bytes;
    }
}
