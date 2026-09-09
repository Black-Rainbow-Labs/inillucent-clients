package com.inillucent;

import java.lang.foreign.Arena;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.ValueLayout;
import java.nio.charset.StandardCharsets;
import java.util.List;

/** A compiled statement and the values bound to it. */
public final class Statement implements AutoCloseable {

    private final Driver driver;
    private final Connection connection;
    private MemorySegment handle;

    Statement(Driver driver, Connection connection, MemorySegment handle) {
        this.driver = driver;
        this.connection = connection;
        this.handle = handle;
    }

    /**
     * Binds these values, runs the statement, and returns what it produced.
     *
     * @param params - values for ?1, ?2 and so on, in order
     */
    public Rows execute(List<Object> params) {
        return execute(params, null);
    }

    /**
     * Binds these values, runs the statement, and hands back at most limit rows.
     *
     * @param params - values for ?1, ?2 and so on, in order
     * @param limit - rows to hand back, or null for every row
     */
    public Rows execute(List<Object> params, Long limit) {
        driver.callVoid("inillucent_clear_bindings", handle);
        // One arena for the whole call, because every bound value is copied
        // before the bind returns, and the result is read after them all.
        try (Arena arena = Arena.ofConfined()) {
            for (int nth = 0; nth < params.size(); nth++) {
                bind(arena, nth + 1, params.get(nth));
            }
            MemorySegment out = arena.allocate(ValueLayout.ADDRESS);
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            int status = driver.callInt("inillucent_stmt_execute",
                handle, Connection.capped(limit), out, error);
            Check.status(driver, status, error);
            return Rows.take(driver, out.get(ValueLayout.ADDRESS, 0));
        }
    }

    /**
     * Binds one value, choosing the call by the Java type.
     *
     * @param arena - where a copy of the value lives until the call returns
     * @param index - the one based parameter position
     * @param value - what to bind
     */
    private void bind(Arena arena, int index, Object value) {
        if (value == null) {
            driver.callInt("inillucent_bind_null", handle, index);
        } else if (value instanceof Boolean yes) {
            driver.callInt("inillucent_bind_int", handle, index, yes ? 1L : 0L);
        } else if (value instanceof Byte || value instanceof Short
                   || value instanceof Integer || value instanceof Long) {
            driver.callInt("inillucent_bind_int", handle, index, ((Number) value).longValue());
        } else if (value instanceof Float || value instanceof Double) {
            driver.callInt("inillucent_bind_real", handle, index, ((Number) value).doubleValue());
        } else if (value instanceof String text) {
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            driver.callInt("inillucent_bind_text",
                handle, index, copy(arena, bytes), (long) bytes.length);
        } else if (value instanceof byte[] bytes) {
            driver.callInt("inillucent_bind_blob",
                handle, index, copy(arena, bytes), (long) bytes.length);
        } else {
            throw new IllegalArgumentException(
                "cannot bind a " + value.getClass().getName() + ". The engine stores NULL,"
                    + " integers, reals, text and bytes, and converting anything else would be"
                    + " this library deciding what your value means.");
        }
    }

    /**
     * Copies bytes into native memory, never handing the ABI a null pointer.
     *
     * The C ABI reads a null value pointer as NULL, deliberately. An empty string
     * and an empty blob are values, not NULL, so a zero length allocation would
     * otherwise store NULL. The length passed alongside stays 0, so the spare
     * byte is never read.
     *
     * @param arena - where the copy lives until the call returns
     * @param bytes - the bytes being bound
     */
    private static MemorySegment copy(Arena arena, byte[] bytes) {
        if (bytes.length == 0) {
            return arena.allocate(1);
        }
        MemorySegment segment = arena.allocate(bytes.length);
        MemorySegment.copy(bytes, 0, segment, ValueLayout.JAVA_BYTE, 0, bytes.length);
        return segment;
    }

    /** The connection this statement was compiled on. */
    public Connection connection() {
        return connection;
    }

    /** Frees the statement. Closing twice is safe. */
    @Override
    public void close() {
        if (handle == null) {
            return;
        }
        driver.callVoid("inillucent_stmt_free", handle);
        handle = null;
    }
}
