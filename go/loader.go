// Package inillucent is the client for the Inillucent embedded database.
//
// Inillucent is an embedded database written in Rust. There is no server: your
// program opens a file, sends SQL to a library in the same process, and gets
// typed rows back.
//
//	db, err := inillucent.Open("library.rdb")
//	if err != nil {
//	    return err
//	}
//	defer db.Close()
//
//	conn, err := db.Connect()
//	if err != nil {
//	    return err
//	}
//	defer conn.Close()
//
//	if _, err := conn.Exec("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)"); err != nil {
//	    return err
//	}
//	if _, err := conn.Exec("INSERT INTO authors VALUES (?1, ?2)", 1, "Octavia Butler"); err != nil {
//	    return err
//	}
//
//	rows, err := conn.Query("SELECT id, name FROM authors")
//
// The library calls the engine's C ABI through purego, so building it needs no
// C compiler and cgo stays off.
//
// Two things about this engine shape the whole package. Values stay typed:
// nil, int64, float64, string and []byte, with nil meaning NULL rather than an
// empty string. And the engine refuses what it has not built rather than
// answering it wrongly, which arrives as an *Error whose IsUnsupported reports
// it and whose Feature names the construct.
package inillucent

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unsafe"
)

// ABIMajor is the ABI this package was written against. Only the major has to
// match: a minor bump adds symbols, a major bump moves one.
const ABIMajor = 1

// noLimit is the largest limit the C ABI accepts, which is every row.
const noLimit = ^uint64(0)

// libraryNames returns the shared library file names this platform uses.
func libraryNames() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{"inillucent_driver_capi.dll"}
	case "darwin":
		return []string{"libinillucent_driver_capi.dylib"}
	default:
		return []string{"libinillucent_driver_capi.so"}
	}
}

// SearchPaths returns every place the shared library is looked for, in order.
//
// The order is the same in all eight client libraries, so an application that
// works in one works in the rest.
func SearchPaths() []string {
	found := []string{}
	if named := os.Getenv("INILLUCENT_DRIVER_LIB"); named != "" {
		found = append(found, named)
	}
	repo := repositoryRoot()
	engines := []string{
		filepath.Join(repo, "..", "inillucent"),
		filepath.Join(repo, "..", "..", "inillucent"),
	}
	for _, name := range libraryNames() {
		found = append(found, filepath.Join(repo, "native", name))
		for _, engine := range engines {
			for _, profile := range []string{"release", "debug"} {
				found = append(found, filepath.Join(engine, "target", profile, name))
			}
		}
	}
	return found
}

// repositoryRoot returns the clients repository this package was built from.
//
// runtime.Caller gives the source file's own path, which is the only way a Go
// package can find files that sit beside it in a checkout.
func repositoryRoot() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "."
	}
	return filepath.Join(filepath.Dir(file), "..")
}

// resolveLibrary returns the path of the shared library, or an error saying
// where it looked.
//
// A message that names every place it tried is the difference between a problem
// somebody can fix and one they have to guess at.
func resolveLibrary() (string, error) {
	paths := SearchPaths()
	for _, candidate := range paths {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf(
		"cannot find the inillucent driver shared library. Looked in:\n  %s\n"+
			"Build it with\n  cargo build --release --manifest-path <engine>/Cargo.toml "+
			"-p inillucent-driver-capi\nthen run scripts/fetch-native.mjs, or set "+
			"INILLUCENT_DRIVER_LIB to its path",
		strings.Join(paths, "\n  "),
	)
}

// driverCalls holds every symbol this package calls.
//
// Handles cross as uintptr because nothing here ever reads through one, and out
// parameters take a *uintptr, which is Go memory holding no Go pointer and so is
// safe to hand to C.
type driverCalls struct {
	path string

	abiVersion      func() uint32
	version         func() unsafe.Pointer
	capabilityCount func() uintptr
	capability      func(nth uintptr, name *unsafe.Pointer, state *int32, note *unsafe.Pointer) int32
	supports        func(name string) int32

	open           func(path string, flags uint32, out *uintptr, err *uintptr) int32
	closeDatabase  func(db uintptr, err *uintptr) int32
	checkpoint     func(db uintptr, err *uintptr) int32
	integrityCheck func(db uintptr, err *uintptr) int32
	backupTo       func(db uintptr, path string, err *uintptr) int32
	pathOf         func(db uintptr) unsafe.Pointer

	connect         func(db uintptr, out *uintptr, err *uintptr) int32
	connFree        func(conn uintptr)
	execute         func(conn uintptr, sql string, limit uint64, out *uintptr, err *uintptr) int32
	executeBatch    func(conn uintptr, sql string, err *uintptr) int32
	lastInsertRowid func(conn uintptr) int64
	totalChanges    func(conn uintptr) int64
	inTransaction   func(conn uintptr) int32
	schemaCookie    func(conn uintptr) uint64
	cancel          func(conn uintptr, err *uintptr) int32

	prepare       func(conn uintptr, sql string, out *uintptr, err *uintptr) int32
	stmtFree      func(stmt uintptr)
	bindNull      func(stmt uintptr, index uint32) int32
	bindInt       func(stmt uintptr, index uint32, value int64) int32
	bindReal      func(stmt uintptr, index uint32, value float64) int32
	bindText      func(stmt uintptr, index uint32, value unsafe.Pointer, length uintptr) int32
	bindBlob      func(stmt uintptr, index uint32, value unsafe.Pointer, length uintptr) int32
	clearBindings func(stmt uintptr)
	stmtExecute   func(stmt uintptr, limit uint64, out *uintptr, err *uintptr) int32

	rowsFree        func(rows uintptr)
	rowsColumnCount func(rows uintptr) uintptr
	rowsColumnName  func(rows uintptr, nth uintptr) unsafe.Pointer
	rowsColumnType  func(rows uintptr, nth uintptr) unsafe.Pointer
	rowsCount       func(rows uintptr) uintptr
	rowsTotal       func(rows uintptr) uintptr
	rowsMore        func(rows uintptr) int32
	rowsAffected    func(rows uintptr) int64
	rowsElapsedUs   func(rows uintptr) uint64
	rowsTag         func(rows uintptr) unsafe.Pointer
	valueType       func(rows uintptr, row uintptr, column uintptr) int32
	valueInt        func(rows uintptr, row uintptr, column uintptr) int64
	valueReal       func(rows uintptr, row uintptr, column uintptr) float64
	valueBytes      func(rows uintptr, row uintptr, column uintptr, length *uintptr) unsafe.Pointer

	txnBegin    func(conn uintptr, out *uintptr, err *uintptr) int32
	txnExecute  func(txn uintptr, sql string, affected *uint64, err *uintptr) int32
	txnCommit   func(txn uintptr, err *uintptr) int32
	txnRollback func(txn uintptr)

	errorStatus  func(err uintptr) int32
	errorMessage func(err uintptr) unsafe.Pointer
	errorFeature func(err uintptr) unsafe.Pointer
	errorDetail  func(err uintptr) unsafe.Pointer
	errorOffset  func(err uintptr) int32
	errorFree    func(err uintptr)
}

var (
	loadOnce   sync.Once
	loaded     *driverCalls
	loadFailed error
)

// driver returns the loaded driver, loading it the first time it is asked for.
//
// The load is attempted once. A failure is remembered and returned again rather
// than retried, so a missing library does not turn into one message per call.
func driver() (*driverCalls, error) {
	loadOnce.Do(func() {
		loaded, loadFailed = load()
	})
	return loaded, loadFailed
}

// load finds the shared library, opens it, refuses a major ABI mismatch by name,
// and binds every symbol.
func load() (*driverCalls, error) {
	path, err := resolveLibrary()
	if err != nil {
		return nil, err
	}
	handle, err := openLibrary(path)
	if err != nil {
		return nil, fmt.Errorf("cannot load %s: %w", path, err)
	}
	calls := &driverCalls{path: path}
	if err := bindSymbols(calls, handle); err != nil {
		return nil, err
	}
	reported := calls.abiVersion()
	if major := reported / 1_000_000; major != ABIMajor {
		return nil, fmt.Errorf(
			"%s reports ABI %d.%d.%d, and this package was written for ABI %d.x. A major "+
				"bump moves a signature, so calling it would fail in a way nobody can read. "+
				"Install a matching driver",
			path, major, (reported/1000)%1000, reported%1000, ABIMajor,
		)
	}
	return calls, nil
}

// goString copies a C string the library returned into a Go string.
//
// Every string is copied on the way out, because it points inside a handle the
// caller may free. A nil pointer becomes an empty string and a false second
// result, so a caller can tell "absent" from "empty".
//
// The walk uses unsafe.Add rather than pointer arithmetic on a uintptr, which is
// the form that stays correct if the value ever came from Go memory.
func goString(pointer unsafe.Pointer) (string, bool) {
	if pointer == nil {
		return "", false
	}
	length := 0
	for *(*byte)(unsafe.Add(pointer, length)) != 0 {
		length++
	}
	if length == 0 {
		return "", true
	}
	return string(unsafe.Slice((*byte)(pointer), length)), true
}

// goBytes copies length bytes out of a pointer the library returned.
//
// @param pointer - the bytes the library handed back
// @param length - how many bytes to copy
func goBytes(pointer unsafe.Pointer, length uintptr) []byte {
	if pointer == nil || length == 0 {
		return []byte{}
	}
	copied := make([]byte, length)
	copy(copied, unsafe.Slice((*byte)(pointer), length))
	return copied
}
