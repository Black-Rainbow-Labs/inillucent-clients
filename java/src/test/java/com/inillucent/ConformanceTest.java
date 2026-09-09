package com.inillucent;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Runs conformance/suite.json against this client.
 *
 * The suite is the driver's behaviour written as data rather than as prose, and
 * every client library in this repository runs the same file. When two of them
 * disagree, one of them is wrong; when they agree, the specification is one that
 * can actually be followed.
 *
 * It is a main method rather than a JUnit class so that running the suite needs
 * nothing on the classpath but this client.
 */
public final class ConformanceTest {

    private ConformanceTest() {
    }

    /**
     * Runs every case, prints a line each, and exits non zero on any failure.
     *
     * @param args - unused
     */
    public static void main(String[] args) throws Exception {
        Path suitePath = suitePath();
        System.out.println(Inillucent.version() + "  ABI " + Inillucent.abiVersion());
        System.out.println("driver: " + Inillucent.driverPath());
        System.out.println("suite:  " + suitePath);
        System.out.println();

        String text = Files.readString(suitePath, StandardCharsets.UTF_8);
        @SuppressWarnings("unchecked")
        Map<String, Object> suite = (Map<String, Object>) Json.parse(text);
        @SuppressWarnings("unchecked")
        List<Object> cases = (List<Object>) suite.get("cases");

        List<String> failures = new ArrayList<>();
        for (Object entry : cases) {
            @SuppressWarnings("unchecked")
            Map<String, Object> theCase = (Map<String, Object>) entry;
            String name = String.valueOf(theCase.getOrDefault("name", "(unnamed)"));
            List<String> wrong = runCase(theCase);
            System.out.println("  " + (wrong.isEmpty() ? "ok  " : "FAIL") + "  " + name);
            for (String problem : wrong) {
                System.out.println("          " + problem);
                failures.add(name + ": " + problem);
            }
        }

        failures.addAll(checkCapabilityTable());

        System.out.println();
        System.out.println(cases.size() + " cases, " + failures.size() + " failures");
        if (!failures.isEmpty()) {
            System.exit(1);
        }
    }

    /** Returns the path of the shared conformance suite. */
    private static Path suitePath() {
        String repository = System.getProperty("inillucent.repository");
        Path root = repository == null || repository.isEmpty()
            ? Paths.get("").toAbsolutePath().resolve("..")
            : Paths.get(repository);
        return root.resolve("conformance").resolve("suite.json").normalize();
    }

    /**
     * Reads a value out of the suite's one key object form.
     *
     * One key rather than a bare literal, so that NULL and the empty string can
     * never be confused by the file itself.
     *
     * @param described - a value object such as {"int": 7}
     */
    private static Object valueOf(Map<String, Object> described) {
        if (described.containsKey("null")) {
            return null;
        }
        if (described.containsKey("int")) {
            return ((Number) described.get("int")).longValue();
        }
        if (described.containsKey("real")) {
            return ((Number) described.get("real")).doubleValue();
        }
        if (described.containsKey("text")) {
            return described.get("text");
        }
        if (described.containsKey("blob")) {
            @SuppressWarnings("unchecked")
            List<Object> listed = (List<Object>) described.get("blob");
            byte[] bytes = new byte[listed.size()];
            for (int nth = 0; nth < listed.size(); nth++) {
                bytes[nth] = (byte) ((Number) listed.get(nth)).intValue();
            }
            return bytes;
        }
        throw new IllegalArgumentException(described + " names no value kind");
    }

    /**
     * Compares an expected value to what came back.
     *
     * The kinds have to match as well as the contents: an integer and a real are
     * different values, and a comparison that let 1 equal 1.0 would hide a client
     * that lost the distinction.
     */
    private static boolean same(Object want, Object got) {
        if (want == null || got == null) {
            return want == null && got == null;
        }
        if (want instanceof byte[] || got instanceof byte[]) {
            return want instanceof byte[] wantBytes && got instanceof byte[] gotBytes
                && Arrays.equals(wantBytes, gotBytes);
        }
        return want.getClass() == got.getClass() && want.equals(got);
    }

    /** Renders a value for a failure message. */
    private static String shown(Object value) {
        if (value == null) {
            return "NULL";
        }
        if (value instanceof byte[] bytes) {
            return bytes.length + " bytes " + Arrays.toString(bytes);
        }
        return value.getClass().getSimpleName() + "(" + value + ")";
    }

    /** Checks the rows a successful step handed back. */
    private static void checkRows(Map<String, Object> step, Rows rows, List<String> wrong) {
        @SuppressWarnings("unchecked")
        List<Object> want = (List<Object>) step.get("rows");
        if (want.size() != rows.size()) {
            wrong.add("there are " + rows.size() + " rows and there should be " + want.size());
            return;
        }
        for (int nth = 0; nth < want.size(); nth++) {
            @SuppressWarnings("unchecked")
            List<Object> row = (List<Object>) want.get(nth);
            List<Object> got = rows.rows().get(nth);
            if (row.size() != got.size()) {
                wrong.add("row " + nth + " has " + got.size() + " cells and should have "
                    + row.size());
                continue;
            }
            for (int column = 0; column < row.size(); column++) {
                @SuppressWarnings("unchecked")
                Object expected = valueOf((Map<String, Object>) row.get(column));
                if (!same(expected, got.get(column))) {
                    wrong.add("row " + nth + " column " + column + " is " + shown(got.get(column))
                        + " and should be " + shown(expected));
                }
            }
        }
    }

    /** Checks a step that was expected to succeed. */
    private static void checkSuccess(Map<String, Object> step, Rows rows, List<String> wrong) {
        if (step.containsKey("status")) {
            wrong.add("expected it to fail with `" + step.get("status") + "` and it succeeded");
            return;
        }
        if (step.containsKey("columns") && !step.get("columns").equals(rows.columns())) {
            wrong.add("columns are " + rows.columns() + " and should be " + step.get("columns"));
        }
        if (step.containsKey("rows")) {
            checkRows(step, rows, wrong);
        }
        if (step.containsKey("affected")) {
            Object want = step.get("affected");
            Long wanted = want == null ? null : ((Number) want).longValue();
            if (!java.util.Objects.equals(rows.affected(), wanted)) {
                wrong.add("affected is " + rows.affected() + " and should be " + wanted);
            }
        }
        if (step.containsKey("total")) {
            long want = ((Number) step.get("total")).longValue();
            if (rows.total() != want) {
                wrong.add("total is " + rows.total() + " and should be " + want + ", and total is"
                    + " exact, so this is a real disagreement rather than an estimate being off");
            }
        }
        if (step.containsKey("more") && rows.more() != (Boolean) step.get("more")) {
            wrong.add("more is " + rows.more() + " and should be " + step.get("more"));
        }
    }

    /** Checks a step that was expected to fail. */
    private static void checkFailure(Map<String, Object> step, InillucentException failure,
                                     List<String> wrong) {
        if (!step.containsKey("status")) {
            wrong.add("it was expected to succeed and it failed: " + failure.getMessage());
            return;
        }
        String want = String.valueOf(step.get("status"));
        if (!failure.status().label().equals(want)) {
            wrong.add("it failed with `" + failure.status().label() + "` and should have failed"
                + " with `" + want + "`, saying: " + failure.getMessage());
        }
        if (step.containsKey("message_contains")) {
            String holds = String.valueOf(step.get("message_contains"));
            if (!failure.plainMessage().contains(holds)) {
                wrong.add("the message is \"" + failure.plainMessage() + "\" and should hold \""
                    + holds + "\"");
            }
        }
        if (step.containsKey("feature_contains")) {
            String holds = String.valueOf(step.get("feature_contains"));
            if (failure.feature() == null) {
                wrong.add("it named no construct, and an unsupported refusal has to name one or"
                    + " an application cannot say what it hit");
            } else if (!failure.feature().contains(holds)) {
                wrong.add("it named \"" + failure.feature() + "\" and should have named something"
                    + " holding \"" + holds + "\"");
            }
        }
        if (failure.status() == Status.UNSUPPORTED) {
            if (!(failure instanceof UnsupportedFeatureException)) {
                wrong.add("an unsupported refusal did not arrive as UnsupportedFeatureException,"
                    + " which is the whole of this design arriving in Java");
            }
            if (failure.feature() == null) {
                wrong.add("an unsupported refusal must carry a feature");
            }
        }
    }

    /**
     * Runs one case and returns one line per disagreement.
     *
     * @param theCase - one entry from the suite's cases
     */
    private static List<String> runCase(Map<String, Object> theCase) throws Exception {
        String name = String.valueOf(theCase.getOrDefault("name", "unnamed"));
        Path path = Files.createTempDirectory("inillucent-java-").resolve(name + ".rdb");
        List<String> wrong = new ArrayList<>();

        try (Database database = Database.open(path);
             Connection connection = database.connect()) {

            @SuppressWarnings("unchecked")
            List<Object> setup = (List<Object>) theCase.getOrDefault("setup", List.of());
            for (Object statement : setup) {
                try {
                    connection.execute(String.valueOf(statement));
                } catch (InillucentException why) {
                    wrong.add("the setup statement `" + statement + "` was refused: "
                        + why.getMessage());
                }
            }
            if (wrong.isEmpty()) {
                @SuppressWarnings("unchecked")
                List<Object> steps = (List<Object>) theCase.getOrDefault("steps", List.of());
                for (Object entry : steps) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> step = (Map<String, Object>) entry;
                    wrong.addAll(runStep(connection, step));
                }
            }
        } finally {
            removeScratch(path.getParent());
        }
        return wrong;
    }

    /**
     * Removes a scratch directory this runner made, and everything the engine
     * wrote beside the database in it.
     *
     * A database leaves a write ahead log next to its file, so deleting only the
     * .rdb leaves the directory behind.
     *
     * @param directory - the scratch directory to remove
     */
    private static void removeScratch(Path directory) throws Exception {
        try (var listing = Files.list(directory)) {
            for (Path file : listing.toList()) {
                Files.deleteIfExists(file);
            }
        }
        Files.deleteIfExists(directory);
    }

    /**
     * Runs one step and returns one line per disagreement, each naming the SQL.
     *
     * @param connection - the connection the case is running on
     * @param step - the step, which asserts only the keys it carries
     */
    private static List<String> runStep(Connection connection, Map<String, Object> step) {
        String sql = String.valueOf(step.get("sql"));
        List<Object> params = new ArrayList<>();
        @SuppressWarnings("unchecked")
        List<Object> described = (List<Object>) step.getOrDefault("params", List.of());
        for (Object value : described) {
            @SuppressWarnings("unchecked")
            Map<String, Object> one = (Map<String, Object>) value;
            params.add(valueOf(one));
        }
        Long limit = step.get("limit") == null ? null : ((Number) step.get("limit")).longValue();

        List<String> said = new ArrayList<>();
        try {
            checkSuccess(step, connection.execute(sql, params, limit), said);
        } catch (InillucentException failure) {
            checkFailure(step, failure, said);
        }
        List<String> wrong = new ArrayList<>();
        for (String problem : said) {
            wrong.add("`" + sql + "`: " + problem);
        }
        return wrong;
    }

    /**
     * Checks the capability table, which is the other half of the surface.
     *
     * Reading it here also proves the C strings it hands back survive being
     * copied out, which is the rule a binding is most likely to get wrong.
     */
    private static List<String> checkCapabilityTable() {
        List<String> wrong = new ArrayList<>();
        List<Capability> rows = Inillucent.capabilities();
        System.out.println();
        System.out.println(rows.size() + " capabilities reported");
        if (rows.isEmpty()) {
            wrong.add("the engine declares no capabilities at all");
        }
        for (Capability row : rows) {
            if (row.name().isEmpty()) {
                wrong.add("a capability came back with no name");
            }
            if (row.support() == Support.NO) {
                System.out.println("  not supported: " + row.name());
            }
        }
        if (Inillucent.supports("cancel") != Support.NO) {
            wrong.add("cancel is declared unsupported, and a client that reported otherwise would"
                + " have an application drawing a Stop button that cannot work");
        }
        if (Inillucent.supports("time_travel") != Support.UNKNOWN) {
            wrong.add("a capability nobody declared must answer unknown rather than no: they mean"
                + " different things, and one of them is a checked absence");
        }
        return wrong;
    }
}
