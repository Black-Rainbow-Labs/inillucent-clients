// A first program: create a table, write rows, read them back, and ask the
// engine what it can do before composing anything unusual.
//
// Run it with `go run ./examples/quickstart`.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	inillucent "github.com/jasonmcaffee/inillucent-clients/go"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run does the work, so every failure has one place to be reported from.
func run() error {
	path := filepath.Join(os.TempDir(), fmt.Sprintf("inillucent-quickstart-%d.rdb", os.Getpid()))
	os.Remove(path)
	defer os.Remove(path)

	database, err := inillucent.Open(path)
	if err != nil {
		return err
	}
	defer database.Close()

	connection, err := database.Connect()
	if err != nil {
		return err
	}
	defer connection.Close()

	version, err := inillucent.Version()
	if err != nil {
		return err
	}
	fmt.Println(version)

	if _, err := connection.Exec(
		"CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)"); err != nil {
		return err
	}
	if _, err := connection.Exec(
		"INSERT INTO authors VALUES (?1, ?2, ?3)", 1, "Octavia Butler", 4.8); err != nil {
		return err
	}
	if _, err := connection.Exec(
		"INSERT INTO authors VALUES (?1, ?2, ?3)", 2, "Ursula Le Guin", nil); err != nil {
		return err
	}

	authors, err := connection.Query("SELECT id, name, rating FROM authors ORDER BY id")
	if err != nil {
		return err
	}
	for _, author := range authors {
		fmt.Println(author["id"], author["name"], author["rating"])
	}

	// The limit caps what is handed back; the total was counted, not estimated.
	page, err := connection.ExecLimit("SELECT id, name FROM authors ORDER BY id", 1)
	if err != nil {
		return err
	}
	more := ""
	if page.More {
		more = ", more to come"
	}
	fmt.Printf("showing %d of %d%s\n", page.Len(), page.Total, more)

	// A transaction is a handle, so what a write did can be checked before commit.
	transaction, err := connection.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	changed, err := transaction.Exec("INSERT INTO authors VALUES (3, 'Ted Chiang', 4.9)")
	if err != nil {
		return err
	}
	if changed == 1 {
		if err := transaction.Commit(); err != nil {
			return err
		}
	}

	count, err := connection.Scalar("SELECT COUNT(*) FROM authors")
	if err != nil {
		return err
	}
	fmt.Println("authors:", count)

	cancel, err := inillucent.Supports("cancel")
	if err != nil {
		return err
	}
	fmt.Println("cancel supported:", cancel == inillucent.SupportYes)

	var refusal *inillucent.Error
	if err := connection.Cancel(); errors.As(err, &refusal) && refusal.IsUnsupported() {
		fmt.Println("cancel refused, and it named:", refusal.Feature)
	} else if err != nil {
		return err
	}

	return nil
}
