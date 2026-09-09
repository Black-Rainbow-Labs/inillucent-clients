package com.inillucent;

/** Whether the engine does something. */
public enum Support {
    NO(0, "no"),
    YES(1, "yes"),
    /**
     * Yes, with the limit the note names. A caller that treats this as YES
     * without reading the note will be surprised.
     */
    PARTIAL(-1, "partial"),
    /**
     * No such capability in this build. Treat it as no rather than as yes: one
     * that was never declared was certainly never checked.
     */
    UNKNOWN(-2, "unknown");

    private final int code;
    private final String label;

    Support(int code, String label) {
        this.code = code;
        this.label = label;
    }

    /** The integer the C ABI uses for this state. */
    public int code() {
        return code;
    }

    /** The state as a word. */
    public String label() {
        return label;
    }

    /**
     * Whether the engine will do this at all. Partial counts, and the note says
     * how far.
     */
    public boolean isSupported() {
        return this == YES || this == PARTIAL;
    }

    /**
     * Returns the state a C value names.
     *
     * @param code - the integer the C ABI returned
     */
    public static Support fromCode(int code) {
        for (Support support : values()) {
            if (support.code == code) {
                return support;
            }
        }
        return UNKNOWN;
    }
}
