package com.inillucent;

import java.lang.foreign.Arena;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.ValueLayout;
import java.util.ArrayList;
import java.util.List;

/**
 * The Inillucent client for Java.
 *
 * Inillucent is an embedded database written in Rust. There is no server: your
 * program opens a file, sends SQL to a library in the same process, and gets
 * typed rows back.
 *
 * <pre>{@code
 * try (Database database = Database.open("library.rdb");
 *      Connection connection = database.connect()) {
 *
 *     connection.execute("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)");
 *     connection.execute("INSERT INTO authors VALUES (?1, ?2)", List.of(1, "Octavia Butler"));
 *
 *     for (Map<String, Object> author : connection.query("SELECT id, name FROM authors")) {
 *         System.out.println(author.get("id") + " " + author.get("name"));
 *     }
 * }
 * }</pre>
 *
 * The calls go through the engine's C ABI using the Foreign Function and Memory
 * API, so there is no JNI shim to build and no C compiler needed. That API is
 * final in Java 22, which is the minimum this client supports.
 *
 * Two things about this engine shape the whole library. Values stay typed: null,
 * Long, Double, String and byte[], with null meaning NULL rather than an empty
 * string. And the engine refuses what it has not built rather than answering it
 * wrongly, which arrives as {@link UnsupportedFeatureException} naming the
 * construct in {@link InillucentException#feature()}.
 */
public final class Inillucent {

    private Inillucent() {
    }

    /** Returns what the driver calls itself. */
    public static String version() {
        String found = Driver.string(Driver.get().callPointer("inillucent_version"));
        return found == null ? "" : found;
    }

    /** Returns the shared library's ABI version as major.minor.patch. */
    public static String abiVersion() {
        long reported = Integer.toUnsignedLong(Driver.get().callInt("inillucent_abi_version"));
        return (reported / 1_000_000) + "." + ((reported / 1000) % 1000) + "." + (reported % 1000);
    }

    /** Returns the file the shared library was loaded from. */
    public static String driverPath() {
        return Driver.get().path().toString();
    }

    /** Returns every place the shared library is looked for, in order. */
    public static List<String> searchPaths() {
        List<String> shown = new ArrayList<>();
        Driver.searchPaths().forEach(path -> shown.add(path.toString()));
        return shown;
    }

    /**
     * Returns every capability the engine declares.
     *
     * Ask this before composing a statement rather than after. Every row is
     * checked against the running engine by a test in both directions, so a
     * claim of support that fails and a claim of absence that now works each
     * turn it red.
     */
    public static List<Capability> capabilities() {
        Driver driver = Driver.get();
        long count = driver.callLong("inillucent_capability_count");
        List<Capability> found = new ArrayList<>();
        try (Arena arena = Arena.ofConfined()) {
            for (long nth = 0; nth < count; nth++) {
                MemorySegment name = arena.allocate(ValueLayout.ADDRESS);
                MemorySegment state = arena.allocate(ValueLayout.JAVA_INT);
                MemorySegment note = arena.allocate(ValueLayout.ADDRESS);
                if (driver.callInt("inillucent_capability", nth, name, state, note) != 0) {
                    continue;
                }
                String readName = Driver.string(name.get(ValueLayout.ADDRESS, 0));
                String readNote = Driver.string(note.get(ValueLayout.ADDRESS, 0));
                found.add(new Capability(
                    readName == null ? "" : readName,
                    Support.fromCode(state.get(ValueLayout.JAVA_INT, 0)),
                    readNote == null ? "" : readNote));
            }
        }
        return found;
    }

    /**
     * Returns whether the engine does something, by name.
     *
     * Support.UNKNOWN means this build has never heard of the capability, and it
     * should be treated as no rather than as yes: one that was never declared
     * was certainly never checked.
     *
     * @param name - the capability name
     */
    public static Support supports(String name) {
        Driver driver = Driver.get();
        try (Arena arena = Arena.ofConfined()) {
            return Support.fromCode(
                driver.callInt("inillucent_supports", arena.allocateFrom(name)));
        }
    }
}
