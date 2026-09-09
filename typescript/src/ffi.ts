/**
 * Finding the shared library, loading it once, checking its ABI, and declaring
 * every function this package calls.
 *
 * Handles are passed as `void *` because nothing here ever reads through one.
 * Values that may contain a NUL byte are declared as byte pointers rather than
 * as `char *`, since a C string conversion would truncate them silently.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { DriverLoadError } from './errors.js';

const require = createRequire(import.meta.url);
// koffi ships prebuilt binaries, so nothing here needs a C compiler.
const koffi = require('koffi');

/** The ABI this package was written against. Only the major has to match. */
export const ABI_MAJOR = 1;

/**
 * Returns the shared library file names this platform uses.
 */
function libraryNames(): string[] {
  if (process.platform === 'win32') return ['inillucent_driver_capi.dll'];
  if (process.platform === 'darwin') return ['libinillucent_driver_capi.dylib'];
  return ['libinillucent_driver_capi.so'];
}

/**
 * Returns every place the shared library is looked for, in order.
 *
 * The order is the same in all eight client libraries, so an application that
 * works in one works in the rest.
 */
export function searchPaths(): string[] {
  const named = process.env.INILLUCENT_DRIVER_LIB;
  const found = named ? [named] : [];
  const here = dirname(fileURLToPath(import.meta.url));
  // `here` is dist/ inside the package, so the package root is one up and the
  // clients repository, when this is a checkout rather than an install, is two.
  const packageRoot = resolve(here, '..');
  const repo = resolve(here, '..', '..');
  const engines = [resolve(repo, '..', 'inillucent'), resolve(repo, '..', '..', 'inillucent')];
  for (const name of libraryNames()) {
    found.push(join(packageRoot, 'native', name));
    found.push(join(repo, 'native', name));
    for (const engine of engines) {
      for (const profile of ['release', 'debug']) found.push(join(engine, 'target', profile, name));
    }
  }
  return found;
}

/**
 * Returns the path of the shared library, or throws saying where it looked.
 *
 * A message that names every place it tried is the difference between a problem
 * somebody can fix and one they have to guess at.
 */
export function resolveLibrary(): string {
  for (const candidate of searchPaths()) if (existsSync(candidate)) return candidate;
  throw new DriverLoadError(
    'cannot find the inillucent driver shared library. Looked in:\n  ' +
      searchPaths().join('\n  ') +
      '\nBuild it with\n' +
      '  cargo build --release --manifest-path <engine>/Cargo.toml -p inillucent-driver-capi\n' +
      'then run scripts/fetch-native.mjs, or set INILLUCENT_DRIVER_LIB to its path.',
  );
}

export type DriverFunctions = Record<string, (...args: never[]) => unknown>;

/**
 * Declares every symbol against the loaded library.
 * @param lib - the koffi library handle
 */
function declare(lib: { func: (signature: string) => unknown }): Record<string, Function> {
  const of = (signature: string) => lib.func(signature) as Function;
  return {
    abi_version: of('uint32_t inillucent_abi_version()'),
    version: of('const char *inillucent_version()'),
    capability_count: of('size_t inillucent_capability_count()'),
    capability: of('int32_t inillucent_capability(size_t nth, _Out_ char **name, _Out_ int32_t *state, _Out_ char **note)'),
    supports: of('int32_t inillucent_supports(const char *name)'),

    open: of('int32_t inillucent_open(const char *path, uint32_t flags, _Out_ void **out, _Out_ void **error)'),
    close: of('int32_t inillucent_close(void *db, _Out_ void **error)'),
    checkpoint: of('int32_t inillucent_checkpoint(void *db, _Out_ void **error)'),
    integrity_check: of('int32_t inillucent_integrity_check(void *db, _Out_ void **error)'),
    backup_to: of('int32_t inillucent_backup_to(void *db, const char *path, _Out_ void **error)'),
    path: of('const char *inillucent_path(void *db)'),

    connect: of('int32_t inillucent_connect(void *db, _Out_ void **out, _Out_ void **error)'),
    conn_free: of('void inillucent_conn_free(void *conn)'),
    execute: of('int32_t inillucent_execute(void *conn, const char *sql, uint64_t limit, _Out_ void **out, _Out_ void **error)'),
    execute_batch: of('int32_t inillucent_execute_batch(void *conn, const char *sql, _Out_ void **error)'),
    last_insert_rowid: of('int64_t inillucent_last_insert_rowid(void *conn)'),
    total_changes: of('int64_t inillucent_total_changes(void *conn)'),
    in_transaction: of('int32_t inillucent_in_transaction(void *conn)'),
    schema_cookie: of('uint64_t inillucent_schema_cookie(void *conn)'),
    cancel: of('int32_t inillucent_cancel(void *conn, _Out_ void **error)'),

    prepare: of('int32_t inillucent_prepare(void *conn, const char *sql, _Out_ void **out, _Out_ void **error)'),
    stmt_free: of('void inillucent_stmt_free(void *stmt)'),
    bind_null: of('int32_t inillucent_bind_null(void *stmt, uint32_t index)'),
    bind_int: of('int32_t inillucent_bind_int(void *stmt, uint32_t index, int64_t value)'),
    bind_real: of('int32_t inillucent_bind_real(void *stmt, uint32_t index, double value)'),
    bind_text: of('int32_t inillucent_bind_text(void *stmt, uint32_t index, uint8_t *value, size_t len)'),
    bind_blob: of('int32_t inillucent_bind_blob(void *stmt, uint32_t index, uint8_t *value, size_t len)'),
    clear_bindings: of('void inillucent_clear_bindings(void *stmt)'),
    stmt_execute: of('int32_t inillucent_stmt_execute(void *stmt, uint64_t limit, _Out_ void **out, _Out_ void **error)'),

    rows_free: of('void inillucent_rows_free(void *rows)'),
    rows_column_count: of('size_t inillucent_rows_column_count(void *rows)'),
    rows_column_name: of('const char *inillucent_rows_column_name(void *rows, size_t nth)'),
    rows_column_type: of('const char *inillucent_rows_column_type(void *rows, size_t nth)'),
    rows_count: of('size_t inillucent_rows_count(void *rows)'),
    rows_total: of('size_t inillucent_rows_total(void *rows)'),
    rows_more: of('int32_t inillucent_rows_more(void *rows)'),
    rows_affected: of('int64_t inillucent_rows_affected(void *rows)'),
    rows_elapsed_us: of('uint64_t inillucent_rows_elapsed_us(void *rows)'),
    rows_tag: of('const char *inillucent_rows_tag(void *rows)'),
    value_type: of('int32_t inillucent_value_type(void *rows, size_t row, size_t column)'),
    value_int: of('int64_t inillucent_value_int(void *rows, size_t row, size_t column)'),
    value_real: of('double inillucent_value_real(void *rows, size_t row, size_t column)'),
    value_bytes: of('void *inillucent_value_bytes(void *rows, size_t row, size_t column, _Out_ size_t *len)'),

    txn_begin: of('int32_t inillucent_txn_begin(void *conn, _Out_ void **out, _Out_ void **error)'),
    txn_execute: of('int32_t inillucent_txn_execute(void *txn, const char *sql, _Out_ uint64_t *affected, _Out_ void **error)'),
    txn_commit: of('int32_t inillucent_txn_commit(void *txn, _Out_ void **error)'),
    txn_rollback: of('void inillucent_txn_rollback(void *txn)'),

    error_status: of('int32_t inillucent_error_status(void *error)'),
    error_message: of('const char *inillucent_error_message(void *error)'),
    error_feature: of('const char *inillucent_error_feature(void *error)'),
    error_detail: of('const char *inillucent_error_detail(void *error)'),
    error_offset: of('int32_t inillucent_error_offset(void *error)'),
    error_free: of('void inillucent_error_free(void *error)'),
  };
}

let loaded: { calls: Record<string, Function>; path: string } | undefined;

/**
 * Returns the loaded driver, loading and version checking it the first time it
 * is asked for.
 *
 * The major ABI is refused by name before anything else is called, because
 * calling a function whose signature has moved fails in a way nobody can read.
 */
export function driver(): { calls: Record<string, Function>; path: string } {
  if (loaded) return loaded;
  const path = resolveLibrary();
  const lib = koffi.load(path);
  const calls = declare(lib);
  const reported = calls.abi_version() as number;
  const major = Math.floor(reported / 1_000_000);
  if (major !== ABI_MAJOR) {
    const minor = Math.floor(reported / 1000) % 1000;
    throw new DriverLoadError(
      `${path} reports ABI ${major}.${minor}.${reported % 1000}, and this package was ` +
        `written for ABI ${ABI_MAJOR}.x. A major bump moves a signature, so calling it ` +
        'would fail in a way nobody can read. Install a matching driver.',
    );
  }
  loaded = { calls, path };
  return loaded;
}

/** Returns the driver's call table. */
export function calls(): Record<string, Function> {
  return driver().calls;
}

/**
 * Reads `length` bytes out of a pointer the library returned.
 * @param pointer - the pointer the library handed back
 * @param length - how many bytes to copy
 */
export function readBytes(pointer: unknown, length: number): Buffer {
  if (!pointer || length === 0) return Buffer.alloc(0);
  return Buffer.from(koffi.decode(pointer, koffi.array('uint8_t', length, 'Typed')) as Uint8Array);
}

/** The largest limit the C ABI accepts, which is every row. */
export const NO_LIMIT = 0xffffffffffffffffn;
