namespace Inillucent;

/// <summary>
/// What a call returned.
///
/// Unsupported is a status of its own. The engine refuses what it has not built
/// rather than answering it wrongly, so an application can say "this engine
/// cannot do that yet" instead of "check your spelling".
/// </summary>
public enum Status
{
    /// <summary>The call succeeded.</summary>
    Ok = 0,
    /// <summary>This engine cannot do that yet, and Feature names the construct.</summary>
    Unsupported = 1,
    /// <summary>The statement is not valid SQL.</summary>
    Syntax = 2,
    /// <summary>No such table, column or index.</summary>
    NotFound = 3,
    /// <summary>A constraint refused the write.</summary>
    Constraint = 4,
    /// <summary>The database was opened read only and this would write.</summary>
    ReadOnly = 5,
    /// <summary>Something else holds what this call needs.</summary>
    Busy = 6,
    /// <summary>The work was stopped before it finished.</summary>
    Interrupted = 7,
    /// <summary>The file is not a database this engine can read.</summary>
    Corrupt = 8,
    /// <summary>The file system refused a read or a write.</summary>
    Io = 9,
    /// <summary>There is no room left to write into.</summary>
    Full = 10,
    /// <summary>A value or a statement is past a limit the engine holds.</summary>
    TooBig = 11,
    /// <summary>This API's own contract was broken, such as closing a database that still has connections.</summary>
    InvalidState = 12,
    /// <summary>A defect in the engine. Please report it.</summary>
    Internal = 13,
}

/// <summary>Names for the statuses, as the conformance suite writes them.</summary>
public static class StatusNames
{
    private static readonly Dictionary<Status, string> Labels = new()
    {
        [Status.Ok] = "ok",
        [Status.Unsupported] = "unsupported",
        [Status.Syntax] = "syntax",
        [Status.NotFound] = "not_found",
        [Status.Constraint] = "constraint",
        [Status.ReadOnly] = "readonly",
        [Status.Busy] = "busy",
        [Status.Interrupted] = "interrupted",
        [Status.Corrupt] = "corrupt",
        [Status.Io] = "io",
        [Status.Full] = "full",
        [Status.TooBig] = "too_big",
        [Status.InvalidState] = "invalid_state",
        [Status.Internal] = "internal",
    };

    /// <summary>
    /// Returns the name of a status, or a readable placeholder for one this
    /// version has never heard of.
    /// </summary>
    /// <param name="status">the status to name</param>
    public static string Label(this Status status) =>
        Labels.TryGetValue(status, out var label) ? label : $"status {(int)status}";
}

/// <summary>
/// Something the engine refused.
///
/// It carries the status, not only the message, because a caller that has to
/// match on prose to find out what happened will break the first time the
/// wording improves.
/// </summary>
public class InillucentException : Exception
{
    internal InillucentException(Status status, string message, string? feature,
                                string? detail, int offset)
        : base(offset >= 0
            ? $"{message} [{status.Label()}] at byte {offset}"
            : $"{message} [{status.Label()}]")
    {
        Status = status;
        PlainMessage = message;
        Feature = feature;
        Detail = detail;
        Offset = offset;
    }

    /// <summary>What kind of refusal this was.</summary>
    public Status Status { get; }

    /// <summary>What happened, in the engine's own words, without the status appended.</summary>
    public string PlainMessage { get; }

    /// <summary>
    /// The construct the engine has not implemented, or null.
    ///
    /// It is finer grained than the capability table on purpose, so an
    /// application can name what it hit without owning a list of every phrase.
    /// </summary>
    public string? Feature { get; }

    /// <summary>
    /// Internal diagnostic text, or null unless the database was opened with
    /// diagnostics. It may hold a path or a bound value, so do not show it to a
    /// person and do not send it to a shared log.
    /// </summary>
    public string? Detail { get; }

    /// <summary>The byte offset into the statement, or -1 when there is none.</summary>
    public int Offset { get; }

    /// <summary>Whether this is the engine refusing something it has not built.</summary>
    public bool IsUnsupported => Status == Status.Unsupported;

    /// <summary>
    /// Builds the exception a C error handle describes, and frees the handle
    /// either way.
    ///
    /// The free happens whatever the outcome because an exception built from an
    /// error must not leak it.
    /// </summary>
    /// <param name="handle">the C error handle, which is owned by this call</param>
    internal static InillucentException From(IntPtr handle)
    {
        Status status;
        string message;
        string? feature;
        string? detail;
        int offset;
        try
        {
            status = (Status)NativeMethods.inillucent_error_status(handle);
            message = NativeMethods.ReadString(NativeMethods.inillucent_error_message(handle)) ?? "";
            feature = NativeMethods.ReadString(NativeMethods.inillucent_error_feature(handle));
            detail = NativeMethods.ReadString(NativeMethods.inillucent_error_detail(handle));
            offset = NativeMethods.inillucent_error_offset(handle);
        }
        finally
        {
            NativeMethods.inillucent_error_free(handle);
        }
        return status == Status.Unsupported
            ? new UnsupportedFeatureException(status, message, feature, detail, offset)
            : new InillucentException(status, message, feature, detail, offset);
    }

    /// <summary>
    /// Throws when a call failed, using the error it produced.
    ///
    /// A non zero status with no error still throws: a call that failed and said
    /// nothing is not a reason to carry on.
    /// </summary>
    /// <param name="status">what the call returned</param>
    /// <param name="error">the error out parameter the call was given</param>
    internal static void Check(int status, IntPtr error)
    {
        if (status == 0)
        {
            return;
        }
        if (error != IntPtr.Zero)
        {
            throw From(error);
        }
        var named = (Status)status;
        throw new InillucentException(named, $"the call failed with {named.Label()}", null, null, -1);
    }
}

/// <summary>
/// The engine has not implemented the construct.
///
/// This is a separate type on purpose. The engine refuses what it has not built
/// rather than answering it wrongly, so an application can say "this engine
/// cannot do that yet" instead of "check your spelling". Feature names the
/// construct that was refused.
/// </summary>
public sealed class UnsupportedFeatureException : InillucentException
{
    internal UnsupportedFeatureException(Status status, string message, string? feature,
                                         string? detail, int offset)
        : base(status, message, feature, detail, offset)
    {
    }
}
