/**
 * The Inillucent client for TypeScript and JavaScript.
 *
 * Inillucent is an embedded database written in Rust. There is no server: your
 * program opens a file, sends SQL to a library in the same process, and gets
 * typed rows back.
 *
 * ```ts
 * import { connect } from 'inillucent';
 *
 * const db = connect('library.rdb');
 * db.execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)');
 * db.execute('INSERT INTO authors VALUES (?1, ?2)', [1, 'Octavia Butler']);
 * for (const author of db.query('SELECT id, name FROM authors')) {
 *   console.log(author.id, author.name);
 * }
 * db.close();
 * ```
 *
 * Two things about this engine shape the whole library.
 *
 * Values stay typed. NULL, integer, real, text and bytes come back as null,
 * number or bigint, number, string and Buffer, and NULL is not the empty string.
 *
 * The engine refuses what it has not built rather than answering it wrongly, and
 * that refusal has its own error type, `UnsupportedError`, carrying the name of
 * the construct it could not do. Ask `supports(...)` or read `capabilities()`
 * before composing a statement.
 */

export {
  Connection,
  Database,
  Statement,
  Transaction,
  connect,
  OPEN_CREATE,
  OPEN_DIAGNOSTICS,
  OPEN_READONLY,
  type OpenOptions,
} from './database.js';
export { Rows, ValueKind, type RowObject, type Value } from './rows.js';
export {
  DriverLoadError,
  InillucentError,
  Status,
  UnsupportedError,
  statusName,
  type StatusCode,
  type StatusName,
} from './errors.js';
export {
  Support,
  abiVersion,
  capabilities,
  driverPath,
  supports,
  version,
  type Capability,
  type SupportState,
} from './capabilities.js';
