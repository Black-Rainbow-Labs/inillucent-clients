package com.inillucent;

import static com.inillucent.IntegrationTest.check;
import static com.inillucent.IntegrationTest.fails;
import static com.inillucent.IntegrationTest.firstColumn;
import static com.inillucent.IntegrationTest.same;
import static com.inillucent.IntegrationTest.vector;

import java.nio.file.Path;
import java.util.List;

/** The scenarios in the Statements section of conformance/integration.md. */
final class IntegrationStatements {

    private IntegrationStatements() {
    }

    /** Returns this section's scenarios, named as integration.md names them. */
    static List<IntegrationTest.Named> scenarios() {
        return List.of(
            new IntegrationTest.Named("preparedStatementRunsManyTimesWithFreshBindings",
                IntegrationStatements::preparedStatementRunsManyTimesWithFreshBindings),
            new IntegrationTest.Named("rowsReportCountsColumnsAndLimits",
                IntegrationStatements::rowsReportCountsColumnsAndLimits),
            new IntegrationTest.Named("lastInsertRowidAndTotalChanges",
                IntegrationStatements::lastInsertRowidAndTotalChanges),
            new IntegrationTest.Named("schemaCookieChangesWhenTheSchemaDoes",
                IntegrationStatements::schemaCookieChangesWhenTheSchemaDoes),
            new IntegrationTest.Named("executeBatchRunsEveryStatement",
                IntegrationStatements::executeBatchRunsEveryStatement),
            new IntegrationTest.Named("largeValuesRoundTrip",
                IntegrationStatements::largeValuesRoundTrip),
            new IntegrationTest.Named("searchWithBoundParameters",
                IntegrationStatements::searchWithBoundParameters));
    }

    /**
     * One prepared INSERT runs 100 times, and an unbound parameter reads as NULL.
     *
     * @param folder - this scenario's temporary folder
     */
    static void preparedStatementRunsManyTimesWithFreshBindings(Path folder) {
        try (Database database = Database.open(folder.resolve("prepared.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (n INTEGER, label TEXT)");
            try (Statement insert = connection.prepare("INSERT INTO t (n, label) VALUES (?1, ?2)")) {
                same(insert.connection(), connection, "the statement's connection");
                for (int nth = 0; nth < 100; nth++) {
                    insert.execute(List.of(nth, "row " + nth));
                }
            }
            same(connection.scalar("SELECT COUNT(*) FROM t"), 100L, "the row count");
            same(connection.scalar("SELECT SUM(n) FROM t"), 4950L, "the sum of n");
            same(connection.scalar("SELECT label FROM t WHERE n = ?1", List.of(73)), "row 73",
                "row 73");
            try (Statement add = connection.prepare("SELECT ?1 + ?2")) {
                same(add.execute(List.of(2L, 3L)).scalar(), 5L, "2 + 3");
                same(add.execute(List.of(2L)).scalar(), null, "2 + an unbound parameter");
            }
        }
    }

    /**
     * A write reports affected and its tag; a limited SELECT reports total and more.
     *
     * @param folder - this scenario's temporary folder
     */
    static void rowsReportCountsColumnsAndLimits(Path folder) {
        try (Database database = Database.open(folder.resolve("rows.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
            Rows inserted = connection.execute("INSERT INTO t (v) VALUES ('a'), ('b')");
            same(inserted.affected(), 2L, "affected for two inserted rows");
            same(inserted.tag(), "INSERT 2", "the insert's tag");
            connection.execute("INSERT INTO t (v) VALUES ('c'), ('d'), ('e')");
            Rows page = connection.execute("SELECT id, v FROM t ORDER BY id", List.of(), 2L);
            same(page.size(), 2, "rows handed back");
            same(page.total(), 5L, "total");
            same(page.more(), true, "more");
            same(page.affected(), null, "affected for a query");
            same(page.columns(), List.of("id", "v"), "the column names");
            same(page.columnTypes().size(), 2, "the number of declared types");
            same(page.columnIndex("v"), 1, "the index of v");
            same(page.columnIndex("nope"), -1, "the index of a missing column");
            same(page.get(9, "v"), null, "a row that is not there");
            same(page.one(), List.of(1L, "a"), "the first row");
            same(firstColumn(page), List.of(1L, 2L), "the ids handed back");
            same(page.objects().get(1).get("v"), "b", "the second row's v");
            check(!page.isEmpty() && page.elapsedMicros() >= 0, "the page has rows and a time");
            check(page.toString().contains("2"), "toString describes the result");
            Rows empty = connection.execute("SELECT id FROM t WHERE id > 100");
            check(empty.isEmpty() && empty.one() == null && empty.scalar() == null,
                "a result with no rows has no first row and no scalar");
        }
    }

    /**
     * The last insert rowid is the second row's id and total changes counts rows.
     *
     * @param folder - this scenario's temporary folder
     */
    static void lastInsertRowidAndTotalChanges(Path folder) {
        try (Database database = Database.open(folder.resolve("rowid.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
            long before = connection.totalChanges();
            connection.execute("INSERT INTO t (v) VALUES ('first')");
            connection.execute("INSERT INTO t (v) VALUES ('second')");
            same(connection.lastInsertRowid(),
                connection.scalar("SELECT id FROM t WHERE v = 'second'"), "the last insert rowid");
            same(connection.totalChanges(), before + 2, "total changes after two inserts");
            connection.execute("UPDATE t SET v = 'changed'");
            same(connection.totalChanges(), before + 4, "total changes after updating two rows");
        }
    }

    /**
     * The schema cookie holds across a SELECT and an INSERT and moves on CREATE TABLE.
     *
     * @param folder - this scenario's temporary folder
     */
    static void schemaCookieChangesWhenTheSchemaDoes(Path folder) {
        try (Database database = Database.open(folder.resolve("cookie.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (v TEXT)");
            long start = connection.schemaCookie();
            connection.execute("SELECT * FROM t");
            connection.execute("INSERT INTO t (v) VALUES ('a')");
            same(connection.schemaCookie(), start, "the cookie after a SELECT and an INSERT");
            connection.execute("CREATE TABLE u (v TEXT)");
            check(connection.schemaCookie() != start, "a CREATE TABLE must change the cookie");
        }
    }

    /**
     * A batch runs every statement, and a batch with an invalid statement fails.
     *
     * @param folder - this scenario's temporary folder
     */
    static void executeBatchRunsEveryStatement(Path folder) throws Exception {
        try (Database database = Database.open(folder.resolve("batch.rdb"));
             Connection connection = database.connect()) {
            connection.executeBatch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1); "
                + "INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)");
            same(connection.scalar("SELECT COUNT(*) FROM t"), 3L, "the row count");
            fails(Status.SYNTAX, "a batch whose second statement is invalid",
                () -> connection.executeBatch("INSERT INTO t VALUES (4); INSERT INTO WHERE;"
                    + " INSERT INTO t VALUES (5)"));
        }
    }

    /**
     * A one megabyte blob and a one megabyte text value round trip exactly.
     *
     * @param folder - this scenario's temporary folder
     */
    static void largeValuesRoundTrip(Path folder) {
        byte[] blob = new byte[1 << 20];
        for (int nth = 0; nth < blob.length; nth++) {
            blob[nth] = (byte) nth;
        }
        String text = "😀 𐍈 abc ".repeat((1 << 20) / 13);
        try (Database database = Database.open(folder.resolve("large.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (b BLOB, s TEXT)");
            connection.execute("INSERT INTO t (b, s) VALUES (?1, ?2)", List.of(blob, text));
            Rows rows = connection.execute("SELECT b, s FROM t");
            same(rows.get(0, "b"), blob, "the blob");
            same(rows.get(0, "s"), text, "the text");
        }
    }

    /**
     * FTS5 MATCH with a bound term, and a vector search with a bound probe.
     *
     * @param folder - this scenario's temporary folder
     */
    static void searchWithBoundParameters(Path folder) {
        try (Database database = Database.open(folder.resolve("search.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE VIRTUAL TABLE docs USING fts5(body)");
            connection.execute("INSERT INTO docs (rowid, body) VALUES (1, 'the quick brown fox'),"
                + " (2, 'a lazy dog'), (3, 'the fox jumps')");
            Rows found = connection.execute(
                "SELECT rowid FROM docs WHERE docs MATCH ?1 ORDER BY rowid", List.of("fox"));
            same(firstColumn(found), List.of(1L, 3L), "the rowids matching fox");

            connection.execute("CREATE TABLE places (id INTEGER PRIMARY KEY, at VECTOR(2))");
            String insert = "INSERT INTO places (id, at) VALUES (?1, ?2)";
            connection.execute(insert, List.of(1, vector(1, 0)));
            connection.execute(insert, List.of(2, vector(0, 1)));
            connection.execute(insert, List.of(3, vector(0.7f, 0.7f)));
            Object nearest = connection.scalar(
                "SELECT id FROM places ORDER BY vector_distance_cos(at, ?1)",
                List.of(vector(0.1f, 1)));
            same(nearest, 2L, "the nearest place");
        }
    }
}
