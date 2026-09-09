package com.inillucent;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * A first program: create a table, write rows, read them back, and ask the
 * engine what it can do before composing anything unusual.
 */
public final class Quickstart {

    private Quickstart() {
    }

    /**
     * Runs the quickstart against a scratch database.
     *
     * @param args - unused
     */
    public static void main(String[] args) throws Exception {
        Path directory = Files.createTempDirectory("inillucent-quickstart-");
        Path path = directory.resolve("library.rdb");

        try (Database database = Database.open(path);
             Connection connection = database.connect()) {

            System.out.println(Inillucent.version());

            connection.execute(
                "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, rating REAL)");
            connection.execute("INSERT INTO authors VALUES (?1, ?2, ?3)",
                List.of(1, "Octavia Butler", 4.8));
            connection.execute("INSERT INTO authors VALUES (?1, ?2, ?3)",
                java.util.Arrays.asList(2, "Ursula Le Guin", null));

            for (Map<String, Object> author
                     : connection.query("SELECT id, name, rating FROM authors ORDER BY id")) {
                System.out.println(
                    author.get("id") + " " + author.get("name") + " " + author.get("rating"));
            }

            // The limit caps what is handed back; the total was counted, not estimated.
            Rows page = connection.execute(
                "SELECT id, name FROM authors ORDER BY id", List.of(), 1L);
            System.out.println("showing " + page.size() + " of " + page.total()
                + (page.more() ? ", more to come" : ""));

            // A transaction is a handle, so what a write did can be checked before commit.
            try (Transaction transaction = connection.begin()) {
                long changed = transaction.execute(
                    "INSERT INTO authors VALUES (3, 'Ted Chiang', 4.9)");
                if (changed == 1) {
                    transaction.commit();
                }
            }

            System.out.println("authors: " + connection.scalar("SELECT COUNT(*) FROM authors"));
            System.out.println(
                "cancel supported: " + (Inillucent.supports("cancel") == Support.YES));

            try {
                connection.cancel();
            } catch (UnsupportedFeatureException why) {
                System.out.println("cancel refused, and it named: " + why.feature());
            }
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
