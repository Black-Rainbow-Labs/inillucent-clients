package com.inillucent;

/**
 * What a call returned.
 *
 * UNSUPPORTED is a status of its own. The engine refuses what it has not built
 * rather than answering it wrongly, so an application can say "this engine
 * cannot do that yet" instead of "check your spelling".
 */
public enum Status {
    OK(0, "ok"),
    UNSUPPORTED(1, "unsupported"),
    SYNTAX(2, "syntax"),
    NOT_FOUND(3, "not_found"),
    CONSTRAINT(4, "constraint"),
    READONLY(5, "readonly"),
    BUSY(6, "busy"),
    INTERRUPTED(7, "interrupted"),
    CORRUPT(8, "corrupt"),
    IO(9, "io"),
    FULL(10, "full"),
    TOO_BIG(11, "too_big"),
    INVALID_STATE(12, "invalid_state"),
    INTERNAL(13, "internal"),
    /** A code this version has never heard of, kept rather than folded into INTERNAL. */
    UNKNOWN(-1, "unknown");

    private final int code;
    private final String label;

    Status(int code, String label) {
        this.code = code;
        this.label = label;
    }

    /** The integer the C ABI uses for this status. */
    public int code() {
        return code;
    }

    /** The name the conformance suite uses for this status. */
    public String label() {
        return label;
    }

    /**
     * Returns the status a C status code names.
     *
     * @param code - the integer the C ABI returned
     */
    public static Status fromCode(int code) {
        for (Status status : values()) {
            if (status.code == code && status != UNKNOWN) {
                return status;
            }
        }
        return UNKNOWN;
    }
}
