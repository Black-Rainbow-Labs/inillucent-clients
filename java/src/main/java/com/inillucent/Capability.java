package com.inillucent;

/**
 * One row of the engine's capability table.
 *
 * @param name what the capability is called
 * @param support whether the engine does it
 * @param note what the engine does and does not do here; partial says the limit
 */
public record Capability(String name, Support support, String note) {

    /** Whether the engine will do this at all. */
    public boolean isSupported() {
        return support.isSupported();
    }
}
