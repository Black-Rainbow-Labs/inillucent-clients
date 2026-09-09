package com.inillucent;

import java.lang.foreign.Arena;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.ValueLayout;
import java.util.List;
import java.util.Map;

/**
 * One connection to a database, and one session.
 *
 * Temp tables, ATTACH and the connection pragmas are scoped to the session this
 * connection holds, so they last as long as it does.
 *
 * It keeps a reference to its Database so the database cannot be collected
 * first. Without it the two could be finalised in either order, and one of those
 * orders frees a database with a live connection on it.
 */
public final class Connection implements AutoCloseable {

    /** The largest limit the C ABI accepts, which is every row. */
    static final long NO_LIMIT = -1L;

    private final Driver driver;
    private final Database database;
    private MemorySegment handle;

    Connection(Driver driver, Database database, MemorySegment handle) {
        this.driver = driver;
        this.database = database;
        this.handle = handle;
    }

    /**
     * Runs one statement with nothing bound and returns everything it produced.
     *
     * @param sql - the statement to run
     */
    public Rows execute(String sql) {
        return execute(sql, List.of(), null);
    }

    /**
     * Runs one statement with values bound to ?1, ?2 and so on.
     *
     * @param sql - the statement to run
     * @param params - values for ?1, ?2 and so on, in order
     */
    public Rows execute(String sql, List<Object> params) {
        return execute(sql, params, null);
    }

    /**
     * Runs one statement and hands back at most limit rows.
     *
     * The limit caps the rows handed back, not the rows produced. Rows.total is
     * exact either way, because the engine materialises and the count was taken
     * rather than estimated.
     *
     * @param sql - the statement to run
     * @param params - values for ?1, ?2 and so on, in order
     * @param limit - rows to hand back, or null for every row
     */
    public Rows execute(String sql, List<Object> params, Long limit) {
        if (params != null && !params.isEmpty()) {
            try (Statement statement = prepare(sql)) {
                return statement.execute(params, limit);
            }
        }
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment out = arena.allocate(ValueLayout.ADDRESS);
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            int status = driver.callInt("inillucent_execute",
                handle, arena.allocateFrom(sql), capped(limit), out, error);
            Check.status(driver, status, error);
            return Rows.take(driver, out.get(ValueLayout.ADDRESS, 0));
        }
    }

    /**
     * Runs one statement and returns its rows as maps keyed by column name.
     *
     * @param sql - the statement to run
     * @param params - values for ?1, ?2 and so on, in order
     */
    public List<Map<String, Object>> query(String sql, List<Object> params) {
        return execute(sql, params, null).objects();
    }

    /**
     * Runs one statement and returns its rows as maps keyed by column name.
     *
     * @param sql - the statement to run
     */
    public List<Map<String, Object>> query(String sql) {
        return execute(sql).objects();
    }

    /**
     * Runs one statement and returns the first column of its first row.
     *
     * @param sql - the statement to run
     * @param params - values for ?1, ?2 and so on, in order
     */
    public Object scalar(String sql, List<Object> params) {
        return execute(sql, params, 1L).scalar();
    }

    /**
     * Runs one statement and returns the first column of its first row.
     *
     * @param sql - the statement to run
     */
    public Object scalar(String sql) {
        return execute(sql, List.of(), 1L).scalar();
    }

    /**
     * Runs several statements separated by semicolons, for their effect.
     *
     * @param sql - the statements to run
     */
    public void executeBatch(String sql) {
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            int status = driver.callInt("inillucent_execute_batch",
                handle, arena.allocateFrom(sql), error);
            Check.status(driver, status, error);
        }
    }

    /**
     * Compiles a statement so it can be run more than once.
     *
     * @param sql - the statement to compile
     */
    public Statement prepare(String sql) {
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment out = arena.allocate(ValueLayout.ADDRESS);
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            int status = driver.callInt("inillucent_prepare",
                handle, arena.allocateFrom(sql), out, error);
            Check.status(driver, status, error);
            return new Statement(driver, this, out.get(ValueLayout.ADDRESS, 0));
        }
    }

    /** Opens a transaction. */
    public Transaction begin() {
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment out = arena.allocate(ValueLayout.ADDRESS);
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            Check.status(driver, driver.callInt("inillucent_txn_begin", handle, out, error), error);
            return new Transaction(driver, out.get(ValueLayout.ADDRESS, 0));
        }
    }

    /** The rowid the most recent insert on this connection produced. */
    public long lastInsertRowid() {
        return driver.callLong("inillucent_last_insert_rowid", handle);
    }

    /** How many rows every statement on this connection has changed. */
    public long totalChanges() {
        return driver.callLong("inillucent_total_changes", handle);
    }

    /** Whether a transaction is open on this connection. */
    public boolean inTransaction() {
        return driver.callInt("inillucent_in_transaction", handle) != 0;
    }

    /**
     * The schema's generation, which changes when the schema does.
     *
     * Compare it to know whether a cached table description is stale.
     */
    public long schemaCookie() {
        return driver.callLong("inillucent_schema_cookie", handle);
    }

    /**
     * Asks a running statement to stop.
     *
     * This always throws UnsupportedFeatureException today, and
     * Inillucent.supports("cancel") says so before an application draws a Stop
     * button: the engine runs a statement whole rather than a row at a time, so
     * there is no point at which it could notice.
     */
    public void cancel() {
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            Check.status(driver, driver.callInt("inillucent_cancel", handle, error), error);
        }
    }

    /**
     * Returns the C limit for a caller's limit, where null is every row.
     *
     * @param limit - rows to hand back, or null
     */
    static long capped(Long limit) {
        return limit == null ? NO_LIMIT : limit;
    }

    /** The database this connection is on. */
    public Database database() {
        return database;
    }

    /** Frees the connection. Closing twice is safe. */
    @Override
    public void close() {
        if (handle == null) {
            return;
        }
        driver.callVoid("inillucent_conn_free", handle);
        handle = null;
    }
}
