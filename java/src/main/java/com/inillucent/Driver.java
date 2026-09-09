package com.inillucent;

import java.lang.foreign.Arena;
import java.lang.foreign.FunctionDescriptor;
import java.lang.foreign.Linker;
import java.lang.foreign.MemoryLayout;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.SymbolLookup;
import java.lang.foreign.ValueLayout;
import java.lang.invoke.MethodHandle;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Finds the shared library, loads it, checks its ABI, and holds a method handle
 * for every symbol this package calls.
 *
 * The Foreign Function and Memory API needs no JNI shim and no C compiler, which
 * is why this client requires Java 22 or later.
 */
final class Driver {

    /** The ABI this package was written against. Only the major has to match. */
    static final int ABI_MAJOR = 1;

    /** size_t and every handle are pointer sized, which is 64 bits everywhere we run. */
    static final ValueLayout.OfLong SIZE_T = ValueLayout.JAVA_LONG;

    private static Driver instance;
    private static RuntimeException loadFailure;

    private final Path path;
    private final Arena arena;
    private final Map<String, MethodHandle> calls = new LinkedHashMap<>();

    private Driver(Path path, Arena arena) {
        this.path = path;
        this.arena = arena;
    }

    /**
     * Returns the loaded driver, loading it the first time it is asked for.
     *
     * The load is attempted once. A failure is remembered and thrown again rather
     * than retried, so a missing library does not turn into one message per call.
     */
    static synchronized Driver get() {
        if (loadFailure != null) {
            throw loadFailure;
        }
        if (instance == null) {
            try {
                instance = load();
            } catch (RuntimeException why) {
                loadFailure = why;
                throw why;
            }
        }
        return instance;
    }

    /** Returns the shared library file names this platform uses. */
    private static List<String> libraryNames() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("win")) {
            return List.of("inillucent_driver_capi.dll");
        }
        if (os.contains("mac") || os.contains("darwin")) {
            return List.of("libinillucent_driver_capi.dylib");
        }
        return List.of("libinillucent_driver_capi.so");
    }

    /**
     * Returns every place the shared library is looked for, in order.
     *
     * The order is the same in all eight client libraries, so an application that
     * works in one works in the rest.
     */
    static List<Path> searchPaths() {
        List<Path> found = new ArrayList<>();
        String named = System.getenv("INILLUCENT_DRIVER_LIB");
        if (named != null && !named.isEmpty()) {
            found.add(Paths.get(named));
        }
        Path repo = repositoryRoot();
        List<Path> engines = List.of(
            repo.resolve("..").resolve("inillucent"),
            repo.resolve("..").resolve("..").resolve("inillucent"));
        for (String name : libraryNames()) {
            found.add(repo.resolve("native").resolve(name));
            for (Path engine : engines) {
                for (String profile : List.of("release", "debug")) {
                    found.add(engine.resolve("target").resolve(profile).resolve(name));
                }
            }
        }
        return found;
    }

    /**
     * Returns the clients repository this package was built from.
     *
     * The system property is what the repository's own build script sets; without
     * it the working directory is the best a JAR on somebody else's classpath can
     * do, and INILLUCENT_DRIVER_LIB is the answer for that case.
     */
    private static Path repositoryRoot() {
        String told = System.getProperty("inillucent.repository");
        if (told != null && !told.isEmpty()) {
            return Paths.get(told).toAbsolutePath().normalize();
        }
        return Paths.get("").toAbsolutePath().resolve("..").normalize();
    }

    /**
     * Returns the path of the shared library, or throws saying where it looked.
     *
     * A message that names every place it tried is the difference between a
     * problem somebody can fix and one they have to guess at.
     */
    private static Path resolveLibrary() {
        List<Path> paths = searchPaths();
        for (Path candidate : paths) {
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        StringBuilder looked = new StringBuilder();
        for (Path candidate : paths) {
            looked.append("\n  ").append(candidate);
        }
        throw new DriverLoadException(
            "cannot find the inillucent driver shared library. Looked in:" + looked
                + "\nBuild it with\n  cargo build --release --manifest-path <engine>/Cargo.toml"
                + " -p inillucent-driver-capi\nthen run scripts/fetch-native.mjs, or set"
                + " INILLUCENT_DRIVER_LIB to its path.");
    }

    /** Loads the library, binds every symbol, and refuses a major ABI mismatch by name. */
    private static Driver load() {
        Path path = resolveLibrary();
        Arena arena = Arena.ofShared();
        Driver driver = new Driver(path, arena);
        SymbolLookup lookup;
        try {
            lookup = SymbolLookup.libraryLookup(path, arena);
        } catch (IllegalArgumentException why) {
            throw new DriverLoadException("cannot load " + path + ": " + why.getMessage());
        }
        driver.bindAll(lookup);

        int reported = (int) driver.callInt("inillucent_abi_version");
        long unsigned = Integer.toUnsignedLong(reported);
        long major = unsigned / 1_000_000;
        if (major != ABI_MAJOR) {
            throw new DriverLoadException(String.format(
                "%s reports ABI %d.%d.%d, and this package was written for ABI %d.x. A major"
                    + " bump moves a signature, so calling it would fail in a way nobody can"
                    + " read. Install a matching driver.",
                path, major, (unsigned / 1000) % 1000, unsigned % 1000, ABI_MAJOR));
        }
        return driver;
    }

    /**
     * Binds every symbol in the ABI to a method handle.
     *
     * @param lookup - the loaded library
     */
    private void bindAll(SymbolLookup lookup) {
        ValueLayout.OfInt i32 = ValueLayout.JAVA_INT;
        ValueLayout.OfLong i64 = ValueLayout.JAVA_LONG;
        ValueLayout.OfDouble f64 = ValueLayout.JAVA_DOUBLE;
        MemoryLayout ptr = ValueLayout.ADDRESS;

        bind(lookup, "inillucent_abi_version", FunctionDescriptor.of(i32));
        bind(lookup, "inillucent_version", FunctionDescriptor.of(ptr));
        bind(lookup, "inillucent_capability_count", FunctionDescriptor.of(SIZE_T));
        bind(lookup, "inillucent_capability", FunctionDescriptor.of(i32, SIZE_T, ptr, ptr, ptr));
        bind(lookup, "inillucent_supports", FunctionDescriptor.of(i32, ptr));

        bind(lookup, "inillucent_open", FunctionDescriptor.of(i32, ptr, i32, ptr, ptr));
        bind(lookup, "inillucent_close", FunctionDescriptor.of(i32, ptr, ptr));
        bind(lookup, "inillucent_checkpoint", FunctionDescriptor.of(i32, ptr, ptr));
        bind(lookup, "inillucent_integrity_check", FunctionDescriptor.of(i32, ptr, ptr));
        bind(lookup, "inillucent_backup_to", FunctionDescriptor.of(i32, ptr, ptr, ptr));
        bind(lookup, "inillucent_path", FunctionDescriptor.of(ptr, ptr));

        bind(lookup, "inillucent_connect", FunctionDescriptor.of(i32, ptr, ptr, ptr));
        bind(lookup, "inillucent_conn_free", FunctionDescriptor.ofVoid(ptr));
        bind(lookup, "inillucent_execute", FunctionDescriptor.of(i32, ptr, ptr, i64, ptr, ptr));
        bind(lookup, "inillucent_execute_batch", FunctionDescriptor.of(i32, ptr, ptr, ptr));
        bind(lookup, "inillucent_last_insert_rowid", FunctionDescriptor.of(i64, ptr));
        bind(lookup, "inillucent_total_changes", FunctionDescriptor.of(i64, ptr));
        bind(lookup, "inillucent_in_transaction", FunctionDescriptor.of(i32, ptr));
        bind(lookup, "inillucent_schema_cookie", FunctionDescriptor.of(i64, ptr));
        bind(lookup, "inillucent_cancel", FunctionDescriptor.of(i32, ptr, ptr));

        bind(lookup, "inillucent_prepare", FunctionDescriptor.of(i32, ptr, ptr, ptr, ptr));
        bind(lookup, "inillucent_stmt_free", FunctionDescriptor.ofVoid(ptr));
        bind(lookup, "inillucent_bind_null", FunctionDescriptor.of(i32, ptr, i32));
        bind(lookup, "inillucent_bind_int", FunctionDescriptor.of(i32, ptr, i32, i64));
        bind(lookup, "inillucent_bind_real", FunctionDescriptor.of(i32, ptr, i32, f64));
        bind(lookup, "inillucent_bind_text", FunctionDescriptor.of(i32, ptr, i32, ptr, SIZE_T));
        bind(lookup, "inillucent_bind_blob", FunctionDescriptor.of(i32, ptr, i32, ptr, SIZE_T));
        bind(lookup, "inillucent_clear_bindings", FunctionDescriptor.ofVoid(ptr));
        bind(lookup, "inillucent_stmt_execute", FunctionDescriptor.of(i32, ptr, i64, ptr, ptr));

        bind(lookup, "inillucent_rows_free", FunctionDescriptor.ofVoid(ptr));
        bind(lookup, "inillucent_rows_column_count", FunctionDescriptor.of(SIZE_T, ptr));
        bind(lookup, "inillucent_rows_column_name", FunctionDescriptor.of(ptr, ptr, SIZE_T));
        bind(lookup, "inillucent_rows_column_type", FunctionDescriptor.of(ptr, ptr, SIZE_T));
        bind(lookup, "inillucent_rows_count", FunctionDescriptor.of(SIZE_T, ptr));
        bind(lookup, "inillucent_rows_total", FunctionDescriptor.of(SIZE_T, ptr));
        bind(lookup, "inillucent_rows_more", FunctionDescriptor.of(i32, ptr));
        bind(lookup, "inillucent_rows_affected", FunctionDescriptor.of(i64, ptr));
        bind(lookup, "inillucent_rows_elapsed_us", FunctionDescriptor.of(i64, ptr));
        bind(lookup, "inillucent_rows_tag", FunctionDescriptor.of(ptr, ptr));
        bind(lookup, "inillucent_value_type", FunctionDescriptor.of(i32, ptr, SIZE_T, SIZE_T));
        bind(lookup, "inillucent_value_int", FunctionDescriptor.of(i64, ptr, SIZE_T, SIZE_T));
        bind(lookup, "inillucent_value_real", FunctionDescriptor.of(f64, ptr, SIZE_T, SIZE_T));
        bind(lookup, "inillucent_value_bytes",
            FunctionDescriptor.of(ptr, ptr, SIZE_T, SIZE_T, ptr));

        bind(lookup, "inillucent_txn_begin", FunctionDescriptor.of(i32, ptr, ptr, ptr));
        bind(lookup, "inillucent_txn_execute", FunctionDescriptor.of(i32, ptr, ptr, ptr, ptr));
        bind(lookup, "inillucent_txn_commit", FunctionDescriptor.of(i32, ptr, ptr));
        bind(lookup, "inillucent_txn_rollback", FunctionDescriptor.ofVoid(ptr));

        bind(lookup, "inillucent_error_status", FunctionDescriptor.of(i32, ptr));
        bind(lookup, "inillucent_error_message", FunctionDescriptor.of(ptr, ptr));
        bind(lookup, "inillucent_error_feature", FunctionDescriptor.of(ptr, ptr));
        bind(lookup, "inillucent_error_detail", FunctionDescriptor.of(ptr, ptr));
        bind(lookup, "inillucent_error_offset", FunctionDescriptor.of(i32, ptr));
        bind(lookup, "inillucent_error_free", FunctionDescriptor.ofVoid(ptr));
    }

    /**
     * Binds one symbol, naming it in the failure rather than letting a missing
     * symbol surface at the call.
     *
     * @param lookup - the loaded library
     * @param name - the exported symbol name
     * @param descriptor - the signature to call it with
     */
    private void bind(SymbolLookup lookup, String name, FunctionDescriptor descriptor) {
        MemorySegment address = lookup.find(name).orElseThrow(() -> new DriverLoadException(
            "the driver does not export " + name + ". That symbol is in the ABI this package"
                + " was written for, so the library is either older than it claims or is not"
                + " the inillucent driver."));
        calls.put(name, Linker.nativeLinker().downcallHandle(address, descriptor));
    }

    /** Returns the file the shared library was loaded from. */
    Path path() {
        return path;
    }

    /** Returns the arena the library is loaded into, which lives as long as the process. */
    Arena arena() {
        return arena;
    }

    /**
     * Calls a symbol and returns whatever it returned.
     *
     * A Throwable from a downcall is not something a caller can act on, so it is
     * wrapped rather than declared: it means this package built the wrong
     * signature, which is a defect here and not a database failure.
     *
     * @param name - the symbol to call
     * @param args - its arguments, in order
     */
    Object call(String name, Object... args) {
        MethodHandle handle = calls.get(name);
        try {
            return handle.invokeWithArguments(args);
        } catch (Throwable why) {
            throw new DriverLoadException("calling " + name + " failed: " + why);
        }
    }

    /** Calls a symbol that returns an int. */
    int callInt(String name, Object... args) {
        return (int) call(name, args);
    }

    /** Calls a symbol that returns a long, which is also how size_t arrives. */
    long callLong(String name, Object... args) {
        return (long) call(name, args);
    }

    /** Calls a symbol that returns a double. */
    double callDouble(String name, Object... args) {
        return (double) call(name, args);
    }

    /** Calls a symbol that returns a pointer. */
    MemorySegment callPointer(String name, Object... args) {
        return (MemorySegment) call(name, args);
    }

    /** Calls a symbol that returns nothing. */
    void callVoid(String name, Object... args) {
        call(name, args);
    }

    /**
     * Copies a C string the library returned into a Java string.
     *
     * Every string is copied on the way out, because it points inside a handle
     * the caller may free. A null pointer becomes null, so a caller can tell
     * absent from empty.
     *
     * @param pointer - what the library handed back
     */
    static String string(MemorySegment pointer) {
        if (pointer == null || pointer.equals(MemorySegment.NULL)) {
            return null;
        }
        return pointer.reinterpret(Long.MAX_VALUE).getString(0);
    }

    /**
     * Copies a counted run of bytes the library returned.
     *
     * @param pointer - what the library handed back
     * @param length - how many bytes to copy
     */
    static byte[] bytes(MemorySegment pointer, long length) {
        if (pointer == null || pointer.equals(MemorySegment.NULL) || length <= 0) {
            return new byte[0];
        }
        return pointer.reinterpret(length).toArray(ValueLayout.JAVA_BYTE);
    }
}
