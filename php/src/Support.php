<?php

declare(strict_types=1);

namespace Inillucent;

/** Whether the engine does something. */
enum Support: int
{
    case No = 0;
    case Yes = 1;
    /**
     * Yes, with the limit the note names. A caller that treats this as Yes
     * without reading the note will be surprised.
     */
    case Partial = -1;
    /**
     * No such capability in this build. Treat it as no rather than as yes: one
     * that was never declared was certainly never checked.
     */
    case Unknown = -2;

    /**
     * Returns the state a C value names.
     *
     * @param int $code the integer the C ABI returned
     */
    public static function fromCode(int $code): self
    {
        return self::tryFrom($code) ?? self::Unknown;
    }

    /** Returns the state as a word. */
    public function label(): string
    {
        return match ($this) {
            self::No => 'no',
            self::Yes => 'yes',
            self::Partial => 'partial',
            self::Unknown => 'unknown',
        };
    }

    /**
     * Returns whether the engine will do this at all.
     *
     * Partial counts, and the note says how far.
     */
    public function isSupported(): bool
    {
        return $this === self::Yes || $this === self::Partial;
    }
}
