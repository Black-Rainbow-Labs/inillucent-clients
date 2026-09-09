/**
 * One materialised result, copied out of the C handle into JavaScript.
 */

import { calls, readBytes } from './ffi.js';

export const ValueKind = { Null: 0, Integer: 1, Real: 2, Text: 3, Blob: 4 } as const;

/** Every value the engine stores, as it arrives in JavaScript. */
export type Value = null | number | bigint | string | Buffer;

/** A row as an object keyed by column name. */
export type RowObject = Record<string, Value>;

/**
 * Reads one cell as the kind it actually is.
 *
 * Text is not NUL terminated and may contain a NUL byte, so the length is read
 * rather than the bytes scanned. An integer that does not fit a double comes
 * back as a bigint, because rounding it to the nearest double would be this
 * library quietly changing the value.
 *
 * @param handle - the C result handle
 * @param row - the row index
 * @param column - the column index
 */
function readCell(handle: unknown, row: number, column: number): Value {
  const c = calls();
  const kind = c.value_type(handle, row, column) as number;
  if (kind === ValueKind.Null) return null;
  if (kind === ValueKind.Integer) {
    const whole = c.value_int(handle, row, column) as number | bigint;
    if (typeof whole === 'bigint') {
      return whole >= BigInt(Number.MIN_SAFE_INTEGER) && whole <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(whole)
        : whole;
    }
    return whole;
  }
  if (kind === ValueKind.Real) return c.value_real(handle, row, column) as number;
  const length: [number] = [0];
  const pointer = c.value_bytes(handle, row, column, length);
  const bytes = readBytes(pointer, Number(length[0]));
  return kind === ValueKind.Text ? bytes.toString('utf8') : bytes;
}

/**
 * Everything one statement produced.
 *
 * The engine materialises the result and this copies it into JavaScript, so the
 * object stays usable after the C handle is freed. That is what lets it be
 * returned from a function and read later.
 */
export class Rows {
  /** The result column names, in order. */
  readonly columns: string[];
  /** The type each column was declared with, or an empty string for an expression. */
  readonly columnTypes: string[];
  /** Every row handed back, in order. */
  readonly rows: Value[][];
  /**
   * How many rows the statement produced, exactly.
   *
   * The engine materialises, so this was counted rather than estimated, which is
   * what lets a grid say "1 to 200 of 4,317" and mean it.
   */
  readonly total: number;
  /** Whether the limit cut anything off. */
  readonly more: boolean;
  /** Rows changed, or null for a statement that changed nothing. */
  readonly affected: number | null;
  /** How long the engine spent on it. */
  readonly elapsedMicros: number;
  /** A one line summary for a status bar, such as "SELECT 27". */
  readonly tag: string;

  constructor(handle: unknown) {
    const c = calls();
    try {
      const count = Number(c.rows_column_count(handle));
      this.columns = [];
      this.columnTypes = [];
      for (let nth = 0; nth < count; nth += 1) {
        this.columns.push((c.rows_column_name(handle, nth) as string) ?? '');
        this.columnTypes.push((c.rows_column_type(handle, nth) as string) ?? '');
      }
      this.rows = [];
      const handed = Number(c.rows_count(handle));
      for (let row = 0; row < handed; row += 1) {
        const cells: Value[] = [];
        for (let column = 0; column < count; column += 1) cells.push(readCell(handle, row, column));
        this.rows.push(cells);
      }
      this.total = Number(c.rows_total(handle));
      this.more = Boolean(c.rows_more(handle));
      const changed = Number(c.rows_affected(handle));
      this.affected = changed < 0 ? null : changed;
      this.elapsedMicros = Number(c.rows_elapsed_us(handle));
      this.tag = (c.rows_tag(handle) as string) ?? '';
    } finally {
      c.rows_free(handle);
    }
  }

  /** How many rows were handed back. */
  get length(): number {
    return this.rows.length;
  }

  /**
   * Returns every row as an object keyed by column name.
   *
   * A duplicate column name would silently lose a value, so the later one wins
   * and a caller who needs both reads `rows` instead.
   */
  objects(): RowObject[] {
    return this.rows.map((row) => {
      const object: RowObject = {};
      this.columns.forEach((name, nth) => {
        object[name] = row[nth];
      });
      return object;
    });
  }

  /** Returns the first row, or undefined when the statement produced none. */
  one(): Value[] | undefined {
    return this.rows[0];
  }

  /**
   * Returns the first column of the first row, or undefined when there is none.
   *
   * This is the shape of a COUNT or a MAX, where unwrapping one number out of
   * two arrays is a cost the caller pays on every line.
   */
  scalar(): Value | undefined {
    return this.rows[0]?.[0];
  }

  /**
   * Returns one column of every row.
   * @param nthOrName - the column index, or its name
   */
  column(nthOrName: number | string): Value[] {
    const index = typeof nthOrName === 'number' ? nthOrName : this.columns.indexOf(nthOrName);
    if (index < 0) throw new RangeError(`there is no column named ${String(nthOrName)}`);
    return this.rows.map((row) => row[index]);
  }

  [Symbol.iterator](): Iterator<Value[]> {
    return this.rows[Symbol.iterator]();
  }
}
