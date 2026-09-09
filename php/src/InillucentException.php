<?php

declare(strict_types=1);

namespace Inillucent;

use FFI;
use RuntimeException;

/**
 * Something the engine refused.
 *
 * It carries the status, not only the message, because a caller that has to
 * match on prose to find out what happened will break the first time the wording
 * improves.
 */
class InillucentException extends RuntimeException
{
    /**
     * @param Status $status what kind of refusal this was
     * @param string $plainMessage what happened, without the status appended
     * @param string|null $feature the construct the engine has not implemented
     * @param string|null $detail internal diagnostic text, only with diagnostics on
     * @param int $offset the byte offset into the statement, or -1
     */
    public function __construct(
        public readonly Status $status,
        public readonly string $plainMessage,
        public readonly ?string $feature = null,
        public readonly ?string $detail = null,
        public readonly int $offset = -1,
    ) {
        $said = $plainMessage . ' [' . $status->label() . ']';
        if ($offset >= 0) {
            $said .= ' at byte ' . $offset;
        }
        parent::__construct($said, $status->value);
    }

    /** Returns whether this is the engine refusing something it has not built. */
    public function isUnsupported(): bool
    {
        return $this->status === Status::Unsupported;
    }

    /**
     * Builds the exception a C error handle describes, and frees the handle
     * either way.
     *
     * The free happens whatever the outcome because an exception built from an
     * error must not leak it.
     *
     * @param mixed $handle the C error handle, which is owned by this call
     */
    public static function from(mixed $handle): self
    {
        $ffi = Driver::ffi();
        try {
            $status = Status::fromCode($ffi->inillucent_error_status($handle));
            $message = Driver::readString($ffi->inillucent_error_message($handle)) ?? '';
            $feature = Driver::readString($ffi->inillucent_error_feature($handle));
            $detail = Driver::readString($ffi->inillucent_error_detail($handle));
            $offset = $ffi->inillucent_error_offset($handle);
        } finally {
            $ffi->inillucent_error_free($handle);
        }
        return $status === Status::Unsupported
            ? new UnsupportedFeatureException($status, $message, $feature, $detail, $offset)
            : new self($status, $message, $feature, $detail, $offset);
    }

    /**
     * Throws when a call failed, using the error it produced.
     *
     * A non zero status with no error still throws: a call that failed and said
     * nothing is not a reason to carry on.
     *
     * @param int $status what the call returned
     * @param mixed $error the error out parameter the call was given
     */
    public static function check(int $status, mixed $error): void
    {
        if ($status === 0) {
            return;
        }
        if ($error !== null && !FFI::isNull($error[0])) {
            throw self::from($error[0]);
        }
        $named = Status::fromCode($status);
        throw new self($named, 'the call failed with ' . $named->label());
    }
}
