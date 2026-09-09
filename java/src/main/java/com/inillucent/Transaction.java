package com.inillucent;

import java.lang.foreign.Arena;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.ValueLayout;
import java.util.ArrayList;
import java.util.List;

/**
 * One transaction, held open while the caller decides whether to commit.
 *
 * The caller holds it open, runs statements, reads how many rows each one
 * changed, and only then commits. A check made after the commit cannot stop the
 * write it was checking.
 *
 * It is AutoCloseable and closing rolls back, so a try with resources that ends
 * without a commit undoes its work, which is what an early return means.
 */
public final class Transaction implements AutoCloseable {

    private final Driver driver;
    private final List<Long> affected = new ArrayList<>();
    private MemorySegment handle;

    Transaction(Driver driver, MemorySegment handle) {
        this.driver = driver;
        this.handle = handle;
    }

    /**
     * Runs one statement inside the transaction and returns the rows it changed.
     *
     * A failure rolls the whole transaction back before it throws, so a caller
     * that stops at the first error has already undone everything.
     *
     * @param sql - the statement to run
     */
    public long execute(String sql) {
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment changed = arena.allocate(ValueLayout.JAVA_LONG);
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            int status = driver.callInt("inillucent_txn_execute",
                handle, arena.allocateFrom(sql), changed, error);
            Check.status(driver, status, error);
            long count = changed.get(ValueLayout.JAVA_LONG, 0);
            affected.add(count);
            return count;
        }
    }

    /** How many rows each statement in this transaction changed, in order. */
    public List<Long> affected() {
        return List.copyOf(affected);
    }

    /** Commits the transaction. The handle is spent either way. */
    public void commit() {
        if (handle == null) {
            return;
        }
        MemorySegment committing = handle;
        handle = null;
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            int status = driver.callInt("inillucent_txn_commit", committing, error);
            try {
                Check.status(driver, status, error);
            } finally {
                driver.callVoid("inillucent_txn_rollback", committing);
            }
        }
    }

    /** Rolls the transaction back and frees it. Rolling back twice is safe. */
    public void rollback() {
        if (handle == null) {
            return;
        }
        driver.callVoid("inillucent_txn_rollback", handle);
        handle = null;
    }

    /** Rolls back when the transaction was not committed. */
    @Override
    public void close() {
        rollback();
    }
}
