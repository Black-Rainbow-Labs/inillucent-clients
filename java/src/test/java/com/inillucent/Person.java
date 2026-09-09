package com.inillucent;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Create a person table, insert rows, read them by column name, and update one.
 */
public final class Person {

    private Person() {
    }

    /**
     * Runs the example against a scratch database.
     *
     * @param args - unused
     */
    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("person-java-");
        Path path = directory.resolve("person.rdb");

        try (Database database = Database.open(path);
             Connection connection = database.connect()) {

            connection.execute("""
                CREATE TABLE person (
                  id         INTEGER PRIMARY KEY,
                  first_name TEXT NOT NULL,
                  last_name  TEXT NOT NULL,
                  email      TEXT,
                  age        INTEGER,
                  height_m   REAL
                )""");

            // Insert. Values go in as ?1, ?2 and so on, never pasted into the text.
            String insert = "INSERT INTO person (first_name, last_name, email, age, height_m)"
                + " VALUES (?1, ?2, ?3, ?4, ?5)";
            connection.execute(insert, List.of("Ada", "Lovelace", "ada@example.com", 36, 1.65));
            // Arrays.asList rather than List.of, because List.of refuses a null.
            connection.execute(insert, Arrays.asList("Grace", "Hopper", null, 85, 1.57));

            // Read. query() gives a map per row, keyed by column name.
            for (Map<String, Object> person : connection.query(
                    "SELECT id, first_name, last_name, email, age, height_m"
                    + " FROM person ORDER BY id")) {
                System.out.println(person.get("id") + " " + person.get("first_name") + " "
                    + person.get("last_name") + " " + person.get("email") + " "
                    + person.get("age") + " " + person.get("height_m"));
            }

            // One value.
            System.out.println("people: " + connection.scalar("SELECT COUNT(*) FROM person"));

            // Update, and read the row back.
            Rows changed = connection.execute(
                "UPDATE person SET email = ?1 WHERE last_name = ?2",
                List.of("grace@example.com", "Hopper"));
            System.out.println("updated: " + changed.affected());
            System.out.println("email now: " + connection.scalar(
                "SELECT email FROM person WHERE last_name = ?1", List.of("Hopper")));
        } finally {
            try (var listing = Files.list(directory)) {
                for (Path file : listing.toList()) {
                    Files.deleteIfExists(file);
                }
            }
            Files.deleteIfExists(directory);
        }
    }
}
