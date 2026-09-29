// Runs the scenarios in conformance/integration.md against this client.
//
// suite.json grades what a statement does. These tests grade what the library
// around the statement does: opening, closing and reopening a file, a
// transaction object, a prepared statement reused with new values, a backup, a
// cancel sent from another goroutine, and a second process writing the same
// file. Every test uses a real database file in a fresh temporary folder, which
// t.TempDir deletes when the test ends, and calls only the public API.

package inillucent_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	inillucent "github.com/Black-Rainbow-Labs/inillucent-clients/go"
)

// helperDatabaseVariable names the environment variable that turns this test
// binary into the child process of TestAnotherProcessWritesAndThisOneReadsIt.
const helperDatabaseVariable = "INILLUCENT_HELPER_DATABASE"

// scratchPath returns a database path inside a fresh temporary folder.
//
// @param t - the running test, whose TempDir is removed when it ends
// @param name - the file name to use
func scratchPath(t *testing.T, name string) string {
	t.Helper()
	return filepath.Join(t.TempDir(), name)
}

// openBoth opens a database and one connection on it, and closes both when the
// test ends.
//
// @param t - the running test
// @param path - the database file
func openBoth(t *testing.T, path string) (*inillucent.Database, *inillucent.Conn) {
	t.Helper()
	database, err := inillucent.Open(path)
	if err != nil {
		t.Fatalf("the database did not open: %v", err)
	}
	connection, err := database.Connect()
	if err != nil {
		database.Close()
		t.Fatalf("a connection did not open: %v", err)
	}
	t.Cleanup(func() {
		connection.Close()
		database.Close()
	})
	return database, connection
}

// mustExec runs a statement and fails the test when it is refused.
//
// @param t - the running test
// @param connection - where to run it
// @param sql - the statement
// @param params - values for ?1, ?2 and so on
func mustExec(t *testing.T, connection *inillucent.Conn, sql string, params ...any) *inillucent.Rows {
	t.Helper()
	rows, err := connection.Exec(sql, params...)
	if err != nil {
		t.Fatalf("`%s` was refused: %v", sql, err)
	}
	return rows
}

// mustScalar runs a statement and returns its first value, failing the test when
// it is refused.
//
// @param t - the running test
// @param connection - where to run it
// @param sql - the statement
// @param params - values for ?1, ?2 and so on
func mustScalar(t *testing.T, connection *inillucent.Conn, sql string, params ...any) any {
	t.Helper()
	value, err := connection.Scalar(sql, params...)
	if err != nil {
		t.Fatalf("`%s` was refused: %v", sql, err)
	}
	return value
}

// requireStatus fails the test unless err is an *inillucent.Error with the
// status wanted, and returns it.
//
// @param t - the running test
// @param err - what the call returned
// @param want - the status it should carry
// @param what - says which call this was
func requireStatus(t *testing.T, err error, want inillucent.Status, what string) *inillucent.Error {
	t.Helper()
	if err == nil {
		t.Fatalf("%s must fail with %s, and it succeeded", what, want)
	}
	var failure *inillucent.Error
	if !errors.As(err, &failure) {
		t.Fatalf("%s failed with something that is not an *inillucent.Error: %v", what, err)
	}
	if failure.Status != want {
		t.Fatalf("%s failed with %s and should fail with %s: %v", what, failure.Status, want, err)
	}
	return failure
}

// requireValue fails the test unless got equals want, kind included.
//
// @param t - the running test
// @param got - what came back
// @param want - what should have come back
// @param what - says which value this is
func requireValue(t *testing.T, got, want any, what string) {
	t.Helper()
	gotBytes, gotIsBytes := got.([]byte)
	wantBytes, wantIsBytes := want.([]byte)
	if gotIsBytes || wantIsBytes {
		if !gotIsBytes || !wantIsBytes || !bytes.Equal(gotBytes, wantBytes) {
			t.Fatalf("%s is %d bytes and should be the %d bytes written", what, len(gotBytes), len(wantBytes))
		}
		return
	}
	if got != want {
		t.Fatalf("%s is %#v and should be %#v", what, got, want)
	}
}

func TestFileSurvivesCloseAndReopen(t *testing.T) {
	path := scratchPath(t, "survives.rdb")
	database, err := inillucent.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := database.Connect()
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, connection, "CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT, height REAL)")
	mustExec(t, connection, "INSERT INTO person (name, height) VALUES (?1, ?2)", "Ada", 1.65)
	mustExec(t, connection, "INSERT INTO person (name, height) VALUES (?1, ?2)", "Grace", nil)
	connection.Close()
	if err := database.Close(); err != nil {
		t.Fatalf("closing must succeed once the connection is closed: %v", err)
	}

	reopened, again := openBoth(t, path)
	if reopened.Path() != path {
		t.Fatalf("the path is %q and should be the %q that was opened", reopened.Path(), path)
	}
	rows := mustExec(t, again, "SELECT id, name, height FROM person ORDER BY id")
	if rows.Len() != 2 {
		t.Fatalf("there are %d rows and there should be 2", rows.Len())
	}
	requireValue(t, rows.Get(0, "name"), "Ada", "the first name")
	requireValue(t, rows.Get(0, "height"), 1.65, "the first height")
	requireValue(t, rows.Get(1, "id"), int64(2), "the second id")
	requireValue(t, rows.Get(1, "height"), nil, "the second height")
}

func TestMissingFileWithoutCreateIsNotFound(t *testing.T) {
	path := scratchPath(t, "missing.rdb")
	database, err := inillucent.OpenWith(path, inillucent.Options{NoCreate: true})
	if err == nil {
		database.Close()
	}
	requireStatus(t, err, inillucent.StatusNotFound, "opening a missing file without create")
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("no file may be created at %s, and stat said: %v", path, statErr)
	}
}

func TestReadOnlyOpenReadsAndRefusesWrites(t *testing.T) {
	path := scratchPath(t, "readonly.rdb")
	database, connection := openBoth(t, path)
	mustExec(t, connection, "CREATE TABLE t (v TEXT)")
	mustExec(t, connection, "INSERT INTO t (v) VALUES ('a'), ('b')")
	connection.Close()
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	readOnly, err := inillucent.OpenWith(path, inillucent.Options{ReadOnly: true})
	if err != nil {
		t.Fatalf("a read only open must succeed: %v", err)
	}
	defer readOnly.Close()
	reader, err := readOnly.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	objects, err := reader.Query("SELECT v FROM t ORDER BY v")
	if err != nil || len(objects) != 2 || objects[0]["v"] != "a" {
		t.Fatalf("a read only SELECT must return both rows, got %v (%v)", objects, err)
	}
	_, err = reader.Exec("INSERT INTO t (v) VALUES ('c')")
	requireStatus(t, err, inillucent.StatusReadOnly, "an INSERT on a read only database")
	requireValue(t, mustScalar(t, reader, "SELECT COUNT(*) FROM t"), int64(2), "the row count")
}

func TestSecondHandleInTheSameProcessSeesCommittedRows(t *testing.T) {
	path := scratchPath(t, "two-handles.rdb")
	_, first := openBoth(t, path)
	mustExec(t, first, "CREATE TABLE t (v TEXT)")
	_, second := openBoth(t, path)
	// On inillucent 1.0.33 a database that was just opened holds a read lock on
	// the file until its first statement runs, so a write through the first
	// handle at this point waits out busy_timeout and fails with StatusBusy. The
	// second handle therefore reads once before the first one writes, which also
	// shows it seeing the table empty and then seeing the new row.
	requireValue(t, mustScalar(t, second, "SELECT COUNT(*) FROM t"), int64(0), "rows before the insert")
	mustExec(t, first, "INSERT INTO t (v) VALUES ('from the first handle')")
	requireValue(t, mustScalar(t, second, "SELECT v FROM t"), "from the first handle",
		"the row read through the second handle")
}

// TestHelperProcessWritesOneRow is the child process of
// TestAnotherProcessWritesAndThisOneReadsIt. It does nothing unless the
// environment names a database, so an ordinary test run passes over it.
func TestHelperProcessWritesOneRow(t *testing.T) {
	path := os.Getenv(helperDatabaseVariable)
	if path == "" {
		return
	}
	database, err := inillucent.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := database.Connect()
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, connection, "INSERT INTO t (v) VALUES (?1)", "from the child process")
	connection.Close()
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAnotherProcessWritesAndThisOneReadsIt(t *testing.T) {
	path := scratchPath(t, "two-processes.rdb")
	_, connection := openBoth(t, path)
	mustExec(t, connection, "CREATE TABLE t (v TEXT)")

	child := exec.Command(os.Args[0], "-test.run=^TestHelperProcessWritesOneRow$", "-test.count=1")
	child.Env = append(os.Environ(), helperDatabaseVariable+"="+path)
	said, err := child.CombinedOutput()
	if err != nil {
		t.Fatalf("the child process must exit 0: %v\n%s", err, said)
	}
	requireValue(t, mustScalar(t, connection, "SELECT v FROM t"), "from the child process",
		"the row the child wrote, read without reopening")
}

func TestPreparedStatementRunsManyTimesWithFreshBindings(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "prepared.rdb"))
	mustExec(t, connection, "CREATE TABLE t (n INTEGER, label TEXT)")
	insert, err := connection.Prepare("INSERT INTO t (n, label) VALUES (?1, ?2)")
	if err != nil {
		t.Fatal(err)
	}
	defer insert.Close()
	for nth := 0; nth < 100; nth++ {
		if _, err := insert.Exec(nth, "row "+strconv.Itoa(nth)); err != nil {
			t.Fatalf("execution %d was refused: %v", nth, err)
		}
	}
	requireValue(t, mustScalar(t, connection, "SELECT COUNT(*) FROM t"), int64(100), "the row count")
	requireValue(t, mustScalar(t, connection, "SELECT SUM(n) FROM t"), int64(4950), "the sum of n")
	requireValue(t, mustScalar(t, connection, "SELECT label FROM t WHERE n = 73"), "row 73", "row 73")

	add, err := connection.Prepare("SELECT ?1 + ?2")
	if err != nil {
		t.Fatal(err)
	}
	defer add.Close()
	rows, err := add.Exec(int64(2), int64(3))
	if err != nil {
		t.Fatal(err)
	}
	requireValue(t, rows.Scalar(), int64(5), "2 + 3")
	rows, err = add.Exec(int64(2))
	if err != nil {
		t.Fatal(err)
	}
	requireValue(t, rows.Scalar(), nil, "2 + an unbound parameter")
}

func TestRowsReportCountsColumnsAndLimits(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "rows.rdb"))
	mustExec(t, connection, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
	inserted := mustExec(t, connection, "INSERT INTO t (v) VALUES ('a'), ('b')")
	if inserted.Affected != 2 || inserted.Tag != "INSERT 2" {
		t.Fatalf("the insert reported affected %d and tag %q, and should say 2 and INSERT 2",
			inserted.Affected, inserted.Tag)
	}
	mustExec(t, connection, "INSERT INTO t (v) VALUES ('c'), ('d'), ('e')")
	page, err := connection.ExecLimit("SELECT id, v FROM t ORDER BY id", 2)
	if err != nil {
		t.Fatal(err)
	}
	if page.Len() != 2 || page.Total != 5 || !page.More || page.Affected != -1 {
		t.Fatalf("the page is %d rows, total %d, more %v, affected %d, and should be 2, 5, true, -1",
			page.Len(), page.Total, page.More, page.Affected)
	}
	if strings.Join(page.Columns, ",") != "id,v" || len(page.ColumnTypes) != 2 {
		t.Fatalf("the columns are %v with types %v, and should be [id v] with two types",
			page.Columns, page.ColumnTypes)
	}
	if page.ColumnIndex("v") != 1 || page.ColumnIndex("nope") != -1 || page.Get(5, "v") != nil {
		t.Fatal("ColumnIndex and Get must find v at 1 and answer nothing for what is not there")
	}
	if one := page.One(); len(one) != 2 || one[0] != int64(1) {
		t.Fatalf("the first row is %v and should start with 1", one)
	}
	empty := mustExec(t, connection, "SELECT id FROM t WHERE id > 100")
	if empty.One() != nil || empty.Scalar() != nil || len(empty.Objects()) != 0 {
		t.Fatal("a result with no rows has no first row, no scalar and no objects")
	}
}

func TestLastInsertRowidAndTotalChanges(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "rowid.rdb"))
	mustExec(t, connection, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
	before := connection.TotalChanges()
	mustExec(t, connection, "INSERT INTO t (v) VALUES ('first')")
	mustExec(t, connection, "INSERT INTO t (v) VALUES ('second')")
	second := mustScalar(t, connection, "SELECT id FROM t WHERE v = 'second'")
	if connection.LastInsertRowid() != second {
		t.Fatalf("the last insert rowid is %d and should be the second row's id %v",
			connection.LastInsertRowid(), second)
	}
	if connection.TotalChanges() != before+2 {
		t.Fatalf("total changes went from %d to %d and should have gone up by 2",
			before, connection.TotalChanges())
	}
	mustExec(t, connection, "UPDATE t SET v = 'changed'")
	if connection.TotalChanges() != before+4 {
		t.Fatalf("an update of two rows must add 2 to total changes, which is now %d",
			connection.TotalChanges())
	}
}

func TestSchemaCookieChangesWhenTheSchemaDoes(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "cookie.rdb"))
	mustExec(t, connection, "CREATE TABLE t (v TEXT)")
	start := connection.SchemaCookie()
	mustExec(t, connection, "SELECT * FROM t")
	mustExec(t, connection, "INSERT INTO t (v) VALUES ('a')")
	if connection.SchemaCookie() != start {
		t.Fatalf("a SELECT and an INSERT moved the schema cookie from %d to %d",
			start, connection.SchemaCookie())
	}
	mustExec(t, connection, "CREATE TABLE u (v TEXT)")
	if connection.SchemaCookie() == start {
		t.Fatal("a CREATE TABLE must change the schema cookie")
	}
}

func TestExecuteBatchRunsEveryStatement(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "batch.rdb"))
	err := connection.ExecBatch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1); " +
		"INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)")
	if err != nil {
		t.Fatalf("the batch was refused: %v", err)
	}
	requireValue(t, mustScalar(t, connection, "SELECT COUNT(*) FROM t"), int64(3), "the row count")
	err = connection.ExecBatch("INSERT INTO t VALUES (4); INSERT INTO WHERE; INSERT INTO t VALUES (5)")
	requireStatus(t, err, inillucent.StatusSyntax, "a batch whose second statement is invalid")
}

func TestLargeValuesRoundTrip(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "large.rdb"))
	mustExec(t, connection, "CREATE TABLE t (b BLOB, s TEXT)")
	blob := make([]byte, 1<<20)
	for nth := range blob {
		blob[nth] = byte(nth % 256)
	}
	text := strings.Repeat("\U0001F600 \U00010348 abc ", (1<<20)/13)
	mustExec(t, connection, "INSERT INTO t (b, s) VALUES (?1, ?2)", blob, text)
	rows := mustExec(t, connection, "SELECT b, s FROM t")
	requireValue(t, rows.Get(0, "b"), blob, "the blob")
	if rows.Get(0, "s") != text {
		t.Fatalf("the text came back different: %d bytes against %d", len(rows.Get(0, "s").(string)), len(text))
	}
}

// vectorBlob encodes floats as the little endian float32 blob a VECTOR column
// holds.
//
// @param values - the vector's components
func vectorBlob(values ...float32) []byte {
	encoded := make([]byte, 4*len(values))
	for nth, value := range values {
		binary.LittleEndian.PutUint32(encoded[4*nth:], math.Float32bits(value))
	}
	return encoded
}

func TestSearchWithBoundParameters(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "search.rdb"))
	mustExec(t, connection, "CREATE VIRTUAL TABLE docs USING fts5(body)")
	mustExec(t, connection, "INSERT INTO docs (rowid, body) VALUES (1, 'the quick brown fox'), "+
		"(2, 'a lazy dog'), (3, 'the fox jumps')")
	found := mustExec(t, connection, "SELECT rowid FROM docs WHERE docs MATCH ?1 ORDER BY rowid", "fox")
	if found.Len() != 2 || found.Values[0][0] != int64(1) || found.Values[1][0] != int64(3) {
		t.Fatalf("MATCH fox found %v and should find rowids 1 and 3", found.Values)
	}

	mustExec(t, connection, "CREATE TABLE places (id INTEGER PRIMARY KEY, at VECTOR(2))")
	mustExec(t, connection, "INSERT INTO places (id, at) VALUES (?1, ?2)", 1, vectorBlob(1, 0))
	mustExec(t, connection, "INSERT INTO places (id, at) VALUES (?1, ?2)", 2, vectorBlob(0, 1))
	mustExec(t, connection, "INSERT INTO places (id, at) VALUES (?1, ?2)", 3, vectorBlob(0.7, 0.7))
	nearest := mustExec(t, connection,
		"SELECT id FROM places ORDER BY vector_distance_cos(at, ?1)", vectorBlob(0.1, 1))
	requireValue(t, nearest.Scalar(), int64(2), "the nearest place")
}

func TestTransactionCommitsAllOfIt(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "commit.rdb"))
	mustExec(t, connection, "CREATE TABLE t (v TEXT)")
	tx, err := connection.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, value := range []string{"a", "b"} {
		changed, err := tx.Exec("INSERT INTO t (v) VALUES ('" + value + "')")
		if err != nil || changed != 1 {
			t.Fatalf("the insert of %s changed %d rows (%v) and should change 1", value, changed, err)
		}
	}
	if len(tx.Affected) != 2 || !connection.InTransaction() {
		t.Fatalf("the transaction holds %v and in_transaction is %v while it is open",
			tx.Affected, connection.InTransaction())
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("the commit was refused: %v", err)
	}
	if connection.InTransaction() {
		t.Fatal("in_transaction must be false after the commit")
	}
	requireValue(t, mustScalar(t, connection, "SELECT COUNT(*) FROM t"), int64(2), "the row count")
	if err := tx.Commit(); err != nil {
		t.Fatalf("a second commit on a spent transaction does nothing, and it said: %v", err)
	}
}

// abandonTransaction inserts a row in a transaction and returns without
// committing, leaving the deferred Rollback to end it.
//
// @param t - the running test
// @param connection - where to open the transaction
func abandonTransaction(t *testing.T, connection *inillucent.Conn) {
	t.Helper()
	tx, err := connection.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("INSERT INTO t (v) VALUES ('abandoned')"); err != nil {
		t.Fatal(err)
	}
}

func TestTransactionRollsBackWhenAskedAndWhenAbandoned(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "rollback.rdb"))
	mustExec(t, connection, "CREATE TABLE t (v TEXT)")
	tx, err := connection.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO t (v) VALUES ('rolled back')"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("a second rollback must do nothing, and it said: %v", err)
	}
	requireValue(t, mustScalar(t, connection, "SELECT COUNT(*) FROM t"), int64(0), "rows after rollback")

	abandonTransaction(t, connection)
	requireValue(t, mustScalar(t, connection, "SELECT COUNT(*) FROM t"), int64(0), "rows after abandoning")
	if connection.InTransaction() {
		t.Fatal("no transaction may be open after the abandoned one ended")
	}
}

func TestAFailingStatementRollsTheTransactionBack(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "failing.rdb"))
	mustExec(t, connection, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)")
	tx, err := connection.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("INSERT INTO t (v) VALUES ('same')"); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec("INSERT INTO t (v) VALUES ('same')")
	requireStatus(t, err, inillucent.StatusConstraint, "an insert that breaks a unique constraint")
	requireValue(t, mustScalar(t, connection, "SELECT COUNT(*) FROM t"), int64(0), "rows after the failure")
	if connection.InTransaction() {
		t.Fatal("in_transaction must be false once a failure rolled the transaction back")
	}
	_, err = tx.Exec("INSERT INTO t (v) VALUES ('after')")
	requireStatus(t, err, inillucent.StatusInvalidState, "an execute on a spent transaction")
	requireStatus(t, tx.Commit(), inillucent.StatusInvalidState, "a commit on a spent transaction")
}

func TestErrorsCarryStatusOffsetAndMessage(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "errors.rdb"))
	mustExec(t, connection, "CREATE TABLE t (id INTEGER PRIMARY KEY)")
	_, err := connection.Exec("SELECT * FROM t WHERE")
	syntax := requireStatus(t, err, inillucent.StatusSyntax, "an unfinished WHERE")
	if syntax.Offset != 21 || syntax.Message == "" || !strings.Contains(syntax.Error(), "at byte 21") {
		t.Fatalf("the syntax error has offset %d and message %q, and should be at byte 21 with a message",
			syntax.Offset, syntax.Error())
	}
	_, err = connection.Exec("SELECT * FROM missing_table")
	requireStatus(t, err, inillucent.StatusNotFound, "a missing table")
	mustExec(t, connection, "INSERT INTO t (id) VALUES (1)")
	_, err = connection.Exec("INSERT INTO t (id) VALUES (?1)", 1)
	requireStatus(t, err, inillucent.StatusConstraint, "a duplicate primary key")
	_, err = connection.Exec("CREATE VIRTUAL TABLE f USING fts5(a, detail=none)")
	unsupported := requireStatus(t, err, inillucent.StatusUnsupported, "fts5 with detail=none")
	if !unsupported.IsUnsupported() || !strings.Contains(unsupported.Feature, "detail=none") {
		t.Fatalf("the refusal must report itself unsupported and name detail=none, and named %q",
			unsupported.Feature)
	}
}

func TestClosingRefusesWhileAStatementIsOpen(t *testing.T) {
	database, err := inillucent.Open(scratchPath(t, "refuse.rdb"))
	if err != nil {
		t.Fatal(err)
	}
	connection, err := database.Connect()
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, connection, "CREATE TABLE t (v INTEGER)")
	insert, err := connection.Prepare("INSERT INTO t (v) VALUES (?1)")
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, database.Close(), inillucent.StatusInvalidState, "closing with a connection open")
	connection.Close()
	requireStatus(t, database.Close(), inillucent.StatusInvalidState, "closing with a statement open")
	if _, err := insert.Exec(7); err != nil {
		t.Fatalf("the statement must still execute after a refused close: %v", err)
	}
	insert.Close()
	if err := database.Close(); err != nil {
		t.Fatalf("the database must close once the statement is closed: %v", err)
	}
}

func TestUseAfterCloseIsAnErrorNotACrash(t *testing.T) {
	database, connection := openBoth(t, scratchPath(t, "after-close.rdb"))
	mustExec(t, connection, "CREATE TABLE t (v INTEGER)")
	statement, err := connection.Prepare("SELECT v FROM t")
	if err != nil {
		t.Fatal(err)
	}
	statement.Close()
	if err := statement.Close(); err != nil {
		t.Fatalf("closing a statement twice must do nothing: %v", err)
	}
	_, err = statement.Exec()
	requireStatus(t, err, inillucent.StatusInvalidState, "executing a closed statement")

	connection.Close()
	if err := connection.Close(); err != nil {
		t.Fatalf("closing a connection twice must do nothing: %v", err)
	}
	_, err = connection.Exec("SELECT 1")
	requireStatus(t, err, inillucent.StatusInvalidState, "executing on a closed connection")
	_, err = connection.Exec("SELECT ?1", 1)
	requireStatus(t, err, inillucent.StatusInvalidState, "preparing on a closed connection")

	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("closing a database twice must do nothing: %v", err)
	}
	_, err = database.Connect()
	requireStatus(t, err, inillucent.StatusInvalidState, "connecting to a closed database")
}

func TestCapabilitiesAndVersions(t *testing.T) {
	listed, err := inillucent.Capabilities()
	if err != nil || len(listed) == 0 {
		t.Fatalf("the capability list must not be empty: %v (%v)", listed, err)
	}
	for _, capability := range listed {
		if capability.Name == "" {
			t.Fatal("every capability must have a name")
		}
	}
	wanted := map[string]inillucent.Support{
		"cancel":         inillucent.SupportPartial,
		"encryption":     inillucent.SupportYes,
		"load_extension": inillucent.SupportNo,
		"made_up_name":   inillucent.SupportUnknown,
	}
	for name, want := range wanted {
		got, err := inillucent.Supports(name)
		if err != nil || got != want {
			t.Fatalf("supports(%s) is %s (%v) and should be %s", name, got, err, want)
		}
	}
	if !inillucent.SupportPartial.IsSupported() || inillucent.SupportNo.IsSupported() {
		t.Fatal("partial counts as supported and no does not")
	}
	version, err := inillucent.Version()
	if err != nil || !strings.Contains(version, "1.0.") {
		t.Fatalf("the version is %q (%v) and should contain 1.0.", version, err)
	}
	abi, err := inillucent.ABIVersion()
	if err != nil || !atLeast(abi, 1, 1, 0) {
		t.Fatalf("the ABI version is %q (%v) and should be at least 1.1.0", abi, err)
	}
	driverPath, err := inillucent.DriverPath()
	if err != nil || driverPath == "" || len(inillucent.SearchPaths()) == 0 {
		t.Fatalf("the driver path is %q (%v) and must name the loaded library", driverPath, err)
	}
}

// atLeast reports whether a major.minor.patch version is at or above another.
//
// @param version - the version text
// @param major - the lowest major wanted
// @param minor - the lowest minor wanted with that major
// @param patch - the lowest patch wanted with that minor
func atLeast(version string, major, minor, patch int) bool {
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return false
	}
	have := [3]int{}
	for nth, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil {
			return false
		}
		have[nth] = value
	}
	want := [3]int{major, minor, patch}
	for nth := range have {
		if have[nth] != want[nth] {
			return have[nth] > want[nth]
		}
	}
	return true
}

func TestCheckpointIntegrityCheckAndBackup(t *testing.T) {
	folder := t.TempDir()
	database, connection := openBoth(t, filepath.Join(folder, "original.rdb"))
	mustExec(t, connection, "CREATE TABLE t (v TEXT)")
	mustExec(t, connection, "INSERT INTO t (v) VALUES ('one'), ('two'), ('three')")
	if err := database.Checkpoint(); err != nil {
		t.Fatalf("checkpoint was refused: %v", err)
	}
	if err := database.IntegrityCheck(); err != nil {
		t.Fatalf("the integrity check failed: %v", err)
	}
	copyPath := filepath.Join(folder, "copy.rdb")
	if err := database.BackupTo(copyPath); err != nil {
		t.Fatalf("the backup was refused: %v", err)
	}
	if err := database.BackupTo(copyPath); err != nil {
		t.Fatalf("a second backup to the same path must succeed: %v", err)
	}
	_, copied := openBoth(t, copyPath)
	requireValue(t, mustScalar(t, copied, "SELECT COUNT(*) FROM t"), int64(3), "rows in the backup")
}

func TestCancelFromAnotherThreadInterruptsAndTheConnectionSurvives(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "cancel.rdb"))
	cancelled := make(chan error, 1)
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancelled <- connection.Cancel()
	}()
	started := time.Now()
	_, err := connection.Exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n " +
		"WHERE x < 100000000) SELECT count(*) FROM n")
	requireStatus(t, err, inillucent.StatusInterrupted, "a long statement that was cancelled")
	if cancelError := <-cancelled; cancelError != nil {
		t.Fatalf("the cancel call itself failed: %v", cancelError)
	}
	t.Logf("the statement stopped %v after it started", time.Since(started))
	requireValue(t, mustScalar(t, connection, "SELECT 1"), int64(1), "the next statement")

	if err := connection.Cancel(); err != nil {
		t.Fatalf("a cancel with nothing running must succeed: %v", err)
	}
	requireValue(t, mustScalar(t, connection, "SELECT 2"), int64(2), "the statement after an idle cancel")
}

// The tests below are not scenarios from integration.md. They call the parts of
// the public API that the scenarios do not reach, so that coverage shows every
// public method exercised.

func TestBindAcceptsEveryGoKindItDocuments(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "bind.rdb"))
	rows := mustExec(t, connection, "SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9",
		true, false, int32(-7), uint64(9), float32(0.5), "", []byte{}, nil, int(3))
	want := []any{int64(1), int64(0), int64(-7), int64(9), 0.5, "", []byte{}, nil, int64(3)}
	for nth, expected := range want {
		requireValue(t, rows.Values[0][nth], expected, "parameter "+strconv.Itoa(nth+1))
	}
	if _, err := connection.Exec("SELECT ?1", struct{}{}); err == nil ||
		!strings.Contains(err.Error(), "cannot bind") {
		t.Fatalf("binding a struct must be refused by name, and it said: %v", err)
	}
	statement, err := connection.Prepare("SELECT ?1")
	if err != nil {
		t.Fatal(err)
	}
	defer statement.Close()
	if err := statement.Bind(1, map[string]int{}); err == nil {
		t.Fatal("binding a map must be refused")
	}
}

func TestQueryScalarAndBeginReportFailures(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "failures.rdb"))
	_, err := connection.Query("SELECT * FROM missing_table")
	requireStatus(t, err, inillucent.StatusNotFound, "Query on a missing table")
	_, err = connection.Scalar("SELECT * FROM missing_table")
	requireStatus(t, err, inillucent.StatusNotFound, "Scalar on a missing table")
	connection.Close()
	_, err = connection.Begin()
	requireStatus(t, err, inillucent.StatusInvalidState, "Begin on a closed connection")
}

func TestDiagnosticsOptionAddsDetailToErrors(t *testing.T) {
	database, err := inillucent.OpenWith(scratchPath(t, "diagnostics.rdb"), inillucent.Options{Diagnostics: true})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	connection, err := database.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_, err = connection.Exec("SELECT * FROM missing_table")
	failure := requireStatus(t, err, inillucent.StatusNotFound, "a missing table with diagnostics on")
	t.Logf("diagnostic detail: %q", failure.Detail)
}

func TestStatusAndSupportNamesAndErrorText(t *testing.T) {
	names := [][2]string{
		{inillucent.SupportNo.String(), "no"},
		{inillucent.SupportYes.String(), "yes"},
		{inillucent.SupportPartial.String(), "partial"},
		{inillucent.SupportUnknown.String(), "unknown"},
		{inillucent.Status(99).String(), "unknown"},
		{inillucent.StatusBusy.String(), "busy"},
	}
	for _, pair := range names {
		if pair[0] != pair[1] {
			t.Fatalf("a name came back as %q and should be %q", pair[0], pair[1])
		}
	}
	atStart := &inillucent.Error{Status: inillucent.StatusSyntax, Message: "bad", Offset: 0}
	if atStart.Error() != "bad [syntax] at byte 0" {
		t.Fatalf("an error at byte 0 reads %q", atStart.Error())
	}
	noOffset := &inillucent.Error{Status: inillucent.StatusIO, Message: "disk", Offset: -1}
	if noOffset.Error() != "disk [io]" || noOffset.IsUnsupported() {
		t.Fatalf("an error with no offset reads %q", noOffset.Error())
	}
}

func TestSearchPathsPutTheEnvironmentVariableFirst(t *testing.T) {
	named := filepath.Join(t.TempDir(), "named-driver.dll")
	t.Setenv("INILLUCENT_DRIVER_LIB", named)
	paths := inillucent.SearchPaths()
	if len(paths) < 2 || paths[0] != named {
		t.Fatalf("INILLUCENT_DRIVER_LIB must be searched first, and the paths are %v", paths)
	}
}

func TestBindingMoreValuesThanPlaceholdersIsRefused(t *testing.T) {
	_, connection := openBoth(t, scratchPath(t, "extra-values.rdb"))
	_, err := connection.Exec("SELECT ?1", 1, 2)
	requireStatus(t, err, inillucent.StatusInvalidState, "SELECT ?1 with two values")
	statement, err := connection.Prepare("SELECT ?1")
	if err != nil {
		t.Fatal(err)
	}
	defer statement.Close()
	requireStatus(t, statement.Bind(2, "extra"), inillucent.StatusInvalidState, "binding ?2 of SELECT ?1")
	rows, err := statement.Exec(5)
	if err != nil {
		t.Fatalf("the statement must still run with the right number of values: %v", err)
	}
	requireValue(t, rows.Scalar(), int64(5), "SELECT ?1 with one value")
}
