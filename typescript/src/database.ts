/**
 * The database, connection, statement and transaction objects.
 *
 * Every handle is owned by exactly one object and freed once. A child holds a
 * reference to its parent, so a database cannot be collected while a connection
 * on it is still alive.
 */

import { check } from './check.js';
import { InillucentError, Status } from './errors.js';
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
  /**
   * Opens, and by default creates, an encrypted database.
   *
   * `x'<64 hex digits>'` is a raw 32 byte key. Anything else is a passphrase,
   * which is stretched with PBKDF2 and costs about 0.25 seconds per open. A
   * wrong key, a key for a plaintext file and no key for an encrypted file all
   * fail with `Status.Corrupt`. Leave it out for a plaintext database.
   */
  key?: string;
}

/** The database each connection, statement and transaction belongs to. */
const owners = new WeakMap<object, Database>();

/** The statements and transactions still alive on each database. */
const children = new WeakMap<Database, Set<object>>();

/** The databases that have a call running on a worker thread right now. */
const running = new WeakSet<Database>();

/**
 * Frees a connection's handle without closing the database it may own.
 *
 * It is a symbol rather than a method name so that it stays out of the public
 * API. `Database.close()` uses it, because calling `Connection.close()` there
 * would close the database again from inside its own close.
 */
export const releaseHandle = Symbol('releaseHandle');

/** How koffi calls a declared function on a worker thread. */
type AsyncCall = { async: (...args: unknown[]) => void };

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
 * Records that a statement or transaction is alive on a database.
 * @param child - the statement or transaction
 * @param database - the database it was made on
 */
function track(child: object, database: Database | undefined): void {
  if (!database) return;
  owners.set(child, database);
  children.get(database)?.add(child);
}

/**
 * Records that a statement or transaction has been freed.
 * @param child - the statement or transaction
 */
function untrack(child: object): void {
  const database = owners.get(child);
  if (database) children.get(database)?.delete(child);
}

/**
 * Throws `Status.Busy` while a call started with `executeAsync` is still running
 * on the database this object belongs to.
 *
 * The engine is single threaded and has no lock inside, so a second call made
 * while the first runs on a worker thread would race it. `cancel()` is the one
 * call that is safe from another thread, and it does not come through here.
 *
 * @param of - a database, or a connection, statement or transaction on one
 */
function assertIdle(of: object): void {
  const database = of instanceof Database ? of : owners.get(of);
  if (!database || !running.has(database)) return;
  throw new InillucentError(
    Status.Busy,
    'a statement started with executeAsync is still running on this database. ' +
      'Wait for it to finish, or call cancel() on its connection',
  );
}

/** Returns the error for a call on a transaction that has already ended. */
function transactionEnded(): InillucentError {
  return new InillucentError(
    Status.InvalidState,
    'the transaction has already ended, by a commit, a rollback, or a statement that failed and rolled it back',
  );
}

/**
 * Runs one C call that produces a result on a koffi worker thread, and resolves
 * with the result copied into JavaScript.
 *
 * The database is marked as running until the call settles, so every other
 * call on it is refused with `Status.Busy` instead of racing this one.
 *
 * @param database - the database the call runs on
 * @param fn - the declared C function, which takes `out` and `error` last
 * @param args - every argument before `out` and `error`
 */
function runAsync(database: Database, fn: unknown, args: unknown[]): Promise<Rows> {
  const out: [unknown] = [null];
  const error: [unknown] = [null];
  running.add(database);
  return new Promise((resolve, reject) => {
    (fn as AsyncCall).async(...args, out, error, (failure: unknown, status: number) => {
      running.delete(database);
      try {
        if (failure) throw failure;
        check(status, error);
        resolve(new Rows(out[0]));
      } catch (why) {
        reject(why);
      }
    });
  });
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
 * Calls `inillucent_open_with_key` when a key was given and `inillucent_open`
 * otherwise. The key is passed straight to the driver and is never logged.
 * @param path - the database file
 * @param options - how to open it, including an optional key
 * @param out - receives the database handle
 * @param error - receives the driver's error handle on failure
 */
function openNative(path: string, options: OpenOptions, out: [unknown], error: [unknown]): number {
  const flags = openFlags(options);
  if (options.key !== undefined) return calls().open_with_key(path, flags, options.key, out, error) as number;
  return calls().open(path, flags, out, error) as number;
}

/**
 * One transaction, held open while the caller decides whether to commit.
 *
 * The caller holds it open, runs statements, reads how many rows each one
 * changed, and only then commits. A check made after the commit cannot stop the
 * write it was checking.
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
   * that stops at the first error has already undone everything. The handle is
   * spent then, so it is freed here, and a later `execute` or `commit` fails
   * with `Status.InvalidState`.
   *
   * @param sql - the statement to run
   */
  execute(sql: string): number {
    if (!this.#handle) throw transactionEnded();
    assertIdle(this);
    const changed: [number] = [0];
    const error: [unknown] = [null];
    const status = calls().txn_execute(this.#handle, sql, changed, error) as number;
    if (status !== Status.Ok) this.#free();
    check(status, error);
    const count = Number(changed[0]);
    this.affected.push(count);
    return count;
  }

  /**
   * Commits the transaction. The handle is spent either way.
   *
   * Committing a transaction that has already ended fails with
   * `Status.InvalidState`, because a caller who believes a write was committed
   * when it was not has lost that write without knowing.
   */
  commit(): void {
    if (!this.#handle) throw transactionEnded();
    assertIdle(this);
    const error: [unknown] = [null];
    const status = calls().txn_commit(this.#handle, error) as number;
    this.#free();
    check(status, error);
  }

  /** Rolls the transaction back and frees it. Rolling back an ended transaction does nothing. */
  rollback(): void {
    if (!this.#handle) return;
    assertIdle(this);
    this.#free();
  }

  /**
   * Frees the handle. `inillucent_txn_rollback` is the only free the ABI has,
   * and after a commit or a failure it frees without undoing anything.
   */
  #free(): void {
    calls().txn_rollback(this.#handle);
    this.#handle = undefined;
    untrack(this);
  }

  /** Rolls back a transaction that was neither committed nor rolled back. */
  [Symbol.dispose](): void {
    this.rollback();
  }
}

/**
 * Binds one value with the call its JavaScript type needs, and returns the
 * status the call reported.
 * @param handle - the statement handle
 * @param index - the one based parameter position
 * @param value - what to bind
 */
function bindOne(handle: unknown, index: number, value: Value | boolean | undefined): number {
  const c = calls();
  if (value === null || value === undefined) return c.bind_null(handle, index) as number;
  if (typeof value === 'boolean') return c.bind_int(handle, index, value ? 1 : 0) as number;
  if (typeof value === 'bigint') return c.bind_int(handle, index, value) as number;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return c.bind_int(handle, index, value) as number;
    return c.bind_real(handle, index, value) as number;
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return c.bind_text(handle, index, nonNull(bytes), bytes.length) as number;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    return c.bind_blob(handle, index, nonNull(bytes), bytes.length) as number;
  }
  throw new TypeError(
    `cannot bind a ${typeof value}. The engine stores NULL, integers, reals, text and ` +
      'bytes, and converting anything else would be this library deciding what your ' +
      'value means.',
  );
}

/** A compiled statement and the values bound to it. */
export class Statement {
  #handle: unknown;
  readonly #connection: Connection;

  constructor(connection: Connection, handle: unknown) {
    this.#connection = connection;
    this.#handle = handle;
    track(this, owners.get(connection));
  }

  /**
   * Binds these values, runs the statement, and returns what it produced.
   * @param params - values for ?1, ?2 and so on, in order
   * @param limit - rows to hand back, or undefined for every row
   */
  execute(params: readonly Value[] = [], limit?: number): Rows {
    this.#bindAll(params);
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(calls().stmt_execute(this.#handle, capped(limit), out, error) as number, error);
    return new Rows(out[0]);
  }

  /**
   * Binds these values and runs the statement on a worker thread, so the event
   * loop stays free and `cancel()` on the connection can stop it.
   *
   * Every other call on this database is refused with `Status.Busy` until the
   * promise settles, because the engine has no lock inside.
   *
   * @param params - values for ?1, ?2 and so on, in order
   * @param limit - rows to hand back, or undefined for every row
   */
  executeAsync(params: readonly Value[] = [], limit?: number): Promise<Rows> {
    this.#bindAll(params);
    return runAsync(owners.get(this.#connection)!, calls().stmt_execute, [this.#handle, capped(limit)]);
  }

  /**
   * Clears the previous bindings and binds these values in order.
   * @param params - values for ?1, ?2 and so on, in order
   */
  #bindAll(params: readonly Value[]): void {
    assertIdle(this);
    calls().clear_bindings(this.#handle);
    params.forEach((value, nth) => this.bind(nth + 1, value));
  }

  /**
   * Binds one value, choosing the call by the JavaScript type.
   *
   * The engine refuses a position past the statement's last placeholder with
   * `Status.InvalidState`, and so does a closed statement. That refusal is
   * thrown rather than ignored, because ignoring it drops the value silently.
   *
   * @param index - the one based parameter position
   * @param value - what to bind
   */
  bind(index: number, value: Value | boolean | undefined): void {
    assertIdle(this);
    const status = bindOne(this.#handle, index, value);
    if (status === Status.Ok) return;
    throw new InillucentError(
      status,
      `binding ?${index} was refused: the statement has fewer placeholders than that, or it is closed`,
    );
  }

  /** Frees the statement. Closing it a second time does nothing. */
  close(): void {
    if (!this.#handle) return;
    assertIdle(this);
    calls().stmt_free(this.#handle);
    this.#handle = undefined;
    untrack(this);
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
    owners.set(this, database);
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
    assertIdle(this);
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
   * Runs one statement on a worker thread and resolves with everything it
   * produced.
   *
   * The event loop stays free while it runs, so a timer, a request handler or a
   * Stop button can call `cancel()` and the statement fails with
   * `Status.Interrupted`. Every other call on this database is refused with
   * `Status.Busy` until the promise settles, because the engine is single
   * threaded and has no lock inside.
   *
   * @param sql - the statement to run
   * @param params - values for ?1, ?2 and so on, in order
   * @param limit - rows to hand back, or undefined for every row
   */
  async executeAsync(sql: string, params: readonly Value[] = [], limit?: number): Promise<Rows> {
    assertIdle(this);
    if (params.length > 0) {
      const statement = this.prepare(sql);
      try {
        return await statement.executeAsync(params, limit);
      } finally {
        statement.close();
      }
    }
    return runAsync(this.#database, calls().execute, [this.#handle, sql, capped(limit)]);
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
    assertIdle(this);
    const error: [unknown] = [null];
    check(calls().execute_batch(this.#handle, sql, error) as number, error);
  }

  /**
   * Compiles a statement so it can be run more than once.
   * @param sql - the statement to compile
   */
  prepare(sql: string): Statement {
    assertIdle(this);
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(calls().prepare(this.#handle, sql, out, error) as number, error);
    return new Statement(this, out[0]);
  }

  /** Opens a transaction. */
  transaction(): Transaction {
    assertIdle(this);
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(calls().txn_begin(this.#handle, out, error) as number, error);
    const transaction = new Transaction(out[0]);
    track(transaction, this.#database);
    return transaction;
  }

  /** The rowid the most recent insert on this connection produced. */
  get lastInsertRowid(): number {
    assertIdle(this);
    return Number(calls().last_insert_rowid(this.#handle));
  }

  /** How many rows every statement on this connection has changed. */
  get totalChanges(): number {
    assertIdle(this);
    return Number(calls().total_changes(this.#handle));
  }

  /** Whether a transaction is open on this connection. */
  get inTransaction(): boolean {
    assertIdle(this);
    return Boolean(calls().in_transaction(this.#handle));
  }

  /**
   * The schema's generation, which changes when the schema does.
   *
   * Compare it to know whether a cached table description is stale.
   */
  get schemaCookie(): number {
    assertIdle(this);
    return Number(calls().schema_cookie(this.#handle));
  }

  /**
   * Asks a running statement to stop.
   *
   * `supports('cancel')` is `Support.Partial`. A running statement stops with
   * `Status.Interrupted` at the next point the executor checks, which is every
   * leaf of a scan and every batch a result collects, and the connection stays
   * usable. A single operator part-way through one indivisible piece of work,
   * such as a sort of the rows it has already read, finishes first. Draw a Stop
   * button, but do not promise it is instant.
   *
   * A statement run with `execute` blocks the event loop until it ends, so
   * nothing in the same thread can call this while it runs. Start the statement
   * with `executeAsync` to be able to stop it.
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

  /** Frees the connection's handle and nothing else. `Database.close()` calls it. */
  [releaseHandle](): void {
    if (!this.#handle) return;
    calls().conn_free(this.#handle);
    this.#handle = undefined;
  }

  /**
   * Frees the connection, and the database too when this connection owns it.
   *
   * A connection from `connect()` owns its database, because the caller was
   * never handed one to close. When the engine refuses to close that database
   * because a statement or transaction is still alive, the database stays open,
   * and calling this again after freeing them closes it.
   */
  close(): void {
    assertIdle(this);
    this[releaseHandle]();
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
    check(openNative(path, options, out, error), error);
    this.#handle = out[0];
    children.set(this, new Set());
  }

  /** Opens a connection, and with it a session. */
  connect(): Connection {
    assertIdle(this);
    const out: [unknown] = [null];
    const error: [unknown] = [null];
    check(calls().connect(this.#handle, out, error) as number, error);
    const connection = new Connection(this, out[0]);
    this.#connections.push(connection);
    return connection;
  }

  /** The file this database is in. */
  get path(): string {
    assertIdle(this);
    return (calls().path(this.#handle) as string) ?? '';
  }

  /** Makes everything written so far durable in the file. */
  checkpoint(): void {
    assertIdle(this);
    const error: [unknown] = [null];
    check(calls().checkpoint(this.#handle, error) as number, error);
  }

  /** Walks every tree and throws on the first thing that is wrong. */
  integrityCheck(): void {
    assertIdle(this);
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
    assertIdle(this);
    const error: [unknown] = [null];
    check(calls().backup_to(this.#handle, path, error) as number, error);
  }

  /**
   * Checkpoints and closes, closing every connection first.
   *
   * The C library refuses to close a database while a statement or transaction
   * made on it is still alive, and throws `Status.InvalidState`. The database
   * then stays open and usable, and so do its connections: they are freed only
   * when nothing else is alive, so a refused close takes nothing away. Free the
   * statement or transaction and call this again.
   */
  close(): void {
    if (!this.#handle) return;
    assertIdle(this);
    if (children.get(this)?.size === 0) this.#releaseConnections();
    const error: [unknown] = [null];
    check(calls().close(this.#handle, error) as number, error);
    this.#handle = undefined;
  }

  /** Frees the handle of every connection made on this database. */
  #releaseConnections(): void {
    for (const connection of this.#connections) connection[releaseHandle]();
    this.#connections.length = 0;
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
