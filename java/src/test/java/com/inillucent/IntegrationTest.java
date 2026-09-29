package com.inillucent;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Runs the scenarios in conformance/integration.md against this client.
 *
 * suite.json grades what a statement does. These scenarios grade what the
 * library around the statement does: opening, closing and reopening a file, a
 * transaction object, a prepared statement reused with new values, a backup, a
 * cancel sent from another thread, and a second process writing the same file.
 * Every scenario gets a real database in a fresh temporary folder, which is
 * deleted when the scenario ends, and calls only the public API.
 *
 * It is a main method rather than a JUnit class, like ConformanceTest, so that
 * running it needs nothing on the classpath but this client. It prints a line
 * per scenario and exits non zero on any failure.
 */
public final class IntegrationTest {

    /** The first argument that turns this program into the child process. */
    static final String CHILD_FLAG = "--child-insert";

    /** One scenario's body, given its own temporary folder. */
    interface Scenario {
        void run(Path folder) throws Exception;
    }

    /** A scenario and the name integration.md gives it. */
    record Named(String name, Scenario body) {
    }

    private IntegrationTest() {
    }

    /**
     * Runs every scenario, or acts as the child process when asked to.
     *
     * @param args - empty, or the child flag followed by a database path
     */
    public static void main(String[] args) throws Exception {
        if (args.length == 2 && CHILD_FLAG.equals(args[0])) {
            insertFromChild(args[1]);
            return;
        }
        System.out.println(Inillucent.version() + "  ABI " + Inillucent.abiVersion());
        System.out.println();
        List<Named> scenarios = new ArrayList<>();
        scenarios.addAll(IntegrationFiles.scenarios());
        scenarios.addAll(IntegrationStatements.scenarios());
        scenarios.addAll(IntegrationTransactions.scenarios());
        scenarios.addAll(IntegrationEngine.scenarios());
        int failed = 0;
        for (Named scenario : scenarios) {
            failed += runOne(scenario) ? 0 : 1;
        }
        System.out.println();
        System.out.println((scenarios.size() - failed) + " of " + scenarios.size()
            + " scenarios pass");
        if (failed > 0) {
            System.exit(1);
        }
    }

    /**
     * Runs one scenario in a fresh folder, prints its line, and deletes the folder.
     *
     * @param scenario - the scenario to run
     */
    private static boolean runOne(Named scenario) throws Exception {
        Path folder = Files.createTempDirectory("inillucent-java-integration-");
        String problem = null;
        try {
            scenario.body().run(folder);
        } catch (Throwable why) {
            problem = why.toString();
        } finally {
            removeFolder(folder);
        }
        System.out.println("  " + (problem == null ? "ok  " : "FAIL") + "  " + scenario.name());
        if (problem != null) {
            System.out.println("          " + problem);
        }
        return problem == null;
    }

    /**
     * Deletes a scratch folder this program made and everything in it.
     *
     * @param folder - the folder to remove
     */
    static void removeFolder(Path folder) throws Exception {
        if (!Files.exists(folder)) {
            return;
        }
        try (var walk = Files.walk(folder)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    /**
     * The child process: opens the file, inserts one row, closes, and exits 0.
     *
     * @param path - the database file the parent holds open
     */
    static void insertFromChild(String path) {
        try (Database database = Database.open(path);
             Connection connection = database.connect()) {
            connection.execute("INSERT INTO t (v) VALUES (?1)", List.of("from the child process"));
        }
    }

    /**
     * Starts this program again as a child process that inserts one row.
     *
     * The child is the same java executable with the same classpath, so it opens
     * the file through this client exactly as the parent does.
     *
     * @param path - the database file
     */
    static int runChild(Path path) throws Exception {
        String java = ProcessHandle.current().info().command().orElseThrow();
        List<String> command = List.of(java, "--enable-native-access=ALL-UNNAMED",
            "-Dinillucent.repository=" + System.getProperty("inillucent.repository", ""),
            "-cp", System.getProperty("java.class.path"),
            IntegrationTest.class.getName(), CHILD_FLAG, path.toString());
        Process child = new ProcessBuilder(command).redirectErrorStream(true).start();
        String said = new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        if (!child.waitFor(60, TimeUnit.SECONDS)) {
            child.destroyForcibly();
            throw new AssertionError("the child process did not finish in 60 seconds");
        }
        if (child.exitValue() != 0) {
            throw new AssertionError("the child process exited " + child.exitValue() + ": " + said);
        }
        return child.exitValue();
    }

    /**
     * Fails unless the condition holds.
     *
     * @param holds - the condition
     * @param what - what should have been true
     */
    static void check(boolean holds, String what) {
        if (!holds) {
            throw new AssertionError(what);
        }
    }

    /**
     * Fails unless got equals want, kind included, comparing byte arrays by content.
     *
     * @param got - what came back
     * @param want - what should have come back
     * @param what - names the value
     */
    static void same(Object got, Object want, String what) {
        boolean equal = got instanceof byte[] gotBytes && want instanceof byte[] wantBytes
            ? Arrays.equals(gotBytes, wantBytes)
            : Objects.equals(got, want);
        if (!equal) {
            throw new AssertionError(what + " is " + shown(got) + " and should be " + shown(want));
        }
    }

    /**
     * Renders a value for a failure message.
     *
     * @param value - the value
     */
    private static String shown(Object value) {
        if (value == null) {
            return "NULL";
        }
        if (value instanceof byte[] bytes) {
            return bytes.length + " bytes";
        }
        return value.getClass().getSimpleName() + "(" + value + ")";
    }

    /** A call that is expected to throw. */
    interface Call {
        void run() throws Exception;
    }

    /**
     * Fails unless the call throws an InillucentException with the status wanted.
     *
     * @param want - the status it should carry
     * @param what - names the call
     * @param call - the call
     */
    static InillucentException fails(Status want, String what, Call call) throws Exception {
        try {
            call.run();
        } catch (InillucentException failure) {
            if (failure.status() != want) {
                throw new AssertionError(what + " failed with " + failure.status().label()
                    + " and should fail with " + want.label() + ": " + failure.getMessage());
            }
            return failure;
        }
        throw new AssertionError(what + " must fail with " + want.label() + ", and it succeeded");
    }

    /**
     * Encodes floats as the little endian float32 blob a VECTOR column holds.
     *
     * @param values - the vector's components
     */
    static byte[] vector(float... values) {
        ByteBuffer buffer = ByteBuffer.allocate(4 * values.length).order(ByteOrder.LITTLE_ENDIAN);
        for (float value : values) {
            buffer.putFloat(value);
        }
        return buffer.array();
    }

    /**
     * Returns the first column of every row, for a quick comparison.
     *
     * @param rows - a result
     */
    static List<Object> firstColumn(Rows rows) {
        List<Object> values = new ArrayList<>();
        for (List<Object> row : rows) {
            values.add(row.get(0));
        }
        return values;
    }

    /**
     * Runs a callable on another thread after a delay.
     *
     * @param millis - how long to wait first
     * @param action - what to run
     */
    static CompletableFuture<Void> later(long millis, Runnable action) {
        return CompletableFuture.runAsync(action,
            CompletableFuture.delayedExecutor(millis, TimeUnit.MILLISECONDS));
    }
}
