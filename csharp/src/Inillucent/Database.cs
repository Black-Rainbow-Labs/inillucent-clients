using System.Text;

namespace Inillucent;

/// <summary>How a database file is opened.</summary>
public sealed class OpenOptions
{
    /// <summary>Create the file when it is not there. Defaults to true.</summary>
    public bool Create { get; init; } = true;

    /// <summary>Refuse anything but a query.</summary>
    public bool ReadOnly { get; init; }

    /// <summary>
    /// Collect internal diagnostic text on failures.
    ///
    /// Diagnostics may hold a file system path or a bound value, so do not show
    /// them to a person and do not send them to a shared log.
    /// </summary>
    public bool Diagnostics { get; init; }

    /// <summary>
    /// Encrypts the database with this key, or opens an encrypted one.
    ///
    /// "x'" followed by 64 hex digits and a closing quote is a raw 32 byte key,
    /// and any other text is a passphrase, which the engine stretches with PBKDF2
    /// so each open takes about a quarter of a second. Null means no key. A wrong
    /// key, a key for a plaintext file and no key for an encrypted file all fail
    /// with Status.Corrupt. The key is never logged or included in an error.
    /// </summary>
    public string? Key { get; init; }

    /// <summary>Returns the flags the C ABI takes for these options.</summary>
    internal uint Flags()
    {
        uint flags = 0;
        if (Create)
        {
            flags |= 0x0001;
        }
        if (ReadOnly)
        {
            flags |= 0x0002;
        }
        if (Diagnostics)
        {
            flags |= 0x0004;
        }
        return flags;
    }
}

/// <summary>
/// One open database file.
///
/// One file is one buffer pool and the engine is single threaded, so keep a
/// Database and everything under it on one thread, or serialise every call on it
/// with a lock of your own. There is no lock inside. Two databases on two files
/// are independent.
/// </summary>
public sealed class Database : IDisposable
{
    private readonly List<Connection> _connections = [];
    private IntPtr _handle;

    private Database(IntPtr handle) => _handle = handle;

    /// <summary>
    /// Opens a database file, creating it when it is not there.
    ///
    /// When the options carry a key the file is opened with
    /// inillucent_open_with_key, and otherwise with inillucent_open.
    /// </summary>
    /// <param name="path">the database file</param>
    /// <param name="options">how to open it, including the optional encryption key, or null for the ordinary options</param>
    public static Database Open(string path, OpenOptions? options = null)
    {
        NativeMethods.EnsureResolver();
        Driver.CheckAbi();
        options ??= new OpenOptions();
        IntPtr handle;
        IntPtr error;
        var status = options.Key is null
            ? NativeMethods.inillucent_open(path, options.Flags(), out handle, out error)
            : NativeMethods.inillucent_open_with_key(
                path, options.Flags(), options.Key, out handle, out error);
        InillucentException.Check(status, error);
        return new Database(handle);
    }

    /// <summary>Opens a connection, and with it a session.</summary>
    public Connection Connect()
    {
        var status = NativeMethods.inillucent_connect(Live(), out var handle, out var error);
        InillucentException.Check(status, error);
        var connection = new Connection(this, handle);
        _connections.Add(connection);
        return connection;
    }

    /// <summary>The file this database is in.</summary>
    public string Path =>
        NativeMethods.ReadString(NativeMethods.inillucent_path(Live())) ?? "";

    /// <summary>Makes everything written so far durable in the file.</summary>
    public void Checkpoint()
    {
        InillucentException.Check(
            NativeMethods.inillucent_checkpoint(Live(), out var error), error);
    }

    /// <summary>Walks every tree and throws on the first thing that is wrong.</summary>
    public void IntegrityCheck()
    {
        InillucentException.Check(
            NativeMethods.inillucent_integrity_check(Live(), out var error), error);
    }

    /// <summary>
    /// Copies the database to a path, opening and checking the copy first.
    ///
    /// A backup nobody checked is a file that is assumed to be a database.
    /// </summary>
    /// <param name="path">where to write the copy</param>
    public void BackupTo(string path)
    {
        InillucentException.Check(
            NativeMethods.inillucent_backup_to(Live(), path, out var error), error);
    }

    /// <summary>
    /// Returns the C handle, or throws Status.InvalidState once the database is
    /// closed, so a call after Dispose is an error and never a null pointer
    /// handed to the engine.
    /// </summary>
    private IntPtr Live() =>
        _handle != IntPtr.Zero ? _handle : throw InillucentException.Closed("database");

    /// <summary>
    /// Checkpoints and closes, closing every connection first.
    ///
    /// The C library refuses to close a database that still has connections on
    /// it, which is deliberate: freeing it then would leave them pointing at
    /// memory that is gone. A statement or transaction that is still open keeps
    /// its connection alive, so the close then fails with Status.InvalidState and
    /// the database stays open and usable. Dispose the statement or transaction
    /// and dispose the database again. Disposing twice is safe.
    /// </summary>
    public void Dispose()
    {
        if (_handle == IntPtr.Zero)
        {
            return;
        }
        foreach (var connection in _connections)
        {
            connection.Dispose();
        }
        _connections.Clear();
        // The handle is only forgotten once the engine has let it go. Clearing it
        // first would lose a database the engine refused to close, and nothing
        // could ever close it after that.
        InillucentException.Check(
            NativeMethods.inillucent_close(_handle, out var error), error);
        _handle = IntPtr.Zero;
    }
}

/// <summary>
/// One connection to a database, and one session.
///
/// Temp tables, ATTACH and the connection pragmas are scoped to the session this
/// connection holds, so they last as long as it does. It keeps a reference to its
/// Database so the database cannot be collected first.
/// </summary>
public sealed class Connection : IDisposable
{
    private readonly Database _database;
    private IntPtr _handle;

    internal Connection(Database database, IntPtr handle)
    {
        _database = database;
        _handle = handle;
    }

    /// <summary>The database this connection is on.</summary>
    public Database Database => _database;

    /// <summary>
    /// Runs one statement and returns everything it produced.
    ///
    /// The limit caps the rows handed back, not the rows produced. Rows.Total is
    /// exact either way, because the engine materialises and the count was taken
    /// rather than estimated.
    /// </summary>
    /// <param name="sql">the statement to run</param>
    /// <param name="parameters">values for ?1, ?2 and so on, in order</param>
    /// <param name="limit">rows to hand back, or null for every row</param>
    public Rows Execute(string sql, IReadOnlyList<object?>? parameters = null, long? limit = null)
    {
        if (parameters is { Count: > 0 })
        {
            using var statement = Prepare(sql);
            return statement.Execute(parameters, limit);
        }
        var status = NativeMethods.inillucent_execute(
            Live(), sql, Capped(limit), out var rows, out var error);
        InillucentException.Check(status, error);
        return Rows.Take(rows);
    }

    /// <summary>
    /// Runs one statement and returns its rows as dictionaries keyed by column name.
    /// </summary>
    /// <param name="sql">the statement to run</param>
    /// <param name="parameters">values for ?1, ?2 and so on, in order</param>
    public List<Dictionary<string, object?>> Query(
        string sql, IReadOnlyList<object?>? parameters = null) =>
        Execute(sql, parameters).Objects();

    /// <summary>
    /// Runs one statement and returns the first column of its first row.
    /// </summary>
    /// <param name="sql">the statement to run</param>
    /// <param name="parameters">values for ?1, ?2 and so on, in order</param>
    public object? Scalar(string sql, IReadOnlyList<object?>? parameters = null) =>
        Execute(sql, parameters, 1).Scalar();

    /// <summary>
    /// Runs several statements separated by semicolons, for their effect.
    /// </summary>
    /// <param name="sql">the statements to run</param>
    public void ExecuteBatch(string sql)
    {
        InillucentException.Check(
            NativeMethods.inillucent_execute_batch(Live(), sql, out var error), error);
    }

    /// <summary>
    /// Compiles a statement so it can be run more than once.
    /// </summary>
    /// <param name="sql">the statement to compile</param>
    public Statement Prepare(string sql)
    {
        var status = NativeMethods.inillucent_prepare(Live(), sql, out var handle, out var error);
        InillucentException.Check(status, error);
        return new Statement(this, handle);
    }

    /// <summary>Opens a transaction.</summary>
    public Transaction Begin()
    {
        var status = NativeMethods.inillucent_txn_begin(Live(), out var handle, out var error);
        InillucentException.Check(status, error);
        return new Transaction(handle);
    }

    /// <summary>The rowid the most recent insert on this connection produced.</summary>
    public long LastInsertRowid => NativeMethods.inillucent_last_insert_rowid(Live());

    /// <summary>How many rows every statement on this connection has changed.</summary>
    public long TotalChanges => NativeMethods.inillucent_total_changes(Live());

    /// <summary>Whether a transaction is open on this connection.</summary>
    public bool InTransaction => NativeMethods.inillucent_in_transaction(Live()) != 0;

    /// <summary>
    /// The schema's generation, which changes when the schema does. Compare it to
    /// know whether a cached table description is stale.
    /// </summary>
    public ulong SchemaCookie => NativeMethods.inillucent_schema_cookie(Live());

    /// <summary>
    /// Asks a running statement to stop.
    ///
    /// Driver.Supports("cancel") answers Support.Partial. The engine checks for a
    /// cancel at every leaf of a scan and every batch a result collects, so a long
    /// scan, a large result or a slow join stops with Status.Interrupted and the
    /// connection stays usable. A single operator partway through one indivisible
    /// piece of work, such as a sort of rows it has already read, finishes first,
    /// so a Stop button should not promise an instant stop.
    /// </summary>
    public void Cancel()
    {
        InillucentException.Check(
            NativeMethods.inillucent_cancel(Live(), out var error), error);
    }

    /// <summary>
    /// Returns the C handle, or throws Status.InvalidState once the connection
    /// is closed, so a call after Dispose is an error and never a null pointer
    /// handed to the engine.
    /// </summary>
    private IntPtr Live() =>
        _handle != IntPtr.Zero ? _handle : throw InillucentException.Closed("connection");

    /// <summary>
    /// Returns the C limit for a caller's limit, where null is every row.
    /// </summary>
    /// <param name="limit">rows to hand back, or null</param>
    internal static ulong Capped(long? limit) =>
        limit is null ? NativeMethods.NoLimit : (ulong)limit.Value;

    /// <summary>Frees the connection. Disposing twice is safe.</summary>
    public void Dispose()
    {
        if (_handle == IntPtr.Zero)
        {
            return;
        }
        NativeMethods.inillucent_conn_free(_handle);
        _handle = IntPtr.Zero;
    }
}

/// <summary>A compiled statement and the values bound to it.</summary>
public sealed class Statement : IDisposable
{
    private readonly Connection _connection;
    private IntPtr _handle;

    internal Statement(Connection connection, IntPtr handle)
    {
        _connection = connection;
        _handle = handle;
    }

    /// <summary>The connection this statement was compiled on.</summary>
    public Connection Connection => _connection;

    /// <summary>
    /// Binds these values, runs the statement, and returns what it produced.
    /// </summary>
    /// <param name="parameters">values for ?1, ?2 and so on, in order</param>
    /// <param name="limit">rows to hand back, or null for every row</param>
    public Rows Execute(IReadOnlyList<object?>? parameters = null, long? limit = null)
    {
        NativeMethods.inillucent_clear_bindings(Live());
        if (parameters is not null)
        {
            for (var nth = 0; nth < parameters.Count; nth++)
            {
                Bind((uint)(nth + 1), parameters[nth]);
            }
        }
        var status = NativeMethods.inillucent_stmt_execute(
            _handle, Connection.Capped(limit), out var rows, out var error);
        InillucentException.Check(status, error);
        return Rows.Take(rows);
    }

    /// <summary>
    /// Binds one value, choosing the call by the .NET type, and throws when the
    /// engine refuses it, such as a position of 0.
    /// </summary>
    /// <param name="index">the one based parameter position</param>
    /// <param name="value">what to bind</param>
    public void Bind(uint index, object? value)
    {
        var handle = Live();
        int status;
        switch (value)
        {
            case null:
                status = NativeMethods.inillucent_bind_null(handle, index);
                break;
            case bool yes:
                status = NativeMethods.inillucent_bind_int(handle, index, yes ? 1 : 0);
                break;
            case sbyte or byte or short or ushort or int or uint or long:
                status = NativeMethods.inillucent_bind_int(handle, index, Convert.ToInt64(value));
                break;
            case float or double or decimal:
                status = NativeMethods.inillucent_bind_real(handle, index, Convert.ToDouble(value));
                break;
            case string text:
                var encoded = Encoding.UTF8.GetBytes(text);
                status = NativeMethods.inillucent_bind_text(
                    handle, index, NeverEmpty(encoded), (nuint)encoded.Length);
                break;
            case byte[] bytes:
                status = NativeMethods.inillucent_bind_blob(
                    handle, index, NeverEmpty(bytes), (nuint)bytes.Length);
                break;
            default:
                throw new ArgumentException(
                    $"cannot bind a {value.GetType().Name}. The engine stores NULL, integers, "
                    + "reals, text and bytes, and converting anything else would be this library "
                    + "deciding what your value means.", nameof(value));
        }
        // The bind calls return a status and no error handle. It was ignored, so a
        // refused bind left the parameter NULL and the statement ran anyway.
        InillucentException.Check(status, IntPtr.Zero);
    }

    /// <summary>
    /// Returns an array the marshaller will not hand across as a null pointer.
    ///
    /// The C ABI reads a null value pointer as NULL, deliberately. An empty string
    /// and an empty blob are values, not NULL, and a zero length array marshals as
    /// a null pointer, so binding "" would quietly store NULL instead. The length
    /// passed alongside stays 0, so the spare byte is never read.
    /// </summary>
    /// <param name="bytes">the bytes being bound</param>
    private static byte[] NeverEmpty(byte[] bytes) => bytes.Length == 0 ? new byte[1] : bytes;

    /// <summary>
    /// Returns the C handle, or throws Status.InvalidState once the statement is
    /// closed, so a call after Dispose is an error and never a null pointer
    /// handed to the engine.
    /// </summary>
    private IntPtr Live() =>
        _handle != IntPtr.Zero ? _handle : throw InillucentException.Closed("statement");

    /// <summary>Frees the statement. Disposing twice is safe.</summary>
    public void Dispose()
    {
        if (_handle == IntPtr.Zero)
        {
            return;
        }
        NativeMethods.inillucent_stmt_free(_handle);
        _handle = IntPtr.Zero;
    }
}

/// <summary>
/// One transaction, held open while the caller decides whether to commit.
///
/// The caller holds it open, runs statements, reads how many rows each one
/// changed, and only then commits. A check made after the commit cannot stop the
/// write it was checking.
///
/// Disposing rolls back, so a using block that ends without a commit undoes its
/// work, which is what an early return means.
/// </summary>
public sealed class Transaction : IDisposable
{
    private readonly List<ulong> _affected = [];
    private IntPtr _handle;

    internal Transaction(IntPtr handle) => _handle = handle;

    /// <summary>How many rows each statement in this transaction changed, in order.</summary>
    public IReadOnlyList<ulong> Affected => _affected;

    /// <summary>
    /// Runs one statement inside the transaction and returns the rows it changed.
    ///
    /// A failure rolls the whole transaction back before it throws, so a caller
    /// that stops at the first error has already undone everything.
    /// </summary>
    /// <param name="sql">the statement to run</param>
    public ulong Execute(string sql)
    {
        var status = NativeMethods.inillucent_txn_execute(
            _handle != IntPtr.Zero ? _handle : throw InillucentException.Closed("transaction"), sql, out var changed, out var error);
        InillucentException.Check(status, error);
        _affected.Add(changed);
        return changed;
    }

    /// <summary>Commits the transaction. The handle is spent either way.</summary>
    public void Commit()
    {
        if (_handle == IntPtr.Zero)
        {
            return;
        }
        var committing = _handle;
        _handle = IntPtr.Zero;
        var status = NativeMethods.inillucent_txn_commit(committing, out var error);
        try
        {
            InillucentException.Check(status, error);
        }
        finally
        {
            NativeMethods.inillucent_txn_rollback(committing);
        }
    }

    /// <summary>Rolls the transaction back and frees it. Rolling back twice is safe.</summary>
    public void Rollback()
    {
        if (_handle == IntPtr.Zero)
        {
            return;
        }
        NativeMethods.inillucent_txn_rollback(_handle);
        _handle = IntPtr.Zero;
    }

    /// <summary>Rolls back when the transaction was not committed.</summary>
    public void Dispose() => Rollback();
}
