// Runs conformance/suite.json against this client.
//
// The suite is the driver's behaviour written as data rather than as prose, and
// every client library in this repository runs the same file. When two of them
// disagree, one of them is wrong; when they agree, the specification is one that
// can actually be followed.

package inillucent_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	inillucent "github.com/Black-Rainbow-Labs/inillucent-clients/go"
)

// suiteCase is one entry from the shared conformance suite.
type suiteCase struct {
	Name       string            `json:"name"`
	Connection string            `json:"connection"`
	Setup      []string          `json:"setup"`
	Steps      []json.RawMessage `json:"steps"`
}

// suiteFile is the shared conformance suite.
type suiteFile struct {
	Cases []suiteCase `json:"cases"`
}

// valueOf reads a value out of the suite's one key object form.
//
// One key rather than a bare literal, so that NULL and the empty string can never
// be confused by the file itself.
//
// @param described - a value object such as {"int": 7}
func valueOf(t *testing.T, described map[string]json.RawMessage) any {
	t.Helper()
	if _, isNull := described["null"]; isNull {
		return nil
	}
	if raw, ok := described["int"]; ok {
		var whole int64
		if err := json.Unmarshal(raw, &whole); err != nil {
			t.Fatalf("int is not an integer: %v", err)
		}
		return whole
	}
	if raw, ok := described["real"]; ok {
		var number float64
		if err := json.Unmarshal(raw, &number); err != nil {
			t.Fatalf("real is not a number: %v", err)
		}
		return number
	}
	if raw, ok := described["text"]; ok {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			t.Fatalf("text is not a string: %v", err)
		}
		return text
	}
	if raw, ok := described["blob"]; ok {
		var bytes []byte
		if err := json.Unmarshal(raw, &bytes); err != nil {
			t.Fatalf("blob is not a byte array: %v", err)
		}
		return bytes
	}
	t.Fatalf("%v names no value kind", described)
	return nil
}

// same compares an expected value to what came back.
//
// The kinds have to match as well as the contents: an integer and a real are
// different values, and a comparison that let 1 equal 1.0 would hide a client
// that lost the distinction.
func same(want, got any) bool {
	if want == nil || got == nil {
		return want == nil && got == nil
	}
	wantBytes, wantIsBytes := want.([]byte)
	gotBytes, gotIsBytes := got.([]byte)
	if wantIsBytes || gotIsBytes {
		if !wantIsBytes || !gotIsBytes || len(wantBytes) != len(gotBytes) {
			return false
		}
		for nth := range wantBytes {
			if wantBytes[nth] != gotBytes[nth] {
				return false
			}
		}
		return true
	}
	return want == got
}

// shown renders a value for a failure message.
func shown(value any) string {
	if value == nil {
		return "NULL"
	}
	if bytes, isBytes := value.([]byte); isBytes {
		return fmt.Sprintf("%d bytes %v", len(bytes), bytes)
	}
	return fmt.Sprintf("%#v", value)
}

// step is one assertion in a case. It asserts only the keys it carries.
type step struct {
	SQL             string                       `json:"sql"`
	Params          []map[string]json.RawMessage `json:"params"`
	Limit           *uint64                      `json:"limit"`
	Columns         []string                     `json:"columns"`
	Rows            *[][]map[string]json.RawMessage `json:"rows"`
	Affected        json.RawMessage              `json:"affected"`
	Total           *int                         `json:"total"`
	More            *bool                        `json:"more"`
	Status          string                       `json:"status"`
	MessageContains string                       `json:"message_contains"`
	FeatureContains string                       `json:"feature_contains"`
}

// checkRows checks the rows a successful step handed back.
func checkRows(t *testing.T, want [][]map[string]json.RawMessage, rows *inillucent.Rows) []string {
	t.Helper()
	wrong := []string{}
	if len(want) != len(rows.Values) {
		return append(wrong, fmt.Sprintf(
			"there are %d rows and there should be %d", len(rows.Values), len(want)))
	}
	for nth, row := range want {
		got := rows.Values[nth]
		if len(row) != len(got) {
			wrong = append(wrong, fmt.Sprintf(
				"row %d has %d cells and should have %d", nth, len(got), len(row)))
			continue
		}
		for column, cell := range row {
			expected := valueOf(t, cell)
			if !same(expected, got[column]) {
				wrong = append(wrong, fmt.Sprintf(
					"row %d column %d is %s and should be %s",
					nth, column, shown(got[column]), shown(expected)))
			}
		}
	}
	return wrong
}

// checkSuccess checks a step that was expected to succeed.
func checkSuccess(t *testing.T, asserted step, rows *inillucent.Rows) []string {
	t.Helper()
	wrong := []string{}
	if asserted.Status != "" {
		return append(wrong, fmt.Sprintf(
			"expected it to fail with `%s` and it succeeded", asserted.Status))
	}
	if asserted.Columns != nil {
		if len(asserted.Columns) != len(rows.Columns) {
			wrong = append(wrong, fmt.Sprintf(
				"columns are %v and should be %v", rows.Columns, asserted.Columns))
		} else {
			for nth, name := range asserted.Columns {
				if rows.Columns[nth] != name {
					wrong = append(wrong, fmt.Sprintf(
						"columns are %v and should be %v", rows.Columns, asserted.Columns))
					break
				}
			}
		}
	}
	if asserted.Rows != nil {
		wrong = append(wrong, checkRows(t, *asserted.Rows, rows)...)
	}
	if len(asserted.Affected) > 0 {
		if string(asserted.Affected) == "null" {
			if rows.Affected >= 0 {
				wrong = append(wrong, fmt.Sprintf(
					"affected is %d and should be absent, which is what a query reports",
					rows.Affected))
			}
		} else {
			var want int64
			if err := json.Unmarshal(asserted.Affected, &want); err == nil && rows.Affected != want {
				wrong = append(wrong, fmt.Sprintf(
					"affected is %d and should be %d", rows.Affected, want))
			}
		}
	}
	if asserted.Total != nil && rows.Total != *asserted.Total {
		wrong = append(wrong, fmt.Sprintf(
			"total is %d and should be %d, and total is exact, so this is a real "+
				"disagreement rather than an estimate being off", rows.Total, *asserted.Total))
	}
	if asserted.More != nil && rows.More != *asserted.More {
		wrong = append(wrong, fmt.Sprintf("more is %v and should be %v", rows.More, *asserted.More))
	}
	return wrong
}

// checkFailure checks a step that was expected to fail.
func checkFailure(asserted step, err error) []string {
	wrong := []string{}
	var failure *inillucent.Error
	if !errors.As(err, &failure) {
		return append(wrong, fmt.Sprintf("it failed with something that is not an *Error: %v", err))
	}
	if asserted.Status == "" {
		return append(wrong, fmt.Sprintf("it was expected to succeed and it failed: %v", failure))
	}
	if failure.Status.String() != asserted.Status {
		wrong = append(wrong, fmt.Sprintf(
			"it failed with `%s` and should have failed with `%s`, saying: %v",
			failure.Status, asserted.Status, failure))
	}
	if asserted.MessageContains != "" && !contains(failure.Message, asserted.MessageContains) {
		wrong = append(wrong, fmt.Sprintf(
			"the message is %q and should hold %q", failure.Message, asserted.MessageContains))
	}
	if asserted.FeatureContains != "" {
		if failure.Feature == "" {
			wrong = append(wrong, "it named no construct, and an unsupported refusal has to "+
				"name one or an application cannot say what it hit")
		} else if !contains(failure.Feature, asserted.FeatureContains) {
			wrong = append(wrong, fmt.Sprintf(
				"it named %q and should have named something holding %q",
				failure.Feature, asserted.FeatureContains))
		}
	}
	if failure.Status == inillucent.StatusUnsupported {
		if !failure.IsUnsupported() {
			wrong = append(wrong, "an unsupported refusal did not report itself as one")
		}
		if failure.Feature == "" {
			wrong = append(wrong, "an unsupported refusal must carry a feature")
		}
	}
	return wrong
}

// contains reports whether haystack holds needle.
func contains(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for at := 0; at+len(needle) <= len(haystack); at++ {
		if haystack[at:at+len(needle)] == needle {
			return true
		}
	}
	return false
}

// runCase runs one case and returns one line per disagreement.
func runCase(t *testing.T, theCase suiteCase) []string {
	t.Helper()
	path := filepath.Join(t.TempDir(), theCase.Name+".rdb")
	wrong := []string{}

	database, err := inillucent.Open(path)
	if err != nil {
		return append(wrong, fmt.Sprintf("the scratch database did not open: %v", err))
	}
	defer database.Close()
	connection, err := database.Connect()
	if err != nil {
		return append(wrong, fmt.Sprintf("a connection did not open: %v", err))
	}
	defer connection.Close()

	for _, statement := range theCase.Setup {
		if _, err := connection.Exec(statement); err != nil {
			wrong = append(wrong, fmt.Sprintf(
				"the setup statement `%s` was refused: %v", statement, err))
		}
	}
	if len(wrong) > 0 {
		return wrong
	}

	for _, raw := range theCase.Steps {
		var asserted step
		if err := json.Unmarshal(raw, &asserted); err != nil {
			t.Fatalf("a step is not readable: %v", err)
		}
		params := make([]any, 0, len(asserted.Params))
		for _, described := range asserted.Params {
			params = append(params, valueOf(t, described))
		}
		limit := uint64(0)
		if asserted.Limit != nil {
			limit = *asserted.Limit
		}
		rows, err := connection.ExecLimit(asserted.SQL, limit, params...)
		var said []string
		if err != nil {
			said = checkFailure(asserted, err)
		} else {
			said = checkSuccess(t, asserted, rows)
		}
		for _, problem := range said {
			wrong = append(wrong, fmt.Sprintf("`%s`: %s", asserted.SQL, problem))
		}
	}
	return wrong
}

// loadSuite reads the shared conformance suite.
func loadSuite(t *testing.T) suiteFile {
	t.Helper()
	path := filepath.Join("..", "conformance", "suite.json")
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s: %v", path, err)
	}
	var suite suiteFile
	if err := json.Unmarshal(text, &suite); err != nil {
		t.Fatalf("the suite is not valid JSON: %v", err)
	}
	return suite
}

func TestConformanceSuite(t *testing.T) {
	for _, theCase := range loadSuite(t).Cases {
		t.Run(theCase.Name, func(t *testing.T) {
			for _, problem := range runCase(t, theCase) {
				t.Error(problem)
			}
		})
	}
}

func TestCapabilityTableCanBeRead(t *testing.T) {
	// Reading it here also proves the C strings it hands back survive being
	// copied out, which is the rule a binding is most likely to get wrong.
	rows, err := inillucent.Capabilities()
	if err != nil {
		t.Fatalf("the capability table must be readable: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("the engine declares no capabilities at all")
	}
	for _, row := range rows {
		if row.Name == "" {
			t.Error("every capability must have a name")
		}
	}

	cancel, err := inillucent.Supports("cancel")
	if err != nil {
		t.Fatal(err)
	}
	if cancel != inillucent.SupportPartial {
		t.Errorf("cancel is partial: a running statement stops at the next point the executor "+
			"checks, and the engine answered %s", cancel)
	}

	encryption, err := inillucent.Supports("encryption")
	if err != nil {
		t.Fatal(err)
	}
	if encryption != inillucent.SupportYes {
		t.Errorf("the engine declares encryption at rest as supported and answered %s", encryption)
	}

	invented, err := inillucent.Supports("time_travel")
	if err != nil {
		t.Fatal(err)
	}
	if invented != inillucent.SupportUnknown {
		t.Errorf("a capability nobody declared answered %s and must answer unknown: they mean "+
			"different things, and one of them is a checked absence", invented)
	}
}

// filesHold reports whether the database file or any write ahead log file beside
// it contains the text.
//
// @param path - the database file
// @param needle - the text to look for
func filesHold(t *testing.T, path string, needle string) bool {
	t.Helper()
	found := false
	names, err := filepath.Glob(path + "*")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		bytes, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(bytes), needle) {
			found = true
		}
	}
	return found
}

// requireCorrupt fails the test unless opening the database failed as StatusCorrupt.
//
// @param path - the database file
// @param options - the options to try
// @param what - says which attempt this was
func requireCorrupt(t *testing.T, path string, options inillucent.Options, what string) {
	t.Helper()
	database, err := inillucent.OpenWith(path, options)
	if err == nil {
		database.Close()
		t.Fatalf("%s must fail, and it opened", what)
	}
	var failure *inillucent.Error
	if !errors.As(err, &failure) || failure.Status != inillucent.StatusCorrupt {
		t.Fatalf("%s must fail as corrupt (8), and it said: %v", what, err)
	}
}

func TestEncryptedDatabaseKeepsTextOffDiskAndNeedsItsKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "encrypted.rdb")
	key := "x'" + strings.Repeat("5a", 32) + "'"
	otherKey := "x'" + strings.Repeat("6b", 32) + "'"
	secret := "the vault code is 7461"

	database, err := inillucent.OpenWith(path, inillucent.Options{Key: key})
	if err != nil {
		t.Fatalf("a new database must open with a key: %v", err)
	}
	connection, err := database.Connect()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Exec("CREATE TABLE vault (note TEXT)"); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Exec("INSERT INTO vault (note) VALUES (?1)", secret); err != nil {
		t.Fatal(err)
	}
	connection.Close()
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	if filesHold(t, path, secret) {
		t.Fatal("the plaintext appears in the encrypted file or its write ahead log")
	}

	database, err = inillucent.OpenWith(path, inillucent.Options{Key: key})
	if err != nil {
		t.Fatalf("the same key must open the file again: %v", err)
	}
	defer database.Close()
	connection, err = database.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	got, err := connection.Scalar("SELECT note FROM vault")
	if err != nil || got != secret {
		t.Fatalf("the row must read back as %q, got %v (%v)", secret, got, err)
	}
	mode, err := connection.Scalar("PRAGMA encryption")
	if err != nil || mode != "xchacha20-poly1305" {
		t.Fatalf("PRAGMA encryption must answer xchacha20-poly1305, got %v (%v)", mode, err)
	}

	requireCorrupt(t, path, inillucent.Options{}, "opening an encrypted file without a key")
	requireCorrupt(t, path, inillucent.Options{Key: otherKey}, "opening with a different key")
}
