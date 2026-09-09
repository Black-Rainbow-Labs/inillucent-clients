package inillucent

import (
	"fmt"
	"unsafe"
)

// Open flags, as the C ABI takes them.
const (
	openCreate      = 0x0001
	openReadOnly    = 0x0002
	openDiagnostics = 0x0004
)

// Options say how a database file is opened.
type Options struct {
	// NoCreate refuses to make the file when it is not there. The zero value
	// creates it, which is what an application almost always wants.
	NoCreate bool
	// ReadOnly refuses anything but a query.
	ReadOnly bool
	// Diagnostics collects internal diagnostic text on failures. It may hold a
	// file system path or a bound value, so do not show it to a person and do
	// not send it to a shared log.
	Diagnostics bool
}

// flags returns the flags the C ABI takes for these options.
func (options Options) flags() uint32 {
	var flags uint32
	if !options.NoCreate {
		flags |= openCreate
	}
	if options.ReadOnly {
		flags |= openReadOnly
	}
	if options.Diagnostics {
		flags |= openDiagnostics
	}
	return flags
}

// Database is one open database file.
//
// One file is one buffer pool and the engine is single threaded, so keep a
// Database and everything under it on one goroutine, or serialise every call on
// it with a lock of your own. There is no lock inside. Two databases on two
// files are independent.
type Database struct {
	calls  *driverCalls
	handle uintptr
}

// Open opens a database file, creating it when it is not there.
//
// @param path - the database file
func Open(path string) (*Database, error) {
	return OpenWith(path, Options{})
}

// OpenWith opens a database file with explicit options.
//
// @param path - the database file
// @param options - how to open it
func OpenWith(path string, options Options) (*Database, error) {
	calls, err := driver()
	if err != nil {
		return nil, err
	}
	var handle, failure uintptr
	status := calls.open(path, options.flags(), &handle, &failure)
	if err := check(calls, status, failure); err != nil {
		return nil, err
	}
	return &Database{calls: calls, handle: handle}, nil
}

// Connect opens a connection, and with it a session.
func (db *Database) Connect() (*Conn, error) {
	var handle, failure uintptr
	status := db.calls.connect(db.handle, &handle, &failure)
	if err := check(db.calls, status, failure); err != nil {
		return nil, err
	}
	return &Conn{calls: db.calls, database: db, handle: handle}, nil
}

// Path returns the file this database is in.
func (db *Database) Path() string {
	found, _ := goString(db.calls.pathOf(db.handle))
	return found
}

// Checkpoint makes everything written so far durable in the file.
func (db *Database) Checkpoint() error {
	var failure uintptr
	return check(db.calls, db.calls.checkpoint(db.handle, &failure), failure)
}

// IntegrityCheck walks every tree and reports the first thing that is wrong.
func (db *Database) IntegrityCheck() error {
	var failure uintptr
	return check(db.calls, db.calls.integrityCheck(db.handle, &failure), failure)
}

// BackupTo copies the database to a path, opening and checking the copy first.
//
// A backup nobody checked is a file that is assumed to be a database.
//
// @param path - where to write the copy
func (db *Database) BackupTo(path string) error {
	var failure uintptr
	return check(db.calls, db.calls.backupTo(db.handle, path, &failure), failure)
}

// Close checkpoints and closes the database.
//
// The C library refuses to close a database that still has connections on it, so
// close every connection first. Calling Close twice is safe.
func (db *Database) Close() error {
	if db.handle == 0 {
		return nil
	}
	var failure uintptr
	status := db.calls.closeDatabase(db.handle, &failure)
	err := check(db.calls, status, failure)
	if err == nil {
		db.handle = 0
	}
	return err
}

// Conn is one connection to a database, and one session.
//
// Temp tables, ATTACH and the connection pragmas are scoped to the session this
// connection holds, so they last as long as it does.
type Conn struct {
	calls    *driverCalls
	database *Database
	handle   uintptr
}

// Exec runs one statement and returns everything it produced.
//
// Parameters are bound to ?1, ?2 and so on, in order, and are never pasted into
// the text.
//
// @param sql - the statement to run
// @param params - values for ?1, ?2 and so on
func (conn *Conn) Exec(sql string, params ...any) (*Rows, error) {
	return conn.ExecLimit(sql, 0, params...)
}

// ExecLimit runs one statement and hands back at most limit rows.
//
// The limit caps the rows handed back, not the rows produced. Rows.Total is
// exact either way, because the engine materialises and the count was taken
// rather than estimated. A limit of 0 means every row.
//
// @param sql - the statement to run
// @param limit - rows to hand back, or 0 for every row
// @param params - values for ?1, ?2 and so on
func (conn *Conn) ExecLimit(sql string, limit uint64, params ...any) (*Rows, error) {
	capped := noLimit
	if limit > 0 {
		capped = limit
	}
	if len(params) > 0 {
		statement, err := conn.Prepare(sql)
		if err != nil {
			return nil, err
		}
		defer statement.Close()
		return statement.ExecLimit(capped, params...)
	}
	var handle, failure uintptr
	status := conn.calls.execute(conn.handle, sql, capped, &handle, &failure)
	if err := check(conn.calls, status, failure); err != nil {
		return nil, err
	}
	return takeRows(conn.calls, handle), nil
}

// Query runs one statement and returns its rows as maps keyed by column name.
//
// @param sql - the statement to run
// @param params - values for ?1, ?2 and so on
func (conn *Conn) Query(sql string, params ...any) ([]map[string]any, error) {
	rows, err := conn.Exec(sql, params...)
	if err != nil {
		return nil, err
	}
	return rows.Objects(), nil
}

// Scalar runs one statement and returns the first column of its first row.
//
// @param sql - the statement to run
// @param params - values for ?1, ?2 and so on
func (conn *Conn) Scalar(sql string, params ...any) (any, error) {
	rows, err := conn.ExecLimit(sql, 1, params...)
	if err != nil {
		return nil, err
	}
	return rows.Scalar(), nil
}

// ExecBatch runs several statements separated by semicolons, for their effect.
//
// @param sql - the statements to run
func (conn *Conn) ExecBatch(sql string) error {
	var failure uintptr
	return check(conn.calls, conn.calls.executeBatch(conn.handle, sql, &failure), failure)
}

// Prepare compiles a statement so it can be run more than once.
//
// @param sql - the statement to compile
func (conn *Conn) Prepare(sql string) (*Stmt, error) {
	var handle, failure uintptr
	status := conn.calls.prepare(conn.handle, sql, &handle, &failure)
	if err := check(conn.calls, status, failure); err != nil {
		return nil, err
	}
	return &Stmt{calls: conn.calls, connection: conn, handle: handle}, nil
}

// Begin opens a transaction.
func (conn *Conn) Begin() (*Tx, error) {
	var handle, failure uintptr
	status := conn.calls.txnBegin(conn.handle, &handle, &failure)
	if err := check(conn.calls, status, failure); err != nil {
		return nil, err
	}
	return &Tx{calls: conn.calls, handle: handle}, nil
}

// LastInsertRowid returns the rowid the most recent insert on this connection
// produced.
func (conn *Conn) LastInsertRowid() int64 {
	return conn.calls.lastInsertRowid(conn.handle)
}

// TotalChanges returns how many rows every statement on this connection has
// changed.
func (conn *Conn) TotalChanges() int64 {
	return conn.calls.totalChanges(conn.handle)
}

// InTransaction reports whether a transaction is open on this connection.
func (conn *Conn) InTransaction() bool {
	return conn.calls.inTransaction(conn.handle) != 0
}

// SchemaCookie returns the schema's generation, which changes when the schema
// does. Compare it to know whether a cached table description is stale.
func (conn *Conn) SchemaCookie() uint64 {
	return conn.calls.schemaCookie(conn.handle)
}

// Cancel asks a running statement to stop.
//
// It always refuses as unsupported today, and Supports("cancel") says so before
// an application draws a Stop button: the engine runs a statement whole rather
// than a row at a time, so there is no point at which it could notice.
func (conn *Conn) Cancel() error {
	var failure uintptr
	return check(conn.calls, conn.calls.cancel(conn.handle, &failure), failure)
}

// Close frees the connection. Calling it twice is safe.
func (conn *Conn) Close() error {
	if conn.handle == 0 {
		return nil
	}
	conn.calls.connFree(conn.handle)
	conn.handle = 0
	return nil
}

// Stmt is a compiled statement and the values bound to it.
type Stmt struct {
	calls      *driverCalls
	connection *Conn
	handle     uintptr
}

// Exec binds these values, runs the statement, and returns what it produced.
//
// @param params - values for ?1, ?2 and so on, in order
func (stmt *Stmt) Exec(params ...any) (*Rows, error) {
	return stmt.ExecLimit(noLimit, params...)
}

// ExecLimit binds these values, runs the statement, and hands back at most limit
// rows.
//
// @param limit - rows to hand back
// @param params - values for ?1, ?2 and so on, in order
func (stmt *Stmt) ExecLimit(limit uint64, params ...any) (*Rows, error) {
	stmt.calls.clearBindings(stmt.handle)
	for nth, value := range params {
		if err := stmt.Bind(uint32(nth+1), value); err != nil {
			return nil, err
		}
	}
	var handle, failure uintptr
	status := stmt.calls.stmtExecute(stmt.handle, limit, &handle, &failure)
	if err := check(stmt.calls, status, failure); err != nil {
		return nil, err
	}
	return takeRows(stmt.calls, handle), nil
}

// Bind binds one value at a one based parameter position.
//
// @param index - the one based parameter position
// @param value - what to bind
func (stmt *Stmt) Bind(index uint32, value any) error {
	switch held := value.(type) {
	case nil:
		stmt.calls.bindNull(stmt.handle, index)
	case bool:
		whole := int64(0)
		if held {
			whole = 1
		}
		stmt.calls.bindInt(stmt.handle, index, whole)
	case int:
		stmt.calls.bindInt(stmt.handle, index, int64(held))
	case int32:
		stmt.calls.bindInt(stmt.handle, index, int64(held))
	case int64:
		stmt.calls.bindInt(stmt.handle, index, held)
	case uint64:
		stmt.calls.bindInt(stmt.handle, index, int64(held))
	case float32:
		stmt.calls.bindReal(stmt.handle, index, float64(held))
	case float64:
		stmt.calls.bindReal(stmt.handle, index, held)
	case string:
		bytes := []byte(held)
		stmt.calls.bindText(stmt.handle, index, neverNil(bytes), uintptr(len(bytes)))
	case []byte:
		stmt.calls.bindBlob(stmt.handle, index, neverNil(held), uintptr(len(held)))
	default:
		return fmt.Errorf(
			"cannot bind a %T. The engine stores NULL, integers, reals, text and bytes, and "+
				"converting anything else would be this library deciding what your value means",
			value,
		)
	}
	return nil
}

// neverNil returns a pointer that is never nil for the bytes being bound.
//
// The C ABI reads a nil value pointer as NULL, deliberately. An empty string and
// an empty blob are values, not NULL, so an empty slice would otherwise be stored
// as NULL. The length passed alongside stays 0, so the spare byte is never read.
//
// @param bytes - the bytes being bound
func neverNil(bytes []byte) unsafe.Pointer {
	if len(bytes) == 0 {
		spare := [1]byte{}
		return unsafe.Pointer(&spare[0])
	}
	return unsafe.Pointer(&bytes[0])
}

// Close frees the statement. Calling it twice is safe.
func (stmt *Stmt) Close() error {
	if stmt.handle == 0 {
		return nil
	}
	stmt.calls.stmtFree(stmt.handle)
	stmt.handle = 0
	return nil
}

// Tx is one transaction, held open while the caller decides whether to commit.
//
// This is a handle rather than a pair of calls because a check on what a write
// did has to happen before the commit. A postcondition tested afterwards is a
// report about something that has already happened.
type Tx struct {
	calls  *driverCalls
	handle uintptr
	// Affected is how many rows each statement in this transaction changed, in
	// order.
	Affected []uint64
}

// Exec runs one statement inside the transaction and returns the rows it changed.
//
// A failure rolls the whole transaction back before it returns, so a caller that
// stops at the first error has already undone everything.
//
// @param sql - the statement to run
func (tx *Tx) Exec(sql string) (uint64, error) {
	var changed uint64
	var failure uintptr
	status := tx.calls.txnExecute(tx.handle, sql, &changed, &failure)
	if err := check(tx.calls, status, failure); err != nil {
		return 0, err
	}
	tx.Affected = append(tx.Affected, changed)
	return changed, nil
}

// Commit commits the transaction. The handle is spent either way.
func (tx *Tx) Commit() error {
	if tx.handle == 0 {
		return nil
	}
	var failure uintptr
	status := tx.calls.txnCommit(tx.handle, &failure)
	handle := tx.handle
	tx.handle = 0
	err := check(tx.calls, status, failure)
	tx.calls.txnRollback(handle)
	return err
}

// Rollback rolls the transaction back and frees it. Calling it twice is safe,
// which is what makes `defer tx.Rollback()` beside a Commit correct.
func (tx *Tx) Rollback() error {
	if tx.handle == 0 {
		return nil
	}
	tx.calls.txnRollback(tx.handle)
	tx.handle = 0
	return nil
}
