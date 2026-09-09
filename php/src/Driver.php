<?php

declare(strict_types=1);

namespace Inillucent;

use FFI;

/**
 * Finds the shared library, loads it through FFI, checks its ABI, and holds the
 * one handle every other class calls through.
 *
 * The declarations below are the C header written in the subset PHP's FFI parser
 * accepts: no preprocessor, and the fixed width types spelled out, because the
 * parser has no stdint.h to read.
 */
final class Driver
{
    /** The ABI this package was written against. Only the major has to match. */
    public const ABI_MAJOR = 1;

    /** The largest limit the C ABI accepts, which is every row. */
    public const NO_LIMIT = -1;

    private const DECLARATIONS = <<<'CDEF'
        typedef struct inillucent_db inillucent_db;
        typedef struct inillucent_conn inillucent_conn;
        typedef struct inillucent_stmt inillucent_stmt;
        typedef struct inillucent_rows inillucent_rows;
        typedef struct inillucent_txn inillucent_txn;
        typedef struct inillucent_error inillucent_error;

        unsigned int inillucent_abi_version(void);
        const char *inillucent_version(void);
        size_t inillucent_capability_count(void);
        int inillucent_capability(size_t nth, const char **name, int *state, const char **note);
        int inillucent_supports(const char *name);

        int inillucent_open(const char *path, unsigned int flags, inillucent_db **out, inillucent_error **error);
        int inillucent_close(inillucent_db *db, inillucent_error **error);
        int inillucent_checkpoint(inillucent_db *db, inillucent_error **error);
        int inillucent_integrity_check(inillucent_db *db, inillucent_error **error);
        int inillucent_backup_to(inillucent_db *db, const char *path, inillucent_error **error);
        const char *inillucent_path(const inillucent_db *db);

        int inillucent_connect(inillucent_db *db, inillucent_conn **out, inillucent_error **error);
        void inillucent_conn_free(inillucent_conn *conn);
        int inillucent_execute(inillucent_conn *conn, const char *sql, unsigned long long limit, inillucent_rows **out, inillucent_error **error);
        int inillucent_execute_batch(inillucent_conn *conn, const char *sql, inillucent_error **error);
        long long inillucent_last_insert_rowid(inillucent_conn *conn);
        long long inillucent_total_changes(inillucent_conn *conn);
        int inillucent_in_transaction(inillucent_conn *conn);
        unsigned long long inillucent_schema_cookie(inillucent_conn *conn);
        int inillucent_cancel(inillucent_conn *conn, inillucent_error **error);

        int inillucent_prepare(inillucent_conn *conn, const char *sql, inillucent_stmt **out, inillucent_error **error);
        void inillucent_stmt_free(inillucent_stmt *stmt);
        int inillucent_bind_null(inillucent_stmt *stmt, unsigned int index);
        int inillucent_bind_int(inillucent_stmt *stmt, unsigned int index, long long value);
        int inillucent_bind_real(inillucent_stmt *stmt, unsigned int index, double value);
        int inillucent_bind_text(inillucent_stmt *stmt, unsigned int index, const char *value, size_t len);
        int inillucent_bind_blob(inillucent_stmt *stmt, unsigned int index, const unsigned char *value, size_t len);
        void inillucent_clear_bindings(inillucent_stmt *stmt);
        int inillucent_stmt_execute(inillucent_stmt *stmt, unsigned long long limit, inillucent_rows **out, inillucent_error **error);

        void inillucent_rows_free(inillucent_rows *rows);
        size_t inillucent_rows_column_count(const inillucent_rows *rows);
        const char *inillucent_rows_column_name(const inillucent_rows *rows, size_t nth);
        const char *inillucent_rows_column_type(const inillucent_rows *rows, size_t nth);
        size_t inillucent_rows_count(const inillucent_rows *rows);
        size_t inillucent_rows_total(const inillucent_rows *rows);
        int inillucent_rows_more(const inillucent_rows *rows);
        long long inillucent_rows_affected(const inillucent_rows *rows);
        unsigned long long inillucent_rows_elapsed_us(const inillucent_rows *rows);
        const char *inillucent_rows_tag(const inillucent_rows *rows);
        int inillucent_value_type(const inillucent_rows *rows, size_t row, size_t column);
        long long inillucent_value_int(const inillucent_rows *rows, size_t row, size_t column);
        double inillucent_value_real(const inillucent_rows *rows, size_t row, size_t column);
        const unsigned char *inillucent_value_bytes(const inillucent_rows *rows, size_t row, size_t column, size_t *len);

        int inillucent_txn_begin(inillucent_conn *conn, inillucent_txn **out, inillucent_error **error);
        int inillucent_txn_execute(inillucent_txn *txn, const char *sql, unsigned long long *affected, inillucent_error **error);
        int inillucent_txn_commit(inillucent_txn *txn, inillucent_error **error);
        void inillucent_txn_rollback(inillucent_txn *txn);

        int inillucent_error_status(const inillucent_error *error);
        const char *inillucent_error_message(const inillucent_error *error);
        const char *inillucent_error_feature(const inillucent_error *error);
        const char *inillucent_error_detail(const inillucent_error *error);
        int inillucent_error_offset(const inillucent_error *error);
        void inillucent_error_free(inillucent_error *error);
        CDEF;

    private static ?FFI $ffi = null;
    private static string $path = '';

    /**
     * Returns the loaded library, loading it the first time it is asked for.
     */
    public static function ffi(): FFI
    {
        if (self::$ffi === null) {
            self::load();
        }
        return self::$ffi;
    }

    /** Returns the file the shared library was loaded from. */
    public static function path(): string
    {
        self::ffi();
        return self::$path;
    }

    /** Returns the shared library file names this platform uses. */
    private static function libraryNames(): array
    {
        if (PHP_OS_FAMILY === 'Windows') {
            return ['inillucent_driver_capi.dll'];
        }
        if (PHP_OS_FAMILY === 'Darwin') {
            return ['libinillucent_driver_capi.dylib'];
        }
        return ['libinillucent_driver_capi.so'];
    }

    /**
     * Returns every place the shared library is looked for, in order.
     *
     * The order is the same in all eight client libraries, so an application
     * that works in one works in the rest.
     *
     * @return string[]
     */
    public static function searchPaths(): array
    {
        $found = [];
        $named = getenv('INILLUCENT_DRIVER_LIB');
        if (is_string($named) && $named !== '') {
            $found[] = $named;
        }
        $repository = dirname(__DIR__, 2);
        $engines = [
            dirname($repository) . DIRECTORY_SEPARATOR . 'inillucent',
            dirname($repository, 2) . DIRECTORY_SEPARATOR . 'inillucent',
        ];
        foreach (self::libraryNames() as $name) {
            $found[] = $repository . DIRECTORY_SEPARATOR . 'native' . DIRECTORY_SEPARATOR . $name;
            foreach ($engines as $engine) {
                foreach (['release', 'debug'] as $profile) {
                    $found[] = $engine . DIRECTORY_SEPARATOR . 'target'
                        . DIRECTORY_SEPARATOR . $profile . DIRECTORY_SEPARATOR . $name;
                }
            }
        }
        return $found;
    }

    /**
     * Returns the path of the shared library, or throws saying where it looked.
     *
     * A message that names every place it tried is the difference between a
     * problem somebody can fix and one they have to guess at.
     */
    private static function resolveLibrary(): string
    {
        foreach (self::searchPaths() as $candidate) {
            if (is_file($candidate)) {
                return $candidate;
            }
        }
        throw new DriverLoadException(
            "cannot find the inillucent driver shared library. Looked in:\n  "
            . implode("\n  ", self::searchPaths())
            . "\nBuild it with\n  cargo build --release --manifest-path <engine>/Cargo.toml"
            . " -p inillucent-driver-capi\nthen run scripts/fetch-native.mjs, or set"
            . ' INILLUCENT_DRIVER_LIB to its path.'
        );
    }

    /**
     * Loads the library and refuses a major ABI mismatch by name.
     *
     * Calling a function whose signature has moved fails in a way nobody can
     * read, which is the whole reason the version exists.
     */
    private static function load(): void
    {
        if (!extension_loaded('FFI')) {
            throw new DriverLoadException(
                'the FFI extension is not loaded, and this client calls the engine through it.'
                . ' Add extension=ffi to php.ini, and ffi.enable=true if your build needs it.'
            );
        }
        $path = self::resolveLibrary();
        $ffi = FFI::cdef(self::DECLARATIONS, $path);

        $reported = $ffi->inillucent_abi_version();
        $major = intdiv($reported, 1000000);
        if ($major !== self::ABI_MAJOR) {
            throw new DriverLoadException(sprintf(
                '%s reports ABI %d.%d.%d, and this package was written for ABI %d.x. A major'
                . ' bump moves a signature, so calling it would fail in a way nobody can read.'
                . ' Install a matching driver.',
                $path,
                $major,
                intdiv($reported, 1000) % 1000,
                $reported % 1000,
                self::ABI_MAJOR
            ));
        }

        self::$ffi = $ffi;
        self::$path = $path;
    }

    /** Returns what the driver calls itself. */
    public static function version(): string
    {
        return self::readString(self::ffi()->inillucent_version()) ?? '';
    }

    /** Returns the shared library's ABI version as major.minor.patch. */
    public static function abiVersion(): string
    {
        $reported = self::ffi()->inillucent_abi_version();
        return sprintf(
            '%d.%d.%d',
            intdiv($reported, 1000000),
            intdiv($reported, 1000) % 1000,
            $reported % 1000
        );
    }

    /**
     * Returns every capability the engine declares.
     *
     * Ask this before composing a statement rather than after. Every row is
     * checked against the running engine by a test in both directions, so a
     * claim of support that fails and a claim of absence that now works each
     * turn it red.
     *
     * @return Capability[]
     */
    public static function capabilities(): array
    {
        $ffi = self::ffi();
        $count = $ffi->inillucent_capability_count();
        $found = [];
        for ($nth = 0; $nth < $count; $nth++) {
            $name = $ffi->new('const char*[1]');
            $state = $ffi->new('int[1]');
            $note = $ffi->new('const char*[1]');
            if ($ffi->inillucent_capability($nth, $name, $state, $note) !== 0) {
                continue;
            }
            $found[] = new Capability(
                self::readString($name[0]) ?? '',
                Support::fromCode($state[0]),
                self::readString($note[0]) ?? ''
            );
        }
        return $found;
    }

    /**
     * Returns whether the engine does something, by name.
     *
     * @param string $name the capability name
     */
    public static function supports(string $name): Support
    {
        return Support::fromCode(self::ffi()->inillucent_supports($name));
    }

    /**
     * Copies a C string the library returned into a PHP string.
     *
     * Every string is copied on the way out, because it points inside a handle
     * the caller may free. A null pointer becomes null, so a caller can tell
     * absent from empty.
     *
     * PHP's FFI converts a `char *` return value to a PHP string on its own, and
     * hands back a CData pointer everywhere else, so both shapes arrive here.
     *
     * @param mixed $pointer what the library handed back
     */
    public static function readString(mixed $pointer): ?string
    {
        if ($pointer === null) {
            return null;
        }
        if (is_string($pointer)) {
            return $pointer;
        }
        if (FFI::isNull($pointer)) {
            return null;
        }
        return FFI::string($pointer);
    }

    /**
     * Copies bytes into memory the ABI can read, never handing it a null pointer.
     *
     * The C ABI reads a null value pointer as NULL, deliberately. An empty
     * string and an empty blob are values, not NULL, so a zero length allocation
     * would otherwise store NULL. The length passed alongside stays 0, so the
     * spare byte is never read.
     *
     * @param string $bytes the bytes being bound
     */
    public static function buffer(string $bytes): FFI\CData
    {
        $length = strlen($bytes);
        $buffer = self::ffi()->new('char[' . max(1, $length) . ']');
        if ($length > 0) {
            FFI::memcpy($buffer, $bytes, $length);
        }
        return $buffer;
    }
}
