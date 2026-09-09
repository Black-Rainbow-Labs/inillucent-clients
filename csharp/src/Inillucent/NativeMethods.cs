using System.Runtime.InteropServices;

namespace Inillucent;

/// <summary>
/// Every symbol this package calls, and the resolver that points them at the
/// shared library wherever it actually is.
/// </summary>
internal static class NativeMethods
{
    /// <summary>The logical name the resolver maps to a real file.</summary>
    internal const string Library = "inillucent_driver_capi";

    /// <summary>The ABI this package was written against. Only the major has to match.</summary>
    internal const uint AbiMajor = 1;

    /// <summary>The largest limit the C ABI accepts, which is every row.</summary>
    internal const ulong NoLimit = ulong.MaxValue;

    private static readonly object Gate = new();
    private static bool _resolverInstalled;
    private static string? _resolvedPath;

    /// <summary>
    /// Installs the import resolver once, so every DllImport below finds the file
    /// that DriverLocator picked.
    /// </summary>
    internal static void EnsureResolver()
    {
        lock (Gate)
        {
            if (_resolverInstalled)
            {
                return;
            }
            _resolvedPath = DriverLocator.Resolve();
            NativeLibrary.SetDllImportResolver(
                typeof(NativeMethods).Assembly,
                (name, assembly, path) => name == Library
                    ? NativeLibrary.Load(_resolvedPath!)
                    : IntPtr.Zero);
            _resolverInstalled = true;
        }
    }

    /// <summary>The file the shared library was loaded from.</summary>
    internal static string ResolvedPath
    {
        get
        {
            EnsureResolver();
            return _resolvedPath!;
        }
    }

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern uint inillucent_abi_version();

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr inillucent_version();

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern nuint inillucent_capability_count();

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_capability(
        nuint nth, out IntPtr name, out int state, out IntPtr note);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_supports(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_open(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string path,
        uint flags, out IntPtr database, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_close(IntPtr database, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_checkpoint(IntPtr database, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_integrity_check(IntPtr database, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_backup_to(
        IntPtr database, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr inillucent_path(IntPtr database);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_connect(
        IntPtr database, out IntPtr connection, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void inillucent_conn_free(IntPtr connection);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_execute(
        IntPtr connection, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
        ulong limit, out IntPtr rows, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_execute_batch(
        IntPtr connection, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern long inillucent_last_insert_rowid(IntPtr connection);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern long inillucent_total_changes(IntPtr connection);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_in_transaction(IntPtr connection);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern ulong inillucent_schema_cookie(IntPtr connection);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_cancel(IntPtr connection, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_prepare(
        IntPtr connection, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
        out IntPtr statement, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void inillucent_stmt_free(IntPtr statement);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_bind_null(IntPtr statement, uint index);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_bind_int(IntPtr statement, uint index, long value);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_bind_real(IntPtr statement, uint index, double value);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_bind_text(
        IntPtr statement, uint index, byte[] value, nuint length);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_bind_blob(
        IntPtr statement, uint index, byte[] value, nuint length);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void inillucent_clear_bindings(IntPtr statement);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_stmt_execute(
        IntPtr statement, ulong limit, out IntPtr rows, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void inillucent_rows_free(IntPtr rows);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern nuint inillucent_rows_column_count(IntPtr rows);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr inillucent_rows_column_name(IntPtr rows, nuint nth);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr inillucent_rows_column_type(IntPtr rows, nuint nth);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern nuint inillucent_rows_count(IntPtr rows);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern nuint inillucent_rows_total(IntPtr rows);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_rows_more(IntPtr rows);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern long inillucent_rows_affected(IntPtr rows);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern ulong inillucent_rows_elapsed_us(IntPtr rows);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr inillucent_rows_tag(IntPtr rows);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_value_type(IntPtr rows, nuint row, nuint column);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern long inillucent_value_int(IntPtr rows, nuint row, nuint column);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern double inillucent_value_real(IntPtr rows, nuint row, nuint column);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr inillucent_value_bytes(
        IntPtr rows, nuint row, nuint column, out nuint length);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_txn_begin(
        IntPtr connection, out IntPtr transaction, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_txn_execute(
        IntPtr transaction, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
        out ulong affected, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_txn_commit(IntPtr transaction, out IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void inillucent_txn_rollback(IntPtr transaction);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_error_status(IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr inillucent_error_message(IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr inillucent_error_feature(IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern IntPtr inillucent_error_detail(IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern int inillucent_error_offset(IntPtr error);

    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    internal static extern void inillucent_error_free(IntPtr error);

    /// <summary>
    /// Copies a C string the library returned into a .NET string.
    ///
    /// Every string is copied on the way out, because it points inside a handle
    /// the caller may free. A null pointer becomes null, so a caller can tell
    /// absent from empty.
    /// </summary>
    /// <param name="pointer">what the library handed back</param>
    internal static string? ReadString(IntPtr pointer) =>
        pointer == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(pointer);

    /// <summary>
    /// Copies a counted run of bytes the library returned.
    /// </summary>
    /// <param name="pointer">what the library handed back</param>
    /// <param name="length">how many bytes to copy</param>
    internal static byte[] ReadBytes(IntPtr pointer, nuint length)
    {
        if (pointer == IntPtr.Zero || length == 0)
        {
            return [];
        }
        var copied = new byte[length];
        Marshal.Copy(pointer, copied, 0, (int)length);
        return copied;
    }
}
