package com.inillucent;

import java.lang.foreign.Arena;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.ValueLayout;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Everything one statement produced.
 *
 * The engine materialises the result and this copies it into Java, so the object
 * stays usable after the C handle is freed. That is what lets it be returned
 * from a method and read later.
 *
 * A cell is null, Long, Double, String or byte[]. Null means NULL, which is not
 * the empty string.
 */
public final class Rows implements Iterable<List<Object>> {

    private final List<String> columns;
    private final List<String> columnTypes;
    private final List<List<Object>> rows;
    private final long total;
    private final boolean more;
    private final Long affected;
    private final long elapsedMicros;
    private final String tag;

    private Rows(List<String> columns, List<String> columnTypes, List<List<Object>> rows,
                 long total, boolean more, Long affected, long elapsedMicros, String tag) {
        this.columns = List.copyOf(columns);
        this.columnTypes = List.copyOf(columnTypes);
        this.rows = List.copyOf(rows);
        this.total = total;
        this.more = more;
        this.affected = affected;
        this.elapsedMicros = elapsedMicros;
        this.tag = tag;
    }

    /**
     * Copies a C result into Java and frees the handle.
     *
     * @param driver - the loaded driver
     * @param handle - the C result handle, which is owned by this call
     */
    static Rows take(Driver driver, MemorySegment handle) {
        try {
            long count = driver.callLong("inillucent_rows_column_count", handle);
            List<String> columns = new ArrayList<>();
            List<String> columnTypes = new ArrayList<>();
            for (long nth = 0; nth < count; nth++) {
                String name = Driver.string(
                    driver.callPointer("inillucent_rows_column_name", handle, nth));
                String declared = Driver.string(
                    driver.callPointer("inillucent_rows_column_type", handle, nth));
                columns.add(name == null ? "" : name);
                columnTypes.add(declared == null ? "" : declared);
            }
            long handed = driver.callLong("inillucent_rows_count", handle);
            List<List<Object>> read = new ArrayList<>();
            for (long row = 0; row < handed; row++) {
                List<Object> cells = new ArrayList<>();
                for (long column = 0; column < count; column++) {
                    cells.add(readCell(driver, handle, row, column));
                }
                read.add(unmodifiableRow(cells));
            }
            long changed = driver.callLong("inillucent_rows_affected", handle);
            String tag = Driver.string(driver.callPointer("inillucent_rows_tag", handle));
            return new Rows(columns, columnTypes, read,
                driver.callLong("inillucent_rows_total", handle),
                driver.callInt("inillucent_rows_more", handle) != 0,
                changed < 0 ? null : changed,
                driver.callLong("inillucent_rows_elapsed_us", handle),
                tag == null ? "" : tag);
        } finally {
            driver.callVoid("inillucent_rows_free", handle);
        }
    }

    /**
     * Returns an unmodifiable row that still holds its NULLs.
     *
     * List.copyOf throws on a null element, and NULL is a value here rather than
     * a missing one, so Collections.unmodifiableList is what a row is wrapped in.
     *
     * @param cells - the row being finished
     */
    private static List<Object> unmodifiableRow(List<Object> cells) {
        return java.util.Collections.unmodifiableList(new ArrayList<>(cells));
    }

    /**
     * Reads one cell as the kind it actually is.
     *
     * Text is not NUL terminated and may contain a NUL byte, so the length is
     * read rather than the bytes scanned.
     *
     * @param driver - the loaded driver
     * @param handle - the C result handle
     * @param row - the row index
     * @param column - the column index
     */
    private static Object readCell(Driver driver, MemorySegment handle, long row, long column) {
        int kind = driver.callInt("inillucent_value_type", handle, row, column);
        switch (kind) {
            case 0:
                return null;
            case 1:
                return driver.callLong("inillucent_value_int", handle, row, column);
            case 2:
                return driver.callDouble("inillucent_value_real", handle, row, column);
            default:
                try (Arena arena = Arena.ofConfined()) {
                    MemorySegment length = arena.allocate(ValueLayout.JAVA_LONG);
                    MemorySegment pointer = driver.callPointer(
                        "inillucent_value_bytes", handle, row, column, length);
                    byte[] bytes = Driver.bytes(pointer, length.get(ValueLayout.JAVA_LONG, 0));
                    return kind == 3 ? new String(bytes, java.nio.charset.StandardCharsets.UTF_8)
                                     : bytes;
                }
        }
    }

    /** The result column names, in order. */
    public List<String> columns() {
        return columns;
    }

    /** The type each column was declared with, or an empty string for an expression. */
    public List<String> columnTypes() {
        return columnTypes;
    }

    /** Every row handed back, in order. */
    public List<List<Object>> rows() {
        return rows;
    }

    /**
     * How many rows the statement produced, exactly.
     *
     * The engine materialises, so this was counted rather than estimated, which
     * is what lets a grid say "1 to 200 of 4,317" and mean it.
     */
    public long total() {
        return total;
    }

    /** Whether the limit cut anything off. */
    public boolean more() {
        return more;
    }

    /** Rows changed, or null for a statement that changed nothing, which is a query. */
    public Long affected() {
        return affected;
    }

    /** How long the engine spent on it. */
    public long elapsedMicros() {
        return elapsedMicros;
    }

    /** A one line summary for a status bar, such as "SELECT 27". */
    public String tag() {
        return tag;
    }

    /** How many rows were handed back. */
    public int size() {
        return rows.size();
    }

    /** Whether no rows were handed back. */
    public boolean isEmpty() {
        return rows.isEmpty();
    }

    /**
     * Returns every row as a map keyed by column name.
     *
     * A duplicate column name would silently lose a value, so the later one wins
     * and a caller who needs both reads {@link #rows()} instead.
     */
    public List<Map<String, Object>> objects() {
        List<Map<String, Object>> out = new ArrayList<>(rows.size());
        for (List<Object> row : rows) {
            Map<String, Object> object = new LinkedHashMap<>();
            for (int nth = 0; nth < columns.size() && nth < row.size(); nth++) {
                object.put(columns.get(nth), row.get(nth));
            }
            out.add(object);
        }
        return out;
    }

    /** Returns the first row, or null when the statement produced none. */
    public List<Object> one() {
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Returns the first column of the first row, or null when there is none.
     *
     * This is the shape of a COUNT or a MAX, where unwrapping one value out of
     * two lists is a cost the caller pays on every line.
     */
    public Object scalar() {
        List<Object> first = one();
        return first == null || first.isEmpty() ? null : first.get(0);
    }

    /**
     * Returns the position of a column by name, or -1 when there is none.
     *
     * @param name - the column name to look for
     */
    public int columnIndex(String name) {
        return columns.indexOf(name);
    }

    /**
     * Returns one cell by row index and column name.
     *
     * @param row - the row index
     * @param name - the column name
     */
    public Object get(int row, String name) {
        int column = columnIndex(name);
        if (column < 0 || row < 0 || row >= rows.size() || column >= rows.get(row).size()) {
            return null;
        }
        return rows.get(row).get(column);
    }

    @Override
    public Iterator<List<Object>> iterator() {
        return rows.iterator();
    }

    @Override
    public String toString() {
        return "Rows[" + tag + ": " + rows.size() + " of " + total + "]";
    }
}
