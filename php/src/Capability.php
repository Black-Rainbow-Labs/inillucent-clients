<?php

declare(strict_types=1);

namespace Inillucent;

/** One row of the engine's capability table. */
final class Capability
{
    /**
     * @param string $name what the capability is called
     * @param Support $support whether the engine does it
     * @param string $note what it does and does not do here; partial says the limit
     */
    public function __construct(
        public readonly string $name,
        public readonly Support $support,
        public readonly string $note,
    ) {
    }

    /** Returns whether the engine will do this at all. */
    public function isSupported(): bool
    {
        return $this->support->isSupported();
    }
}
