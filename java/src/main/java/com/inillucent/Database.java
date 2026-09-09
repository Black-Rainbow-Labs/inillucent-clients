package com.inillucent;

import java.lang.foreign.Arena;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.ValueLayout;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * One open database file.
 *
 * One file is one buffer pool and the engine is single threaded, so keep a
 * Database and everything under it on one thread, or serialise every call on it
 * with a lock of your own. There is no lock inside. Two databases on two files
 * are independent.
 */
public final class Database implements AutoCloseable {

    static final int OPEN_CREATE = 0x0001;
    static final int OPEN_READONLY = 0x0002;
    static final int OPEN_DIAGNOSTICS = 0x0004;

    private final Driver driver;
    private final List<Connection> connections = new ArrayList<>();
    private MemorySegment handle;

    private Database(Driver driver, MemorySegment handle) {
        this.driver = driver;
        this.handle = handle;
    }

    /**
     * Opens a database file, creating it when it is not there.
     *
     * @param path - the database file
     */
    public static Database open(String path) {
        return open(path, Options.defaults());
    }

    /**
     * Opens a database file, creating it when it is not there.
     *
     * @param path - the database file
     */
    public static Database open(Path path) {
        return open(path.toString(), Options.defaults());
    }

    /**
     * Opens a database file with explicit options.
     *
     * @param path - the database file
     * @param options - how to open it
     */
    public static Database open(String path, Options options) {
        Driver driver = Driver.get();
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment out = arena.allocate(ValueLayout.ADDRESS);
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            int status = driver.callInt("inillucent_open",
                arena.allocateFrom(path), options.flags(), out, error);
            Check.status(driver, status, error);
            return new Database(driver, out.get(ValueLayout.ADDRESS, 0));
        }
    }

    /** Opens a connection, and with it a session. */
    public Connection connect() {
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment out = arena.allocate(ValueLayout.ADDRESS);
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            Check.status(driver, driver.callInt("inillucent_connect", handle, out, error), error);
            Connection connection = new Connection(driver, this, out.get(ValueLayout.ADDRESS, 0));
            connections.add(connection);
            return connection;
        }
    }

    /** The file this database is in. */
    public String path() {
        String found = Driver.string(driver.callPointer("inillucent_path", handle));
        return found == null ? "" : found;
    }

    /** Makes everything written so far durable in the file. */
    public void checkpoint() {
        simple("inillucent_checkpoint");
    }

    /** Walks every tree and throws on the first thing that is wrong. */
    public void integrityCheck() {
        simple("inillucent_integrity_check");
    }

    /**
     * Copies the database to a path, opening and checking the copy first.
     *
     * A backup nobody checked is a file that is assumed to be a database.
     *
     * @param path - where to write the copy
     */
    public void backupTo(String path) {
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            int status = driver.callInt("inillucent_backup_to",
                handle, arena.allocateFrom(path), error);
            Check.status(driver, status, error);
        }
    }

    /**
     * Runs one of the calls that take only the database and an error.
     *
     * @param name - the symbol to call
     */
    private void simple(String name) {
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            Check.status(driver, driver.callInt(name, handle, error), error);
        }
    }

    /**
     * Checkpoints and closes, closing every connection first.
     *
     * The C library refuses to close a database that still has connections on
     * it, which is deliberate: freeing it then would leave them pointing at
     * memory that is gone. Closing twice is safe.
     */
    @Override
    public void close() {
        if (handle == null) {
            return;
        }
        for (Connection connection : connections) {
            connection.close();
        }
        connections.clear();
        MemorySegment closing = handle;
        handle = null;
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment error = arena.allocate(ValueLayout.ADDRESS);
            Check.status(driver, driver.callInt("inillucent_close", closing, error), error);
        }
    }

    /** How a database file is opened. */
    public static final class Options {

        private boolean create = true;
        private boolean readOnly = false;
        private boolean diagnostics = false;

        /** Returns the ordinary options: create the file, allow writes, no diagnostics. */
        public static Options defaults() {
            return new Options();
        }

        /**
         * Says whether to create the file when it is not there.
         *
         * @param yes - true to create it
         */
        public Options create(boolean yes) {
            this.create = yes;
            return this;
        }

        /**
         * Says whether to refuse anything but a query.
         *
         * @param yes - true for read only
         */
        public Options readOnly(boolean yes) {
            this.readOnly = yes;
            return this;
        }

        /**
         * Says whether to collect internal diagnostic text on failures.
         *
         * Diagnostics may hold a file system path or a bound value, so do not
         * show them to a person and do not send them to a shared log.
         *
         * @param yes - true to collect them
         */
        public Options diagnostics(boolean yes) {
            this.diagnostics = yes;
            return this;
        }

        /** Returns the flags the C ABI takes for these options. */
        int flags() {
            int flags = 0;
            if (create) {
                flags |= OPEN_CREATE;
            }
            if (readOnly) {
                flags |= OPEN_READONLY;
            }
            if (diagnostics) {
                flags |= OPEN_DIAGNOSTICS;
            }
            return flags;
        }
    }
}
