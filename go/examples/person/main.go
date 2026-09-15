// Create a person table, insert rows, read them by column name, and update one.
//
// Run it with `go run ./examples/person`.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	inillucent "github.com/Black-Rainbow-Labs/inillucent-clients/go"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run does the work, so every failure has one place to be reported from.
func run() error {
	path := filepath.Join(os.TempDir(), fmt.Sprintf("person-go-%d.rdb", os.Getpid()))
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

	if _, err := connection.Exec(`CREATE TABLE person (
		  id         INTEGER PRIMARY KEY,
		  first_name TEXT NOT NULL,
		  last_name  TEXT NOT NULL,
		  email      TEXT,
		  age        INTEGER,
		  height_m   REAL
		)`); err != nil {
		return err
	}

	// Insert. Values go in as ?1, ?2 and so on, never pasted into the text.
	insert := "INSERT INTO person (first_name, last_name, email, age, height_m) VALUES (?1, ?2, ?3, ?4, ?5)"
	if _, err := connection.Exec(insert, "Ada", "Lovelace", "ada@example.com", 36, 1.65); err != nil {
		return err
	}
	if _, err := connection.Exec(insert, "Grace", "Hopper", nil, 85, 1.57); err != nil {
		return err
	}

	// Read. Query gives a map per row, keyed by column name.
	people, err := connection.Query(
		"SELECT id, first_name, last_name, email, age, height_m FROM person ORDER BY id")
	if err != nil {
		return err
	}
	for _, person := range people {
		fmt.Println(person["id"], person["first_name"], person["last_name"],
			person["email"], person["age"], person["height_m"])
	}

	// One value.
	count, err := connection.Scalar("SELECT COUNT(*) FROM person")
	if err != nil {
		return err
	}
	fmt.Println("people:", count)

	// Update, and read the row back.
	changed, err := connection.Exec(
		"UPDATE person SET email = ?1 WHERE last_name = ?2", "grace@example.com", "Hopper")
	if err != nil {
		return err
	}
	fmt.Println("updated:", changed.Affected)

	email, err := connection.Scalar("SELECT email FROM person WHERE last_name = ?1", "Hopper")
	if err != nil {
		return err
	}
	fmt.Println("email now:", email)
	return nil
}
