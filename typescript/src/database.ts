/**
 * The database, connection, statement and transaction objects.
 *
 * Every handle is owned by exactly one object and freed once. A child holds a
 * reference to its parent, so a database cannot be collected while a connection
 * on it is still alive.
 */

import { check } from './check.js';
import { NO_LIMIT, calls } from './ffi.js';
import { Rows, type RowObject, type Value } from './rows.js';

export const OPEN_CREATE = 0x0001;
export const OPEN_READONLY = 0x0002;
export const OPEN_DIAGNOSTICS = 0x0004;

/** How a database file is opened. */
export interface OpenOptions {
  /** Create the file when it is not there. Defaults to true. */
  create?: boolean;
  /** Refuse anything but a query. Defaults to false. */
  readOnly?: boolean;
  /**
   * Collect internal diagnostic text on failures. Defaults to false.
   *
   * Diagnostics may hold a file system path or a bound value, so do not show
   * them to a person and do not send them to a shared log.
   */
  diagnostics?: boolean;
}

/**
 * Returns the C limit for a caller's limit, where undefined is every row.
 * @param limit - rows to hand back, or undefined
 */
function capped(limit?: number): bigint {
  return limit === undefined ? NO_LIMIT : BigInt(limit);
}

/**
 * Returns a buffer that is never zero length, so the pointer handed to the ABI
 * is never null.
 *
 * The C ABI reads a null value pointer as NULL, deliberately. An empty string
 * and an empty blob are values, not NULL, and a zero length buffer reaches the
 * ABI as a null pointer, so binding `''` would quietly store NULL instead. The
 * length passed alongside stays 0, so the spare byte is never read.
 *
 * @param bytes - the bytes being bound
 */
function nonNull(bytes: Buffer): Buffer {
  return bytes.length === 0 ? Buffer.alloc(1) : bytes;
}

/**
 * Turns open options into the flags the C ABI takes.
 * @param options - what the caller asked for
 */
function openFlags(options: OpenOptions): number {
  let flags = 0;
  if (options.create !== false) flags |= OPEN_CREATE;
  if (options.readOnly) flags |= OPEN_READONLY;
  if (options.diagnostics) flags |= OPEN_DIAGNOSTICS;
  return flags;
}

/**
 * One transaction, held open while the caller decides whether to commit.
 *
 * This is a handle rather than a pair of calls because a check on what a write
 * did has to happen before the commit. A postcondition tested afterwards is a
 * report about something that has already happened.
 */
export class Transaction {
  /** How many rows each statement in this transaction changed, in order. */
  readonly affected: number[] = [];
  #handle: unknown;

  constructor(handle: unknown) {
    this.#handle = handle;
  }

  /**
   * Runs one statement inside the transaction and returns the rows it changed.
   *
   * A failure rolls the whole transaction back before it throws, so a caller
   * that stops at the first error has already undone everything.
   *
   * @param sql - the statement to run
   */
  execute(sql: string): number {
    const changed: [number] = [0];
    const error: [unknown] = [null];
    check(calls().txn_execute(this.#handle, sql, changed, error) as number, error);
    const count = Number(changed[0]);
    this.affected.push(count);
    return count;
  }

  /** Commits the transaction. The handle is spent either way. */
  commit(): void {
    if (!this.#handle) return;
    const error: [unknown] = [null];
    const status = calls().txn_commit(this.#handle, error) as number;
    const handle = this.#handle;
    this.#handle = undefined;
    try {
      check(status, error);
    } finally {
      calls().txn_rollback(handle);
    }
  }

  /** Rolls the transaction back and frees it. */
  rollback(): void {
    if (!this.#handle) return;
    calls().txn_rollback(this.#handle);
    this.#handle = undefined;
  }
}

/** A compiled statement and the values bound to it. */
export class Statement {
  #handle: unknown;
  readonly #connection: Connection;

  constructor(connection: Connection, handle: unknown) {
    this.#connection = connection;
    this.#handle = handle;
  }

  /**
   * Binds these values, runs the statement, and returns what it produced.
   * @param params - values for ?1, ?2 and so on, in order
   * @param limit - rows to hand back, or undefined for every row
   */
  execute(params: readonly Value[] = [], limit?: number): Rows {
    const c = calls();
    c.clear_bindings(this.#handle);
    params.forEach((value, nth) => this.bind(nth + 1, value));
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(c.stmt_execute(this.#handle, capped(limit), out, error) as number, error);
    return new Rows(out[0]);
  }

  /**
   * Binds one value, choosing the call by the JavaScript type.
   * @param index - the one based parameter position
   * @param value - what to bind
   */
  bind(index: number, value: Value | boolean | undefined): void {
    const c = calls();
    if (value === null || value === undefined) {
      c.bind_null(this.#handle, index);
    } else if (typeof value === 'boolean') {
      c.bind_int(this.#handle, index, value ? 1 : 0);
    } else if (typeof value === 'bigint') {
      c.bind_int(this.#handle, index, value);
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) c.bind_int(this.#handle, index, value);
      else c.bind_real(this.#handle, index, value);
    } else if (typeof value === 'string') {
      const bytes = Buffer.from(value, 'utf8');
      c.bind_text(this.#handle, index, nonNull(bytes), bytes.length);
    } else if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
      c.bind_blob(this.#handle, index, nonNull(bytes), bytes.length);
    } else {
      throw new TypeError(
        `cannot bind a ${typeof value}. The engine stores NULL, integers, reals, text and ` +
          'bytes, and converting anything else would be this library deciding what your ' +
          'value means.',
      );
    }
  }

  /** Frees the statement. */
  close(): void {
    if (!this.#handle) return;
    calls().stmt_free(this.#handle);
    this.#handle = undefined;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * One connection to a database, and one session.
 *
 * Temp tables, ATTACH and the connection pragmas are scoped to the session this
 * connection holds, so they last as long as it does.
 */
export class Connection {
  #handle: unknown;
  readonly #database: Database;
  #ownsDatabase: boolean;

  constructor(database: Database, handle: unknown, ownsDatabase = false) {
    this.#database = database;
    this.#handle = handle;
    this.#ownsDatabase = ownsDatabase;
  }

  /**
   * Runs one statement and returns everything it produced.
   *
   * `limit` caps the rows handed back, not the rows produced. `Rows.total` is
   * exact either way, because the engine materialises and the count was taken
   * rather than estimated.
   *
   * @param sql - the statement to run
   * @param params - values for ?1, ?2 and so on, in order
   * @param limit - rows to hand back, or undefined for every row
   */
  execute(sql: string, params: readonly Value[] = [], limit?: number): Rows {
    if (params.length > 0) {
      const statement = this.prepare(sql);
      try {
        return statement.execute(params, limit);
      } finally {
        statement.close();
      }
    }
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(calls().execute(this.#handle, sql, capped(limit), out, error) as number, error);
    return new Rows(out[0]);
  }

  /**
   * Runs one statement and returns its rows as objects keyed by column name.
   * @param sql - the statement to run
   * @param params - values for ?1, ?2 and so on, in order
   * @param limit - rows to hand back, or undefined for every row
   */
  query(sql: string, params: readonly Value[] = [], limit?: number): RowObject[] {
    return this.execute(sql, params, limit).objects();
  }

  /**
   * Runs one statement and returns the first column of its first row.
   * @param sql - the statement to run
   * @param params - values for ?1, ?2 and so on, in order
   */
  scalar(sql: string, params: readonly Value[] = []): Value | undefined {
    return this.execute(sql, params, 1).scalar();
  }

  /**
   * Runs several statements separated by semicolons, for their effect.
   * @param sql - the statements to run
   */
  executeBatch(sql: string): void {
    const error: [unknown] = [null];
    check(calls().execute_batch(this.#handle, sql, error) as number, error);
  }

  /**
   * Compiles a statement so it can be run more than once.
   * @param sql - the statement to compile
   */
  prepare(sql: string): Statement {
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(calls().prepare(this.#handle, sql, out, error) as number, error);
    return new Statement(this, out[0]);
  }

  /** Opens a transaction. */
  transaction(): Transaction {
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(calls().txn_begin(this.#handle, out, error) as number, error);
    return new Transaction(out[0]);
  }

  /** The rowid the most recent insert on this connection produced. */
  get lastInsertRowid(): number {
    return Number(calls().last_insert_rowid(this.#handle));
  }

  /** How many rows every statement on this connection has changed. */
  get totalChanges(): number {
    return Number(calls().total_changes(this.#handle));
  }

  /** Whether a transaction is open on this connection. */
  get inTransaction(): boolean {
    return Boolean(calls().in_transaction(this.#handle));
  }

  /**
   * The schema's generation, which changes when the schema does.
   *
   * Compare it to know whether a cached table description is stale.
   */
  get schemaCookie(): number {
    return Number(calls().schema_cookie(this.#handle));
  }

  /**
   * Asks a running statement to stop.
   *
   * This always throws Unsupported today, and `supports('cancel')` says so
   * before an application draws a Stop button: the engine runs a statement whole
   * rather than a row at a time, so there is no point at which it could notice.
   */
  cancel(): void {
    const error: [unknown] = [null];
    check(calls().cancel(this.#handle, error) as number, error);
  }

  /**
   * Makes closing this connection close its database too.
   *
   * `connect()` calls this, because a caller who was never handed a database has
   * nothing else to close.
   */
  takeOwnershipOfDatabase(): void {
    this.#ownsDatabase = true;
  }

  /**
   * Frees the connection, and the database too when this connection owns it.
   *
   * A connection from `connect()` owns its database, because the caller was
   * never handed one to close.
   */
  close(): void {
    if (!this.#handle) return;
    calls().conn_free(this.#handle);
    this.#handle = undefined;
    if (this.#ownsDatabase) this.#database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * One open database file.
 *
 * One file is one buffer pool and the engine is single threaded, so keep a
 * database and everything under it on one thread. There is no lock inside.
 */
export class Database {
  #handle: unknown;
  readonly #connections: Connection[] = [];

  constructor(path: string, options: OpenOptions = {}) {
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(calls().open(path, openFlags(options), out, error) as number, error);
    this.#handle = out[0];
  }

  /** Opens a connection, and with it a session. */
  connect(): Connection {
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(calls().connect(this.#handle, out, error) as number, error);
    const connection = new Connection(this, out[0]);
    this.#connections.push(connection);
    return connection;
  }

  /** The file this database is in. */
  get path(): string {
    return (calls().path(this.#handle) as string) ?? '';
  }

  /** Makes everything written so far durable in the file. */
  checkpoint(): void {
    const error: [unknown] = [null];
    check(calls().checkpoint(this.#handle, error) as number, error);
  }

  /** Walks every tree and throws on the first thing that is wrong. */
  integrityCheck(): void {
    const error: [unknown] = [null];
    check(calls().integrity_check(this.#handle, error) as number, error);
  }

  /**
   * Copies the database to a path, opening and checking the copy first.
   *
   * A backup nobody checked is a file that is assumed to be a database.
   *
   * @param path - where to write the copy
   */
  backupTo(path: string): void {
    const error: [unknown] = [null];
    check(calls().backup_to(this.#handle, path, error) as number, error);
  }

  /**
   * Checkpoints and closes, closing every connection first.
   *
   * The C library refuses to close a database that still has connections on it,
   * which is deliberate: freeing it then would leave them pointing at memory
   * that is gone.
   */
  close(): void {
    if (!this.#handle) return;
    for (const connection of this.#connections) connection.close();
    this.#connections.length = 0;
    const error: [unknown] = [null];
    const status = calls().close(this.#handle, error) as number;
    this.#handle = undefined;
    check(status, error);
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * Opens a database and returns a connection on it, in one call.
 *
 * This is the shape most applications want, and closing the connection closes
 * the database with it.
 *
 * @param path - the database file
 * @param options - how to open it
 */
export function connect(path: string, options: OpenOptions = {}): Connection {
  const connection = new Database(path, options).connect();
  connection.takeOwnershipOfDatabase();
  return connection;
}
