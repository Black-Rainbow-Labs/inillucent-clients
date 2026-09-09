package com.inillucent;

import java.lang.foreign.MemorySegment;

/**
 * Something the engine refused.
 *
 * It carries the status, not only the message, because a caller that has to
 * match on prose to find out what happened will break the first time the wording
 * improves.
 *
 * It is unchecked on purpose. A refusal is not something a caller can usefully
 * be forced to handle at every statement, and the ones worth catching are caught
 * by type: {@link UnsupportedFeatureException} for what the engine has not built.
 */
public class InillucentException extends RuntimeException {

    private final Status status;
    private final String plainMessage;
    private final String feature;
    private final String detail;
    private final int offset;

    InillucentException(Status status, String message, String feature, String detail, int offset) {
        super(offset >= 0
            ? message + " [" + status.label() + "] at byte " + offset
            : message + " [" + status.label() + "]");
        this.status = status;
        this.plainMessage = message;
        this.feature = feature;
        this.detail = detail;
        this.offset = offset;
    }

    /** What kind of refusal this was. */
    public Status status() {
        return status;
    }

    /** What happened, in the engine's own words, without the status appended. */
    public String plainMessage() {
        return plainMessage;
    }

    /**
     * The construct the engine has not implemented, or null.
     *
     * It is finer grained than the capability table on purpose, so an
     * application can name what it hit without owning a list of every phrase.
     */
    public String feature() {
        return feature;
    }

    /**
     * Internal diagnostic text, or null unless the database was opened with
     * diagnostics.
     *
     * It may hold a file system path or a bound value, so do not show it to a
     * person and do not send it to a shared log.
     */
    public String detail() {
        return detail;
    }

    /** The byte offset into the statement, or -1 when there is none. */
    public int offset() {
        return offset;
    }

    /** Whether this is the engine refusing something it has not built. */
    public boolean isUnsupported() {
        return status == Status.UNSUPPORTED;
    }

    /**
     * Builds the exception a C error handle describes, and frees the handle
     * either way.
     *
     * The free happens whatever the outcome because an exception built from an
     * error must not leak it.
     *
     * @param driver - the loaded driver
     * @param handle - the C error handle, which is owned by this call
     */
    static InillucentException from(Driver driver, MemorySegment handle) {
        Status status;
        String message;
        String feature;
        String detail;
        int offset;
        try {
            status = Status.fromCode(driver.callInt("inillucent_error_status", handle));
            message = Driver.string(driver.callPointer("inillucent_error_message", handle));
            feature = Driver.string(driver.callPointer("inillucent_error_feature", handle));
            detail = Driver.string(driver.callPointer("inillucent_error_detail", handle));
            offset = driver.callInt("inillucent_error_offset", handle);
        } finally {
            driver.callVoid("inillucent_error_free", handle);
        }
        String said = message == null ? "" : message;
        return status == Status.UNSUPPORTED
            ? new UnsupportedFeatureException(status, said, feature, detail, offset)
            : new InillucentException(status, said, feature, detail, offset);
    }
}
