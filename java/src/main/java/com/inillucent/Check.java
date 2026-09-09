package com.inillucent;

import java.lang.foreign.MemorySegment;
import java.lang.foreign.ValueLayout;

/** Turning a failed C call into the right Java exception. */
final class Check {

    private Check() {
    }

    /**
     * Throws when a call failed, using the error it produced.
     *
     * A non zero status with no error still throws: a call that failed and said
     * nothing is not a reason to carry on.
     *
     * @param driver - the loaded driver
     * @param status - what the call returned
     * @param error - the error out parameter the call was given
     */
    static void status(Driver driver, int status, MemorySegment error) {
        if (status == 0) {
            return;
        }
        MemorySegment handle = error.get(ValueLayout.ADDRESS, 0);
        if (handle != null && !handle.equals(MemorySegment.NULL)) {
            throw InillucentException.from(driver, handle);
        }
        Status named = Status.fromCode(status);
        throw new InillucentException(named, "the call failed with " + named.label(),
            null, null, -1);
    }
}
