using System.Text;
using Inillucent;

/// <summary>The scenarios about statements, results and bound values.</summary>
public static partial class Program
{
    /// <summary>
    /// One prepared INSERT runs 100 times with new values, and a parameter left
    /// unbound on a later run reads as NULL.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void PreparedStatementRunsManyTimesWithFreshBindings(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "prepared.rdb"));
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (n INTEGER, label TEXT)");
        using (var insert = connection.Prepare("INSERT INTO t (n, label) VALUES (?1, ?2)"))
        {
            Check(ReferenceEquals(connection, insert.Connection), "the statement names another connection");
            for (var n = 0L; n < 100; n++)
            {
                Same(1L, insert.Execute([n, $"row {n}"]).Affected, $"the rows insert {n} changed");
            }
        }
        Same(100L, Count(connection, "t"), "the row count");
        Same(4950L, connection.Scalar("SELECT sum(n) FROM t"), "the sum of the values");
        Same("row 42", connection.Scalar("SELECT label FROM t WHERE n = 42"), "the label of row 42");

        using var add = connection.Prepare("SELECT ?1 + ?2");
        Same(3L, add.Execute([1L, 2L]).Scalar(), "?1 + ?2 with both bound");
        Same(null, add.Execute([1L]).Scalar(), "?1 + ?2 with only ?1 bound");
        // The engine refuses a value past the last placeholder with invalid_state.
        // The client used to ignore the bind status and drop the value silently.
        Refused(Status.InvalidState, () => connection.Execute("SELECT ?1", [1L, 2L]),
            "SELECT ?1 with two values");
    }

    /// <summary>
    /// A write reports affected and its tag, and a limited SELECT reports the
    /// rows handed back, the exact total, more, and its columns.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void RowsReportCountsColumnsAndLimits(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "rows.rdb"));
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        var written = connection.Execute("INSERT INTO t (v) VALUES ('a'), ('b')");
        Same(2L, written.Affected, "affected for a two row INSERT");
        Same("INSERT 2", written.Tag, "the tag for a two row INSERT");
        connection.Execute("INSERT INTO t (v) VALUES ('c'), ('d'), ('e')");

        var page = connection.Execute("SELECT id, v FROM t ORDER BY id", null, 2);
        Same(2, page.Count, "rows handed back under a limit of 2");
        Same(5L, page.Total, "total under a limit of 2");
        Same(true, page.More, "more under a limit of 2");
        Same(null, page.Affected, "affected for a SELECT");
        Same("id,v", string.Join(",", page.Columns), "the column names");
        // The engine returns "" for a plain column's declared type on 1.0.33, so
        // only the count is asserted. See integration.md.
        Same(2, page.ColumnTypes.Count, "the declared type entries");
        Same(1L, page.Get(0, "id"), "Get by column name");
        Same(null, page.Get(0, "missing"), "Get for a column that is not there");
        Same(1, page.ColumnIndex("v"), "ColumnIndex of v");
        Same("a", page.Objects()[0]["v"], "Objects keyed by name");
        Same(1L, page.One()![0], "One");
        Same(2, page.Count(), "the rows walked by the enumerator");
        Check(page.ToString().Contains("2 of 5"), $"ToString is {page}");
        Check(page.ElapsedMicros < 60_000_000, "ElapsedMicros is past a minute");
    }

    /// <summary>
    /// The last insert rowid follows each insert, and total changes goes up by
    /// the rows each write changed.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void LastInsertRowidAndTotalChanges(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "rowid.rdb"));
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        var before = connection.TotalChanges;
        connection.Execute("INSERT INTO t (id, v) VALUES (10, 'a')");
        Same(10L, connection.LastInsertRowid, "the last insert rowid after the first insert");
        connection.Execute("INSERT INTO t (id, v) VALUES (11, 'b')");
        Same(11L, connection.LastInsertRowid, "the last insert rowid after the second insert");
        Same(before + 2, connection.TotalChanges, "total changes after two inserts");
        connection.Execute("UPDATE t SET v = 'c'");
        Same(before + 4, connection.TotalChanges, "total changes after updating two rows");
    }

    /// <summary>
    /// The schema cookie holds across a SELECT and an INSERT and moves on a
    /// CREATE TABLE.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void SchemaCookieChangesWhenTheSchemaDoes(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "cookie.rdb"));
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (v TEXT)");
        var cookie = connection.SchemaCookie;
        connection.Execute("SELECT * FROM t");
        connection.Execute("INSERT INTO t VALUES ('a')");
        Same(cookie, connection.SchemaCookie, "the schema cookie after a SELECT and an INSERT");
        connection.Execute("CREATE TABLE u (v TEXT)");
        Check(cookie != connection.SchemaCookie, "the schema cookie did not change after CREATE TABLE");
    }

    /// <summary>
    /// A batch runs every statement, and a batch with an invalid statement fails
    /// as syntax.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void ExecuteBatchRunsEveryStatement(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "batch.rdb"));
        using var connection = database.Connect();
        connection.ExecuteBatch(
            "CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)");
        Same(3L, Count(connection, "t"), "the rows after the batch");
        Refused(Status.Syntax, () => connection.ExecuteBatch("INSERT INTO t VALUES (4); INSERT INTO t VALUES ("),
            "a batch whose second statement is invalid");
    }

    /// <summary>
    /// A one megabyte blob of every byte value and a one megabyte text outside
    /// the basic multilingual plane read back equal.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void LargeValuesRoundTrip(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "large.rdb"));
        using var connection = database.Connect();
        connection.Execute("CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB, s TEXT)");
        var blob = new byte[1 << 20];
        for (var nth = 0; nth < blob.Length; nth++)
        {
            blob[nth] = (byte)(nth % 256);
        }
        var text = new StringBuilder();
        while (Encoding.UTF8.GetByteCount(text.ToString()) < (1 << 20))
        {
            text.Append(string.Concat(Enumerable.Repeat("\U0001F600 a \U00010348 é ", 4096)));
        }
        connection.Execute("INSERT INTO t VALUES (1, ?1, ?2)", [blob, text.ToString()]);
        var row = connection.Execute("SELECT b, s FROM t WHERE id = 1")[0];
        Check(row[0] is byte[] back && back.AsSpan().SequenceEqual(blob), "the blob read back different");
        Check(text.ToString().Equals(row[1]), "the text read back different");
    }

    /// <summary>
    /// A bound FTS5 term finds its rowids, and a bound vector probe orders the
    /// nearest row first.
    /// </summary>
    /// <param name="directory">the scenario's temporary folder</param>
    private static void SearchWithBoundParameters(string directory)
    {
        using var database = Database.Open(Path.Combine(directory, "search.rdb"));
        using var connection = database.Connect();
        connection.ExecuteBatch("CREATE VIRTUAL TABLE docs USING fts5(body);"
            + "INSERT INTO docs(rowid, body) VALUES (1, 'the quick brown fox');"
            + "INSERT INTO docs(rowid, body) VALUES (2, 'a lazy dog');"
            + "INSERT INTO docs(rowid, body) VALUES (3, 'brown bread')");
        var found = connection.Execute("SELECT rowid FROM docs WHERE docs MATCH ?1 ORDER BY rowid", ["brown"]);
        Same("1,3", string.Join(",", found.Select(row => row[0])), "the rowids matching brown");

        connection.Execute("CREATE TABLE place (id INTEGER PRIMARY KEY, at VECTOR(2))");
        connection.Execute("INSERT INTO place VALUES (1, ?1)", [Floats(1f, 0f)]);
        connection.Execute("INSERT INTO place VALUES (2, ?1)", [Floats(0f, 1f)]);
        connection.Execute("INSERT INTO place VALUES (3, ?1)", [Floats(-1f, 0f)]);
        var nearest = connection.Execute(
            "SELECT id FROM place ORDER BY vector_distance_cos(at, ?1)", [Floats(0.1f, 0.9f)]);
        Same(2L, nearest[0][0], "the nearest row to (0.1, 0.9)");
    }

    /// <summary>Returns floats as the little endian bytes a VECTOR column holds.</summary>
    /// <param name="values">the vector's components</param>
    private static byte[] Floats(params float[] values)
    {
        if (!BitConverter.IsLittleEndian)
        {
            throw new PlatformNotSupportedException("this test writes vectors on a little endian machine");
        }
        var bytes = new byte[values.Length * 4];
        for (var nth = 0; nth < values.Length; nth++)
        {
            BitConverter.TryWriteBytes(bytes.AsSpan(nth * 4), values[nth]);
        }
        return bytes;
    }
}
