package com.inillucent;

import static com.inillucent.IntegrationTest.check;
import static com.inillucent.IntegrationTest.fails;
import static com.inillucent.IntegrationTest.same;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * The scenarios in the Engine facts section of conformance/integration.md, and
 * the calls into the public API that no scenario makes.
 */
final class IntegrationEngine {

    private IntegrationEngine() {
    }

    /** Returns this section's scenarios, named as integration.md names them. */
    static List<IntegrationTest.Named> scenarios() {
        return List.of(
            new IntegrationTest.Named("capabilitiesAndVersions",
                IntegrationEngine::capabilitiesAndVersions),
            new IntegrationTest.Named("checkpointIntegrityCheckAndBackup",
                IntegrationEngine::checkpointIntegrityCheckAndBackup),
            new IntegrationTest.Named("cancelFromAnotherThreadInterruptsAndTheConnectionSurvives",
                IntegrationEngine::cancelFromAnotherThreadInterruptsAndTheConnectionSurvives),
            new IntegrationTest.Named("encryption", IntegrationEngine::encryption),
            new IntegrationTest.Named("bindAcceptsEveryJavaKindItDocuments",
                IntegrationEngine::bindAcceptsEveryJavaKindItDocuments),
            new IntegrationTest.Named("bindingMoreValuesThanPlaceholdersIsRefused",
                IntegrationEngine::bindingMoreValuesThanPlaceholdersIsRefused),
            new IntegrationTest.Named("namesAndCodesRoundTrip",
                IntegrationEngine::namesAndCodesRoundTrip));
    }

    /**
     * The capability table, supports() for known and unknown names, and versions.
     *
     * @param folder - this scenario's temporary folder, unused
     */
    static void capabilitiesAndVersions(Path folder) {
        List<Capability> listed = Inillucent.capabilities();
        check(!listed.isEmpty(), "the capability list must not be empty");
        for (Capability capability : listed) {
            check(!capability.name().isEmpty(), "every capability must have a name");
            check(capability.isSupported() == capability.support().isSupported(),
                "a capability is supported exactly when its support says so");
        }
        same(Inillucent.supports("cancel"), Support.PARTIAL, "supports(cancel)");
        same(Inillucent.supports("encryption"), Support.YES, "supports(encryption)");
        same(Inillucent.supports("load_extension"), Support.NO, "supports(load_extension)");
        same(Inillucent.supports("made_up_name"), Support.UNKNOWN, "supports(made_up_name)");
        // Any release: this said "1.0." and failed when the engine became 2.0. The ABI is what matters.
        check(Inillucent.version().matches("inillucent-driver \\d+\\.\\d+\\.\\d+ \\(engine \\d+\\.\\d+\\.\\d+\\)"),
                "the version must name the driver and the engine: " + Inillucent.version());
        String[] abi = Inillucent.abiVersion().split("\\.");
        int major = Integer.parseInt(abi[0]);
        int minor = Integer.parseInt(abi[1]);
        check(major > 1 || (major == 1 && minor >= 1), "the ABI must be at least 1.1.0");
        check(Files.isRegularFile(Path.of(Inillucent.driverPath())), "the driver path must exist");
        check(!Inillucent.searchPaths().isEmpty(), "there must be places to look for the driver");
    }

    /**
     * Checkpoint and integrity check succeed, and a backup opens with the same rows.
     *
     * @param folder - this scenario's temporary folder
     */
    static void checkpointIntegrityCheckAndBackup(Path folder) {
        Path copy = folder.resolve("copy.rdb");
        try (Database database = Database.open(folder.resolve("original.rdb"));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE t (v TEXT)");
            connection.execute("INSERT INTO t (v) VALUES ('one'), ('two'), ('three')");
            database.checkpoint();
            database.integrityCheck();
            database.backupTo(copy.toString());
            database.backupTo(copy.toString());
        }
        try (Database database = Database.open(copy);
             Connection connection = database.connect()) {
            same(connection.scalar("SELECT COUNT(*) FROM t"), 3L, "rows in the backup");
        }
    }

    /**
     * A cancel from another thread stops a long statement as interrupted, and the
     * connection keeps working, including after a cancel with nothing running.
     *
     * @param folder - this scenario's temporary folder
     */
    static void cancelFromAnotherThreadInterruptsAndTheConnectionSurvives(Path folder)
            throws Exception {
        try (Database database = Database.open(folder.resolve("cancel.rdb"));
             Connection connection = database.connect()) {
            CompletableFuture<Void> cancelled = IntegrationTest.later(100, connection::cancel);
            long started = System.nanoTime();
            fails(Status.INTERRUPTED, "a long statement that was cancelled",
                () -> connection.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1"
                    + " FROM n WHERE x < 100000000) SELECT count(*) FROM n"));
            cancelled.get();
            long millis = (System.nanoTime() - started) / 1_000_000;
            System.out.println("          the statement stopped " + millis + " ms after it started");
            same(connection.scalar("SELECT 1"), 1L, "the next statement");
            connection.cancel();
            same(connection.scalar("SELECT 2"), 2L, "the statement after an idle cancel");
        }
    }

    /**
     * An encrypted file holds no plaintext, reads back with its key, and refuses
     * no key and a wrong key as corrupt.
     *
     * @param folder - this scenario's temporary folder
     */
    static void encryption(Path folder) throws Exception {
        Path path = folder.resolve("vault.rdb");
        String key = "x'" + "5a".repeat(32) + "'";
        String secret = "the vault code is 7461";
        try (Database database = Database.open(path.toString(), Database.Options.defaults().key(key));
             Connection connection = database.connect()) {
            connection.execute("CREATE TABLE vault (note TEXT)");
            connection.execute("INSERT INTO vault (note) VALUES (?1)", List.of(secret));
        }
        try (var listing = Files.list(folder)) {
            for (Path file : listing.toList()) {
                String bytes = new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1);
                check(!bytes.contains(secret), "the plaintext appears in " + file.getFileName());
            }
        }
        try (Database database = Database.open(path.toString(), Database.Options.defaults().key(key));
             Connection connection = database.connect()) {
            same(connection.scalar("SELECT note FROM vault"), secret, "the row read with the key");
            same(connection.scalar("PRAGMA encryption"), "xchacha20-poly1305", "PRAGMA encryption");
        }
        fails(Status.CORRUPT, "opening without the key", () -> Database.open(path.toString()).close());
        Database.Options wrong = Database.Options.defaults().key("x'" + "6b".repeat(32) + "'");
        fails(Status.CORRUPT, "opening with a wrong key",
            () -> Database.open(path.toString(), wrong).close());
    }

    /**
     * Every Java type the client documents binds as the value kind it names, and
     * any other type is refused by name.
     *
     * @param folder - this scenario's temporary folder
     */
    static void bindAcceptsEveryJavaKindItDocuments(Path folder) throws Exception {
        Database.Options options = Database.Options.defaults().diagnostics(true);
        try (Database database = Database.open(folder.resolve("bind.rdb").toString(), options);
             Connection connection = database.connect()) {
            List<Object> values = Arrays.asList(true, false, (byte) 3, (short) -4, 5, 6L, 0.5f,
                0.25, "", new byte[0], null);
            Rows rows = connection.execute("SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11",
                values);
            List<Object> want = Arrays.asList(1L, 0L, 3L, -4L, 5L, 6L, 0.5, 0.25, "", new byte[0],
                null);
            for (int nth = 0; nth < want.size(); nth++) {
                same(rows.rows().get(0).get(nth), want.get(nth), "parameter " + (nth + 1));
            }
            try {
                connection.execute("SELECT ?1", List.of(new Object()));
                throw new AssertionError("binding an Object must be refused");
            } catch (IllegalArgumentException refused) {
                check(refused.getMessage().contains("cannot bind"), "the refusal names the type");
            }
            same(connection.query("SELECT ?1 AS v", List.of(9)).get(0).get("v"), 9L, "query with params");
            InillucentException missing = fails(Status.NOT_FOUND, "a missing table with diagnostics",
                () -> connection.execute("SELECT * FROM missing_table"));
            System.out.println("          diagnostic detail: " + missing.detail());
        }
    }

    /**
     * Binding more values than the SQL has placeholders throws invalid_state,
     * and the statement still runs with the right number of values.
     *
     * @param folder - this scenario's temporary folder
     */
    static void bindingMoreValuesThanPlaceholdersIsRefused(Path folder) throws Exception {
        try (Database database = Database.open(folder.resolve("extra-values.rdb"));
             Connection connection = database.connect()) {
            fails(Status.INVALID_STATE, "SELECT ?1 with two values",
                () -> connection.execute("SELECT ?1", List.of(1, 2)));
            try (Statement statement = connection.prepare("SELECT ?1")) {
                fails(Status.INVALID_STATE, "a prepared SELECT ?1 with two values",
                    () -> statement.execute(List.of("a", "b")));
                same(statement.execute(List.of(5)).scalar(), 5L, "SELECT ?1 with one value");
            }
        }
    }

    /**
     * Status and Support codes and labels round trip, and an unknown code is kept.
     *
     * @param folder - this scenario's temporary folder, unused
     */
    static void namesAndCodesRoundTrip(Path folder) {
        for (Status status : Status.values()) {
            if (status != Status.UNKNOWN) {
                same(Status.fromCode(status.code()), status, "status " + status.label());
            }
        }
        same(Status.fromCode(99), Status.UNKNOWN, "an unknown status code");
        for (Support support : Support.values()) {
            same(Support.fromCode(support.code()), support, "support " + support.label());
        }
        same(Support.fromCode(99), Support.UNKNOWN, "an unknown support code");
        check(Support.PARTIAL.isSupported() && !Support.NO.isSupported(),
            "partial counts as supported and no does not");
        check(new DriverLoadException("x").getMessage().equals("x"), "a load failure keeps its text");
    }
}
