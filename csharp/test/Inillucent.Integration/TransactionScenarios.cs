using Inillucent;

/// <summary>The scenarios about transactions and errors.</summary>
public static partial class Program
{
    /// <summary>
    /// Two inserts in a transaction report their affected counts before the
    /// commit, and both rows are there after it.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void TransactionCommitsAllOfIt(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "commit.rdb"));
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (v TEXT)");
        using (var transaction = connection.Begin())
        {
            Same(1UL, transaction.Execute("INSERT INTO t VALUES ('a')"), "the first insert's affected count");
            Same(2UL, transaction.Execute("INSERT INTO t VALUES ('b'), ('c')"), "the second insert's affected count");
            Same("1,2", string.Join(",", transaction.Affected), "the affected counts in order");
            Check(connection.InTransaction, "in_transaction is false while the transaction is open");
            transaction.Commit();
            transaction.Commit();
        }
        Same(3L, Count(connection, "t"), "the rows after commit");
        Check(!connection.InTransaction, "in_transaction is true after commit");
    }

    /// <summary>
    /// An explicit rollback undoes its row, and so does a transaction the using
    /// block leaves without a commit.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void TransactionRollsBackWhenAskedAndWhenAbandoned(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "rollback.rdb"));
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (v TEXT)");
        var asked = connection.Begin();
        asked.Execute("INSERT INTO t VALUES ('rolled back')");
        asked.Rollback();
        asked.Rollback();
        Same(0L, Count(connection, "t"), "the rows after an explicit rollback");

        using (var abandoned = connection.Begin())
        {
            abandoned.Execute("INSERT INTO t VALUES ('abandoned')");
        }
        Same(0L, Count(connection, "t"), "the rows after a transaction left without commit");
        Check(!connection.InTransaction, "in_transaction is true after the using block ended");
    }

    /// <summary>
    /// A constraint failure inside a transaction rolls it all back, and the
    /// spent transaction then refuses execute and commit as invalid_state.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void AFailingStatementRollsTheTransactionBack(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "failing.rdb"));
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
        connection.Execute("INSERT INTO t VALUES (1)");
        using var transaction = connection.Begin();
        transaction.Execute("INSERT INTO t VALUES (2)");
        Refused(Status.Constraint, () => transaction.Execute("INSERT INTO t VALUES (1)"),
            "a duplicate key inside a transaction");
        Same(1L, Count(connection, "t"), "the rows after the failed transaction");
        Check(!connection.InTransaction, "in_transaction is true after the failure");
        Refused(Status.InvalidState, () => transaction.Execute("INSERT INTO t VALUES (3)"),
            "execute on a spent transaction");
        Refused(Status.InvalidState, transaction.Commit, "commit on a spent transaction");
        Refused(Status.InvalidState, () => transaction.Execute("INSERT INTO t VALUES (4)"),
            "execute after the commit was refused");
    }

    /// <summary>
    /// Errors carry their status, offset, message and, for an unsupported
    /// construct, the construct's name on its own exception type.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void ErrorsCarryStatusOffsetAndMessage(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "errors.rdb"));
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
        var syntax = Refused(Status.Syntax, () => connection.Execute("SELECT * FROM t WHERE"), "a truncated WHERE");
        Same(21, syntax.Offset, "the syntax error's byte offset");
        Check(syntax.PlainMessage.Length > 0, "the syntax error has no message");
        Check(syntax.Message.Contains("[syntax] at byte 21"), $"the message is {syntax.Message}");
        var missing = Refused(Status.NotFound, () => connection.Execute("SELECT * FROM missing_table"),
            "a missing table");
        Same(-1, missing.Offset, "the offset of a missing table error");
        connection.Execute("INSERT INTO t VALUES (1)");
        Refused(Status.Constraint, () => connection.Execute("INSERT INTO t VALUES (1)"), "a duplicate key");
        var unsupported = Refused(Status.Unsupported,
            () => connection.Execute("CREATE VIRTUAL TABLE f USING fts5(a, detail=none)"), "fts5 detail=none");
        Check(unsupported is UnsupportedFeatureException, "an unsupported refusal is not UnsupportedFeatureException");
        Check(unsupported.IsUnsupported, "IsUnsupported is false for an unsupported refusal");
        Check(unsupported.Feature?.Contains("detail=none") == true, $"the feature is {unsupported.Feature}");
    }

    /// <summary>
    /// Closing a database with a statement still open fails as invalid_state and
    /// keeps the database; the statement still runs, and once it is closed the
    /// database closes.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void ClosingRefusesWhileAStatementIsOpen(string directory)
    {
        var path = Path.Combine(directory, "held.rdb");
        using var database = Database.Open(path);
        var connection = database.Connect();
        connection.Execute("CREATE TABLE t (v INTEGER)");
        var statement = connection.Prepare("INSERT INTO t VALUES (?1)");
        Refused(Status.InvalidState, database.Dispose, "closing with a statement open");
        Same(1L, statement.Execute([7L]).Affected, "the statement run after the refused close");
        Same(Path.GetFullPath(path), Path.GetFullPath(database.Path), "the path after the refused close");
        statement.Dispose();
        database.Dispose();
        Refused(Status.InvalidState, () => database.Connect(), "connect after the database closed");
        using var reopened = Database.Open(path);
        using var reader = reopened.Connect();
        Same(7L, reader.Scalar("SELECT v FROM t"), "the row the statement wrote");
    }

    /// <summary>
    /// A call on anything that has been closed is an invalid_state error, and a
    /// second close does nothing.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void UseAfterCloseIsAnErrorNotACrash(string directory)
    {
        var database = Database.Open(Path.Combine(directory, "after-close.rdb"));
        var connection = database.Connect();
        connection.Execute("CREATE TABLE t (v INTEGER)");
        var statement = connection.Prepare("SELECT 1");
        statement.Dispose();
        statement.Dispose();
        Refused(Status.InvalidState, () => statement.Execute(), "execute on a closed statement");
        Refused(Status.InvalidState, () => statement.Bind(1, 1L), "bind on a closed statement");
        var transaction = connection.Begin();
        transaction.Commit();
        Refused(Status.InvalidState, () => transaction.Execute("SELECT 1"), "execute on a committed transaction");
        connection.Dispose();
        connection.Dispose();
        Refused(Status.InvalidState, () => connection.Execute("SELECT 1"), "execute on a closed connection");
        Refused(Status.InvalidState, () => connection.Prepare("SELECT 1"), "prepare on a closed connection");
        Refused(Status.InvalidState, () => connection.Begin(), "begin on a closed connection");
        Refused(Status.InvalidState, () => connection.ExecuteBatch("SELECT 1"), "a batch on a closed connection");
        Refused(Status.InvalidState, connection.Cancel, "cancel on a closed connection");
        Refused(Status.InvalidState, () => _ = connection.TotalChanges, "total changes on a closed connection");
        database.Dispose();
        database.Dispose();
        Refused(Status.InvalidState, database.Checkpoint, "checkpoint on a closed database");
        Refused(Status.InvalidState, () => _ = database.Path, "the path of a closed database");
    }
}
