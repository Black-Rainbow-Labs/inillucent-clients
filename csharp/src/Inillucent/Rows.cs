using System.Collections;
using System.Text;

namespace Inillucent;

/// <summary>
/// Everything one statement produced.
///
/// The engine materialises the result and this copies it into .NET, so the object
/// stays usable after the C handle is freed. That is what lets it be returned
/// from a method and read later.
///
/// A cell is null, long, double, string or byte[]. Null means NULL, which is not
/// the empty string.
/// </summary>
public sealed class Rows : IReadOnlyList<IReadOnlyList<object?>>
{
    private readonly IReadOnlyList<IReadOnlyList<object?>> _rows;

    private Rows(
        IReadOnlyList<string> columns,
        IReadOnlyList<string> columnTypes,
        IReadOnlyList<IReadOnlyList<object?>> rows,
        long total,
        bool more,
        long? affected,
        ulong elapsedMicros,
        string tag)
    {
        Columns = columns;
        ColumnTypes = columnTypes;
        _rows = rows;
        Total = total;
        More = more;
        Affected = affected;
        ElapsedMicros = elapsedMicros;
        Tag = tag;
    }

    /// <summary>The result column names, in order.</summary>
    public IReadOnlyList<string> Columns { get; }

    /// <summary>
    /// The type each column was declared with, or an empty string for an
    /// expression, which has none.
    /// </summary>
    public IReadOnlyList<string> ColumnTypes { get; }

    /// <summary>
    /// How many rows the statement produced, exactly.
    ///
    /// The engine materialises, so this was counted rather than estimated, which
    /// is what lets a grid say "1 to 200 of 4,317" and mean it.
    /// </summary>
    public long Total { get; }

    /// <summary>Whether the limit cut anything off.</summary>
    public bool More { get; }

    /// <summary>Rows changed, or null for a statement that changed nothing.</summary>
    public long? Affected { get; }

    /// <summary>How long the engine spent on it.</summary>
    public ulong ElapsedMicros { get; }

    /// <summary>A one line summary for a status bar, such as "SELECT 27".</summary>
    public string Tag { get; }

    /// <summary>How many rows were handed back.</summary>
    public int Count => _rows.Count;

    /// <summary>Returns one row by position.</summary>
    /// <param name="index">the row index</param>
    public IReadOnlyList<object?> this[int index] => _rows[index];

    /// <summary>
    /// Copies a C result into .NET and frees the handle.
    /// </summary>
    /// <param name="handle">the C result handle, which is owned by this call</param>
    internal static Rows Take(IntPtr handle)
    {
        try
        {
            var count = NativeMethods.inillucent_rows_column_count(handle);
            var columns = new List<string>((int)count);
            var columnTypes = new List<string>((int)count);
            for (nuint nth = 0; nth < count; nth++)
            {
                columns.Add(
                    NativeMethods.ReadString(
                        NativeMethods.inillucent_rows_column_name(handle, nth)) ?? "");
                columnTypes.Add(
                    NativeMethods.ReadString(
                        NativeMethods.inillucent_rows_column_type(handle, nth)) ?? "");
            }

            var handed = NativeMethods.inillucent_rows_count(handle);
            var rows = new List<IReadOnlyList<object?>>((int)handed);
            for (nuint row = 0; row < handed; row++)
            {
                var cells = new object?[(int)count];
                for (nuint column = 0; column < count; column++)
                {
                    cells[(int)column] = ReadCell(handle, row, column);
                }
                rows.Add(cells);
            }

            var changed = NativeMethods.inillucent_rows_affected(handle);
            return new Rows(
                columns,
                columnTypes,
                rows,
                (long)NativeMethods.inillucent_rows_total(handle),
                NativeMethods.inillucent_rows_more(handle) != 0,
                changed < 0 ? null : changed,
                NativeMethods.inillucent_rows_elapsed_us(handle),
                NativeMethods.ReadString(NativeMethods.inillucent_rows_tag(handle)) ?? "");
        }
        finally
        {
            NativeMethods.inillucent_rows_free(handle);
        }
    }

    /// <summary>
    /// Reads one cell as the kind it actually is.
    ///
    /// Text is not NUL terminated and may contain a NUL byte, so the length is
    /// read rather than the bytes scanned.
    /// </summary>
    /// <param name="handle">the C result handle</param>
    /// <param name="row">the row index</param>
    /// <param name="column">the column index</param>
    private static object? ReadCell(IntPtr handle, nuint row, nuint column)
    {
        var kind = NativeMethods.inillucent_value_type(handle, row, column);
        switch (kind)
        {
            case 0:
                return null;
            case 1:
                return NativeMethods.inillucent_value_int(handle, row, column);
            case 2:
                return NativeMethods.inillucent_value_real(handle, row, column);
            default:
                var pointer = NativeMethods.inillucent_value_bytes(
                    handle, row, column, out var length);
                var bytes = NativeMethods.ReadBytes(pointer, length);
                return kind == 3 ? Encoding.UTF8.GetString(bytes) : bytes;
        }
    }

    /// <summary>
    /// Returns every row as a dictionary keyed by column name.
    ///
    /// A duplicate column name would silently lose a value, so the later one wins
    /// and a caller who needs both reads the rows directly instead.
    /// </summary>
    public List<Dictionary<string, object?>> Objects()
    {
        var out_ = new List<Dictionary<string, object?>>(_rows.Count);
        foreach (var row in _rows)
        {
            var object_ = new Dictionary<string, object?>();
            for (var nth = 0; nth < Columns.Count && nth < row.Count; nth++)
            {
                object_[Columns[nth]] = row[nth];
            }
            out_.Add(object_);
        }
        return out_;
    }

    /// <summary>Returns the first row, or null when the statement produced none.</summary>
    public IReadOnlyList<object?>? One() => _rows.Count == 0 ? null : _rows[0];

    /// <summary>
    /// Returns the first column of the first row, or null when there is none.
    ///
    /// This is the shape of a COUNT or a MAX, where unwrapping one value out of
    /// two lists is a cost the caller pays on every line.
    /// </summary>
    public object? Scalar()
    {
        var first = One();
        return first is null || first.Count == 0 ? null : first[0];
    }

    /// <summary>
    /// Returns the position of a column by name, or -1 when there is none.
    /// </summary>
    /// <param name="name">the column name to look for</param>
    public int ColumnIndex(string name)
    {
        for (var nth = 0; nth < Columns.Count; nth++)
        {
            if (Columns[nth] == name)
            {
                return nth;
            }
        }
        return -1;
    }

    /// <summary>
    /// Returns one cell by row index and column name.
    /// </summary>
    /// <param name="row">the row index</param>
    /// <param name="name">the column name</param>
    public object? Get(int row, string name)
    {
        var column = ColumnIndex(name);
        if (column < 0 || row < 0 || row >= _rows.Count || column >= _rows[row].Count)
        {
            return null;
        }
        return _rows[row][column];
    }

    /// <summary>Walks the rows in the order the engine produced them.</summary>
    public IEnumerator<IReadOnlyList<object?>> GetEnumerator() => _rows.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

    /// <summary>Returns the tag, the rows handed back, and the exact total.</summary>
    public override string ToString() => $"Rows[{Tag}: {_rows.Count} of {Total}]";
}
