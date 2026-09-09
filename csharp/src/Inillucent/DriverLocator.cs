using System.Runtime.InteropServices;

namespace Inillucent;

/// <summary>
/// Finds the shared library, in the same order every client library in this
/// repository uses, so an application that works in one works in the rest.
/// </summary>
public static class DriverLocator
{
    /// <summary>Returns the shared library file names this platform uses.</summary>
    private static string[] LibraryNames()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return ["inillucent_driver_capi.dll"];
        }
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return ["libinillucent_driver_capi.dylib"];
        }
        return ["libinillucent_driver_capi.so"];
    }

    /// <summary>
    /// Returns every place the shared library is looked for, in order.
    ///
    /// INILLUCENT_DRIVER_LIB first, then the assembly's own folder, then this
    /// repository's native folder, then an engine checkout beside it.
    /// </summary>
    public static IReadOnlyList<string> SearchPaths()
    {
        var found = new List<string>();
        var named = Environment.GetEnvironmentVariable("INILLUCENT_DRIVER_LIB");
        if (!string.IsNullOrEmpty(named))
        {
            found.Add(named);
        }

        var beside = AppContext.BaseDirectory;
        var repository = RepositoryRoot();
        var engines = new[]
        {
            Path.Combine(repository, "..", "inillucent"),
            Path.Combine(repository, "..", "..", "inillucent"),
        };

        foreach (var name in LibraryNames())
        {
            found.Add(Path.Combine(beside, name));
            found.Add(Path.Combine(repository, "native", name));
            foreach (var engine in engines)
            {
                foreach (var profile in new[] { "release", "debug" })
                {
                    found.Add(Path.Combine(engine, "target", profile, name));
                }
            }
        }
        return found.Select(path => Path.GetFullPath(path)).ToList();
    }

    /// <summary>
    /// Returns the clients repository this assembly belongs to.
    ///
    /// INILLUCENT_REPOSITORY is what the repository's own test run sets. Without
    /// it, a NuGet package on somebody else's machine has no repository to find,
    /// and INILLUCENT_DRIVER_LIB is the answer for that case.
    /// </summary>
    private static string RepositoryRoot()
    {
        var told = Environment.GetEnvironmentVariable("INILLUCENT_REPOSITORY");
        if (!string.IsNullOrEmpty(told))
        {
            return Path.GetFullPath(told);
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    }

    /// <summary>
    /// Returns the path of the shared library, or throws saying where it looked.
    ///
    /// A message that names every place it tried is the difference between a
    /// problem somebody can fix and one they have to guess at.
    /// </summary>
    public static string Resolve()
    {
        var paths = SearchPaths();
        foreach (var candidate in paths)
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }
        throw new DriverLoadException(
            "cannot find the inillucent driver shared library. Looked in:\n  "
            + string.Join("\n  ", paths)
            + "\nBuild it with\n  cargo build --release --manifest-path <engine>/Cargo.toml"
            + " -p inillucent-driver-capi\nthen run scripts/fetch-native.mjs, or set"
            + " INILLUCENT_DRIVER_LIB to its path.");
    }
}

/// <summary>The shared library could not be found, or its ABI does not match.</summary>
public sealed class DriverLoadException : Exception
{
    /// <summary>
    /// Says where the library was looked for, or why the one found does not match.
    /// </summary>
    /// <param name="message">what went wrong, naming every place that was tried</param>
    public DriverLoadException(string message) : base(message)
    {
    }
}
