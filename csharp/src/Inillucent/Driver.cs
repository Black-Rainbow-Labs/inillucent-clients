namespace Inillucent;

/// <summary>Whether the engine does something.</summary>
public enum Support
{
    /// <summary>The engine does not do this.</summary>
    No = 0,

    /// <summary>The engine does this.</summary>
    Yes = 1,

    /// <summary>
    /// Yes, with the limit the note names. A caller that treats this as Yes
    /// without reading the note will be surprised.
    /// </summary>
    Partial = -1,

    /// <summary>
    /// No such capability in this build. Treat it as no rather than as yes: one
    /// that was never declared was certainly never checked.
    /// </summary>
    Unknown = -2,
}

/// <summary>
/// One row of the engine's capability table.
/// </summary>
/// <param name="Name">what the capability is called</param>
/// <param name="Support">whether the engine does it</param>
/// <param name="Note">what it does and does not do here; partial says the limit</param>
public readonly record struct Capability(string Name, Support Support, string Note)
{
    /// <summary>Whether the engine will do this at all. Partial counts.</summary>
    public bool IsSupported => Support is Support.Yes or Support.Partial;

    /// <summary>The support state as a word.</summary>
    public string SupportName => Support switch
    {
        Support.No => "no",
        Support.Yes => "yes",
        Support.Partial => "partial",
        _ => "unknown",
    };
}

/// <summary>
/// The driver itself: what it is, what it can do, and where it was loaded from.
///
/// This is the Inillucent client for .NET.
///
/// Inillucent is an embedded database written in Rust. There is no server: your
/// program opens a file, sends SQL to a library in the same process, and gets
/// typed rows back.
///
/// <code>
/// using var database = Database.Open("library.rdb");
/// using var connection = database.Connect();
///
/// connection.Execute("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)");
/// connection.Execute("INSERT INTO authors VALUES (?1, ?2)", [1, "Octavia Butler"]);
///
/// foreach (var author in connection.Query("SELECT id, name FROM authors"))
/// {
///     Console.WriteLine($"{author["id"]} {author["name"]}");
/// }
/// </code>
///
/// Two things about this engine shape the whole library. Values stay typed: null,
/// long, double, string and byte[], with null meaning NULL rather than an empty
/// string. And the engine refuses what it has not built rather than answering it
/// wrongly, which arrives as <see cref="UnsupportedFeatureException"/> naming the
/// construct in <see cref="InillucentException.Feature"/>.
/// </summary>
public static class Driver
{
    private static bool _abiChecked;

    /// <summary>
    /// Refuses a major ABI mismatch by name, before anything else is called.
    ///
    /// Calling a function whose signature has moved fails in a way nobody can
    /// read, which is the whole reason the version exists.
    /// </summary>
    internal static void CheckAbi()
    {
        if (_abiChecked)
        {
            return;
        }
        NativeMethods.EnsureResolver();
        var reported = NativeMethods.inillucent_abi_version();
        var major = reported / 1_000_000;
        if (major != NativeMethods.AbiMajor)
        {
            throw new DriverLoadException(
                $"{NativeMethods.ResolvedPath} reports ABI {major}."
                + $"{reported / 1000 % 1000}.{reported % 1000}, and this package was written for "
                + $"ABI {NativeMethods.AbiMajor}.x. A major bump moves a signature, so calling it "
                + "would fail in a way nobody can read. Install a matching driver.");
        }
        _abiChecked = true;
    }

    /// <summary>Returns what the driver calls itself.</summary>
    public static string Version()
    {
        CheckAbi();
        return NativeMethods.ReadString(NativeMethods.inillucent_version()) ?? "";
    }

    /// <summary>Returns the shared library's ABI version as major.minor.patch.</summary>
    public static string AbiVersion()
    {
        CheckAbi();
        var reported = NativeMethods.inillucent_abi_version();
        return $"{reported / 1_000_000}.{reported / 1000 % 1000}.{reported % 1000}";
    }

    /// <summary>Returns the file the shared library was loaded from.</summary>
    public static string DriverPath() => NativeMethods.ResolvedPath;

    /// <summary>
    /// Returns every capability the engine declares.
    ///
    /// Ask this before composing a statement rather than after. Every row is
    /// checked against the running engine by a test in both directions, so a
    /// claim of support that fails and a claim of absence that now works each
    /// turn it red.
    /// </summary>
    public static List<Capability> Capabilities()
    {
        CheckAbi();
        var count = NativeMethods.inillucent_capability_count();
        var found = new List<Capability>((int)count);
        for (nuint nth = 0; nth < count; nth++)
        {
            if (NativeMethods.inillucent_capability(nth, out var name, out var state, out var note)
                != 0)
            {
                continue;
            }
            found.Add(new Capability(
                NativeMethods.ReadString(name) ?? "",
                (Support)state,
                NativeMethods.ReadString(note) ?? ""));
        }
        return found;
    }

    /// <summary>
    /// Returns whether the engine does something, by name.
    /// </summary>
    /// <param name="name">the capability name</param>
    public static Support Supports(string name)
    {
        CheckAbi();
        return (Support)NativeMethods.inillucent_supports(name);
    }
}
