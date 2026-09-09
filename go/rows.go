package inillucent

// Value kinds, as the engine reports them.
const (
	kindNull    = 0
	kindInteger = 1
	kindReal    = 2
	kindText    = 3
	kindBlob    = 4
)

// Rows is everything one statement produced.
//
// The engine materialises the result and this copies it into Go, so it stays
// usable after the C handle is freed.
type Rows struct {
	// Columns are the result column names, in order.
	Columns []string
	// ColumnTypes are the types the schema declared, or an empty string for an
	// expression, which has none.
	ColumnTypes []string
	// Values are every row handed back, in order. A cell is nil, int64,
	// float64, string or []byte.
	Values [][]any
	// Total is how many rows the statement produced, exactly.
	//
	// The engine materialises, so this was counted rather than estimated, which
	// is what lets a grid say "1 to 200 of 4,317" and mean it.
	Total int
	// More reports whether the limit cut anything off.
	More bool
	// Affected is how many rows changed, or -1 for a statement that changed
	// nothing, which is what a query is.
	Affected int64
	// ElapsedMicros is how long the engine spent on it.
	ElapsedMicros uint64
	// Tag is a one line summary for a status bar, such as "SELECT 27".
	Tag string
}

// readCell reads one cell as the kind it actually is.
//
// Text is not NUL terminated and may contain a NUL byte, so the length is read
// rather than the bytes scanned.
//
// @param calls - the driver call table
// @param handle - the C result handle
// @param row - the row index
// @param column - the column index
func readCell(calls *driverCalls, handle uintptr, row, column uintptr) any {
	switch calls.valueType(handle, row, column) {
	case kindNull:
		return nil
	case kindInteger:
		return calls.valueInt(handle, row, column)
	case kindReal:
		return calls.valueReal(handle, row, column)
	case kindText:
		var length uintptr
		pointer := calls.valueBytes(handle, row, column, &length)
		if pointer == nil && length == 0 {
			return ""
		}
		return string(goBytes(pointer, length))
	default:
		var length uintptr
		pointer := calls.valueBytes(handle, row, column, &length)
		return goBytes(pointer, length)
	}
}

// takeRows copies a C result into Go and frees the handle.
//
// @param calls - the driver call table
// @param handle - the C result handle, which is owned by this call
func takeRows(calls *driverCalls, handle uintptr) *Rows {
	defer calls.rowsFree(handle)

	count := calls.rowsColumnCount(handle)
	rows := &Rows{
		Columns:       make([]string, 0, count),
		ColumnTypes:   make([]string, 0, count),
		Total:         int(calls.rowsTotal(handle)),
		More:          calls.rowsMore(handle) != 0,
		Affected:      calls.rowsAffected(handle),
		ElapsedMicros: calls.rowsElapsedUs(handle),
	}
	rows.Tag, _ = goString(calls.rowsTag(handle))
	for nth := uintptr(0); nth < count; nth++ {
		name, _ := goString(calls.rowsColumnName(handle, nth))
		declared, _ := goString(calls.rowsColumnType(handle, nth))
		rows.Columns = append(rows.Columns, name)
		rows.ColumnTypes = append(rows.ColumnTypes, declared)
	}
	handed := calls.rowsCount(handle)
	rows.Values = make([][]any, 0, handed)
	for row := uintptr(0); row < handed; row++ {
		cells := make([]any, 0, count)
		for column := uintptr(0); column < count; column++ {
			cells = append(cells, readCell(calls, handle, row, column))
		}
		rows.Values = append(rows.Values, cells)
	}
	return rows
}

// Len returns how many rows were handed back.
func (rows *Rows) Len() int {
	return len(rows.Values)
}

// Objects returns every row as a map keyed by column name.
//
// A duplicate column name would silently lose a value, so the later one wins and
// a caller who needs both reads Values instead.
func (rows *Rows) Objects() []map[string]any {
	out := make([]map[string]any, 0, len(rows.Values))
	for _, row := range rows.Values {
		object := make(map[string]any, len(rows.Columns))
		for nth, name := range rows.Columns {
			if nth < len(row) {
				object[name] = row[nth]
			}
		}
		out = append(out, object)
	}
	return out
}

// One returns the first row, or nil when the statement produced none.
func (rows *Rows) One() []any {
	if len(rows.Values) == 0 {
		return nil
	}
	return rows.Values[0]
}

// Scalar returns the first column of the first row, or nil when there is none.
//
// This is the shape of a COUNT or a MAX, where unwrapping one value out of two
// slices is a cost the caller pays on every line.
func (rows *Rows) Scalar() any {
	first := rows.One()
	if len(first) == 0 {
		return nil
	}
	return first[0]
}

// ColumnIndex returns the position of a column by name, or -1 when there is none.
//
// @param name - the column name to look for
func (rows *Rows) ColumnIndex(name string) int {
	for nth, held := range rows.Columns {
		if held == name {
			return nth
		}
	}
	return -1
}

// Get returns one cell by row index and column name.
//
// @param row - the row index
// @param name - the column name
func (rows *Rows) Get(row int, name string) any {
	column := rows.ColumnIndex(name)
	if column < 0 || row < 0 || row >= len(rows.Values) || column >= len(rows.Values[row]) {
		return nil
	}
	return rows.Values[row][column]
}
