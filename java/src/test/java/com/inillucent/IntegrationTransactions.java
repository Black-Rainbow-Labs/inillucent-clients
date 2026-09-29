package com.inillucent;

import static com.inillucent.IntegrationTest.check;
import static com.inillucent.IntegrationTest.fails;
import static com.inillucent.IntegrationTest.same;

import java.nio.file.Path;
import java.util.List;

/**
 * The scenarios in the Transactions and Errors sections of
 * conformance/integration.md.
 */
final class IntegrationTransactions {

    private IntegrationTransactions() {
    }

    /** Returns these sections' scenarios, named as integration.md names them. */
    static List<IntegrationTest.Named> scenarios() {
        return List.of(
            new IntegrationTest.Named("transactionCommitsAllOfIt",
                IntegrationTransactions::transactionCommitsAllOfIt),
            new IntegrationTest.Named("transactionRollsBackWhenAskedAndWhenAbandoned",
                IntegrationTransactions::transactionRollsBackWhenAskedAndWhenAbandoned),
            new IntegrationTest.Named("aFailingStatementRollsTheTransactionBack",
                IntegrationTransactions::aFailingStatementRollsTheTransactionBack),
            new IntegrationTest.Named("errorsCarryStatusOffsetAndMessage",
                IntegrationTransactions::errorsCarryStatusOffsetAndMessage),
            new IntegrationTest.Named("closingRefusesWhileAStatementIsOpen",
                IntegrationTransactions::closingRefusesWhileAStatementIsOpen),
            new IntegrationTest.Named("useAfterCloseIsAnErrorNotACrash",
                IntegrationTransactions::useAfterCloseIsAnErrorNotACrash));
    }

    /**
     * Two inserts in a transaction report their counts and both survive the commit.
     *
     * @param folder - this scenario's temporary folder
     */
    static void transactionCommitsAllOfIt(Path folder) {
        try (Database database = Database.open(folder.resolve("commit.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (v TEXT)");
            try (Transaction transaction = connection.begin()) {
                same(transaction.execute("INSERT INTO t (v) VALUES ('a')"), 1L, "the first insert");
                same(transaction.execute("INSERT INTO t (v) VALUES ('b')"), 1L, "the second insert");
                same(transaction.affected(), List.of(1L, 1L), "the counts the transaction kept");
                check(connection.inTransaction(), "in_transaction must be true while it is open");
                transaction.commit();
                check(!connection.inTransaction(), "in_transaction must be false after commit");
                transaction.commit();
            }
            same(connection.scalar("SELECT COUNT(*) FROM t"), 2L, "rows after the commit");
        }
    }

    /**
     * An explicit rollback removes its row, and so does ending try with resources.
     *
     * @param folder - this scenario's temporary folder
     */
    static void transactionRollsBackWhenAskedAndWhenAbandoned(Path folder) {
        try (Database database = Database.open(folder.resolve("rollback.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (v TEXT)");
            Transaction asked = connection.begin();
            asked.execute("INSERT INTO t (v) VALUES ('rolled back')");
            asked.rollback();
            asked.rollback();
            same(connection.scalar("SELECT COUNT(*) FROM t"), 0L, "rows after rollback");
            try (Transaction abandoned = connection.begin()) {
                abandoned.execute("INSERT INTO t (v) VALUES ('abandoned')");
            }
            same(connection.scalar("SELECT COUNT(*) FROM t"), 0L, "rows after abandoning");
            check(!connection.inTransaction(), "no transaction may be open afterwards");
        }
    }

    /**
     * A constraint failure rolls everything back and spends the transaction.
     *
     * @param folder - this scenario's temporary folder
     */
    static void aFailingStatementRollsTheTransactionBack(Path folder) throws Exception {
        try (Database database = Database.open(folder.resolve("failing.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)");
            try (Transaction transaction = connection.begin()) {
                transaction.execute("INSERT INTO t (v) VALUES ('same')");
                fails(Status.CONSTRAINT, "an insert that breaks a unique constraint",
                    () -> transaction.execute("INSERT INTO t (v) VALUES ('same')"));
                same(connection.scalar("SELECT COUNT(*) FROM t"), 0L, "rows after the failure");
                check(!connection.inTransaction(), "in_transaction must be false after the failure");
                fails(Status.INVALID_STATE, "an execute on a spent transaction",
                    () -> transaction.execute("INSERT INTO t (v) VALUES ('after')"));
                fails(Status.INVALID_STATE, "a commit on a spent transaction", transaction::commit);
            }
        }
    }

    /**
     * Each kind of failure carries its status, and syntax carries its offset.
     *
     * @param folder - this scenario's temporary folder
     */
    static void errorsCarryStatusOffsetAndMessage(Path folder) throws Exception {
        try (Database database = Database.open(folder.resolve("errors.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
            InillucentException syntax = fails(Status.SYNTAX, "an unfinished WHERE",
                () -> connection.execute("SELECT * FROM t WHERE"));
            same(syntax.offset(), 21, "the syntax error's offset");
            check(!syntax.plainMessage().isEmpty(), "the syntax error must have a message");
            check(syntax.getMessage().endsWith("at byte 21"), "the message names the offset");
            check(!syntax.isUnsupported(), "a syntax error is not unsupported");
            fails(Status.NOT_FOUND, "a missing table",
                () -> connection.execute("SELECT * FROM missing_table"));
            connection.execute("INSERT INTO t (id) VALUES (1)");
            fails(Status.CONSTRAINT, "a duplicate primary key",
                () -> connection.execute("INSERT INTO t (id) VALUES (?1)", List.of(1)));
            InillucentException unsupported = fails(Status.UNSUPPORTED, "fts5 with detail=none",
                () -> connection.execute("CREATE VIRTUAL TABLE f USING fts5(a, detail=none)"));
            check(unsupported instanceof UnsupportedFeatureException,
                "an unsupported refusal must arrive as UnsupportedFeatureException");
            check(unsupported.isUnsupported() && unsupported.feature().contains("detail=none"),
                "the refusal must name detail=none, and named " + unsupported.feature());
        }
    }

    /**
     * Closing refuses while a statement is open, keeps the database usable, and
     * succeeds once the statement is closed.
     *
     * Database.close closes the connections it made for the caller, but it does
     * not track statements, so the engine still refuses and the handle must
     * survive the refusal.
     *
     * @param folder - this scenario's temporary folder
     */
    static void closingRefusesWhileAStatementIsOpen(Path folder) throws Exception {
        Database database = Database.open(folder.resolve("refuse.rdb"));
        Connection connection = database.connect();
        connection.execute("CREATE TABLE t (v INTEGER)");
        Statement insert = connection.prepare("INSERT INTO t (v) VALUES (?1)");
        fails(Status.INVALID_STATE, "closing with a statement open", database::close);
        same(insert.execute(List.of(7)).affected(), 1L, "the statement after a refused close");
        fails(Status.INVALID_STATE, "closing again with the statement still open", database::close);
        check(!database.path().isEmpty(), "the database stays open and usable after a refusal");
        insert.close();
        database.close();
        database.close();
    }

    /**
     * Calls on a closed connection, statement or transaction fail with
     * invalid_state, and closing twice does nothing.
     *
     * @param folder - this scenario's temporary folder
     */
    static void useAfterCloseIsAnErrorNotACrash(Path folder) throws Exception {
        Database database = Database.open(folder.resolve("after-close.rdb"));
        Connection connection = database.connect();
        connection.execute("CREATE TABLE t (v INTEGER)");
        Statement statement = connection.prepare("SELECT v FROM t");
        Transaction transaction = connection.begin();
        transaction.rollback();
        fails(Status.INVALID_STATE, "executing in a rolled back transaction",
            () -> transaction.execute("SELECT 1"));
        statement.close();
        statement.close();
        fails(Status.INVALID_STATE, "executing a closed statement", () -> statement.execute(List.of()));
        connection.close();
        connection.close();
        fails(Status.INVALID_STATE, "executing on a closed connection",
            () -> connection.execute("SELECT 1"));
        fails(Status.INVALID_STATE, "preparing on a closed connection",
            () -> connection.execute("SELECT ?1", List.of(1)));
        fails(Status.INVALID_STATE, "a batch on a closed connection",
            () -> connection.executeBatch("SELECT 1"));
        fails(Status.INVALID_STATE, "a transaction on a closed connection", connection::begin);
        database.close();
        database.close();
        fails(Status.INVALID_STATE, "connecting to a closed database", database::connect);
    }
}
