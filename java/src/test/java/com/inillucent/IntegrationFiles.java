package com.inillucent;

import static com.inillucent.IntegrationTest.check;
import static com.inillucent.IntegrationTest.fails;
import static com.inillucent.IntegrationTest.same;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** The scenarios in the Files section of conformance/integration.md. */
final class IntegrationFiles {

    private IntegrationFiles() {
    }

    /** Returns this section's scenarios, named as integration.md names them. */
    static List<IntegrationTest.Named> scenarios() {
        return List.of(
            new IntegrationTest.Named("fileSurvivesCloseAndReopen",
                IntegrationFiles::fileSurvivesCloseAndReopen),
            new IntegrationTest.Named("missingFileWithoutCreateIsNotFound",
                IntegrationFiles::missingFileWithoutCreateIsNotFound),
            new IntegrationTest.Named("readOnlyOpenReadsAndRefusesWrites",
                IntegrationFiles::readOnlyOpenReadsAndRefusesWrites),
            new IntegrationTest.Named("secondHandleInTheSameProcessSeesCommittedRows",
                IntegrationFiles::secondHandleInTheSameProcessSeesCommittedRows),
            new IntegrationTest.Named("anotherProcessWritesAndThisOneReadsIt",
                IntegrationFiles::anotherProcessWritesAndThisOneReadsIt));
    }

    /**
     * Writes two rows, closes, reopens the same path and reads them back.
     *
     * @param folder - this scenario's temporary folder
     */
    static void fileSurvivesCloseAndReopen(Path folder) {
        Path path = folder.resolve("survives.rdb");
        try (Database database = Database.open(path);
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT, height REAL)");
            connection.execute("INSERT INTO person (name, height) VALUES (?1, ?2)",
                List.of("Ada", 1.65));
            connection.execute("INSERT INTO person (name, height) VALUES (?1, ?2)",
                Arrays.asList("Grace", null));
        }
        try (Database database = Database.open(path.toString());
             Connection connection = database.connect()) {
            same(database.path(), path.toString(), "the database's path");
            same(connection.database(), database, "the connection's database");
            Rows rows = connection.execute("SELECT id, name, height FROM person ORDER BY id");
            same(rows.size(), 2, "the row count");
            same(rows.get(0, "name"), "Ada", "the first name");
            same(rows.get(0, "height"), 1.65, "the first height");
            same(rows.get(1, "id"), 2L, "the second id");
            same(rows.get(1, "height"), null, "the second height");
        }
    }

    /**
     * Opening a missing path without create fails as not_found and makes no file.
     *
     * @param folder - this scenario's temporary folder
     */
    static void missingFileWithoutCreateIsNotFound(Path folder) throws Exception {
        Path path = folder.resolve("missing.rdb");
        fails(Status.NOT_FOUND, "opening a missing file without create",
            () -> Database.open(path.toString(), Database.Options.defaults().create(false)).close());
        check(!Files.exists(path), "no file may be created at " + path);
    }

    /**
     * A read only open reads the rows and refuses an INSERT as readonly.
     *
     * @param folder - this scenario's temporary folder
     */
    static void readOnlyOpenReadsAndRefusesWrites(Path folder) throws Exception {
        Path path = folder.resolve("readonly.rdb");
        try (Database database = Database.open(path);
             Connection connection = database.connect()) {
            connection.executeBatch("CREATE TABLE t (v TEXT); INSERT INTO t (v) VALUES ('a'), ('b')");
        }
        Database.Options readOnly = Database.Options.defaults().readOnly(true);
        try (Database database = Database.open(path.toString(), readOnly);
             Connection connection = database.connect()) {
            List<Map<String, Object>> rows = connection.query("SELECT v FROM t ORDER BY v");
            same(rows.size(), 2, "rows read from a read only database");
            same(rows.get(0).get("v"), "a", "the first value");
            fails(Status.READONLY, "an INSERT on a read only database",
                () -> connection.execute("INSERT INTO t (v) VALUES ('c')"));
            same(connection.scalar("SELECT COUNT(*) FROM t"), 2L, "the row count afterwards");
        }
    }

    /**
     * A row written through one handle is read through a second on the same file.
     *
     * On inillucent 1.0.33 a database that was just opened holds a read lock on
     * the file until its first statement runs, so a write through the first
     * handle straight after the second opens waits out busy_timeout and fails
     * with busy. The second handle therefore reads once first, which also shows
     * it seeing the table empty and then seeing the new row.
     *
     * @param folder - this scenario's temporary folder
     */
    static void secondHandleInTheSameProcessSeesCommittedRows(Path folder) {
        Path path = folder.resolve("two-handles.rdb");
        try (Database first = Database.open(path);
             Connection writer = first.connect()) {
            writer.execute("CREATE TABLE t (v TEXT)");
            try (Database second = Database.open(path);
                 Connection reader = second.connect()) {
                same(reader.scalar("SELECT COUNT(*) FROM t"), 0L, "rows before the insert");
                writer.execute("INSERT INTO t (v) VALUES ('from the first handle')");
                same(reader.scalar("SELECT v FROM t"), "from the first handle",
                    "the row read through the second handle");
            }
        }
    }

    /**
     * A child process inserts a row, and this process reads it without reopening.
     *
     * @param folder - this scenario's temporary folder
     */
    static void anotherProcessWritesAndThisOneReadsIt(Path folder) throws Exception {
        Path path = folder.resolve("two-processes.rdb");
        try (Database database = Database.open(path);
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (v TEXT)");
            IntegrationTest.runChild(path);
            same(connection.scalar("SELECT v FROM t"), "from the child process",
                "the row the child wrote, read without reopening");
        }
    }
}
