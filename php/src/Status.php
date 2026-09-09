<?php

declare(strict_types=1);

namespace Inillucent;

/**
 * What a call returned.
 *
 * Unsupported is a status of its own. The engine refuses what it has not built
 * rather than answering it wrongly, so an application can say "this engine
 * cannot do that yet" instead of "check your spelling".
 */
enum Status: int
{
    case Ok = 0;
    case Unsupported = 1;
    case Syntax = 2;
    case NotFound = 3;
    case Constraint = 4;
    case ReadOnly = 5;
    case Busy = 6;
    case Interrupted = 7;
    case Corrupt = 8;
    case Io = 9;
    case Full = 10;
    case TooBig = 11;
    case InvalidState = 12;
    case Internal = 13;
    /** A code this version has never heard of, kept rather than folded into Internal. */
    case Unknown = -1;

    /**
     * Returns the status a C status code names.
     *
     * @param int $code the integer the C ABI returned
     */
    public static function fromCode(int $code): self
    {
        return self::tryFrom($code) ?? self::Unknown;
    }

    /** Returns the name the conformance suite uses for this status. */
    public function label(): string
    {
        return match ($this) {
            self::Ok => 'ok',
            self::Unsupported => 'unsupported',
            self::Syntax => 'syntax',
            self::NotFound => 'not_found',
            self::Constraint => 'constraint',
            self::ReadOnly => 'readonly',
            self::Busy => 'busy',
            self::Interrupted => 'interrupted',
            self::Corrupt => 'corrupt',
            self::Io => 'io',
            self::Full => 'full',
            self::TooBig => 'too_big',
            self::InvalidState => 'invalid_state',
            self::Internal => 'internal',
            self::Unknown => 'unknown',
        };
    }
}
