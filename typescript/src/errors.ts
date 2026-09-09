/**
 * Failures the engine reports, and the status codes behind them.
 */

export const Status = {
  Ok: 0,
  Unsupported: 1,
  Syntax: 2,
  NotFound: 3,
  Constraint: 4,
  ReadOnly: 5,
  Busy: 6,
  Interrupted: 7,
  Corrupt: 8,
  Io: 9,
  Full: 10,
  TooBig: 11,
  InvalidState: 12,
  Internal: 13,
} as const;

export type StatusCode = (typeof Status)[keyof typeof Status];

export type StatusName =
  | 'ok'
  | 'unsupported'
  | 'syntax'
  | 'not_found'
  | 'constraint'
  | 'readonly'
  | 'busy'
  | 'interrupted'
  | 'corrupt'
  | 'io'
  | 'full'
  | 'too_big'
  | 'invalid_state'
  | 'internal';

const STATUS_NAMES: Record<number, StatusName> = {
  0: 'ok',
  1: 'unsupported',
  2: 'syntax',
  3: 'not_found',
  4: 'constraint',
  5: 'readonly',
  6: 'busy',
  7: 'interrupted',
  8: 'corrupt',
  9: 'io',
  10: 'full',
  11: 'too_big',
  12: 'invalid_state',
  13: 'internal',
};

/**
 * Returns the name of a status code, or a readable placeholder for one this
 * version has never heard of.
 * @param status - a value from the status range
 */
export function statusName(status: number): string {
  return STATUS_NAMES[status] ?? `status ${status}`;
}

/**
 * Something the engine refused.
 *
 * It carries the status, not only the message, because a caller that has to
 * match on prose to find out what happened will break the first time the
 * wording improves.
 */
export class InillucentError extends Error {
  readonly status: number;
  readonly statusName: string;
  /** The construct the engine has not implemented, when the status is unsupported. */
  readonly feature?: string;
  /** Internal diagnostic text, present only when the database was opened with diagnostics. */
  readonly detail?: string;
  /** The byte offset into the statement, when the failure has one. */
  readonly offset?: number;

  constructor(status: number, message: string, feature?: string, detail?: string, offset?: number) {
    super(offset === undefined ? `${message} [${statusName(status)}]` : `${message} [${statusName(status)}] at byte ${offset}`);
    this.name = 'InillucentError';
    this.status = status;
    this.statusName = statusName(status);
    this.feature = feature;
    this.detail = detail;
    this.offset = offset;
  }
}

/**
 * The engine has not implemented the construct.
 *
 * This is a separate type on purpose. The engine refuses what it has not built
 * rather than answering it wrongly, so an application can say "this engine
 * cannot do that yet" instead of "check your spelling".
 */
export class UnsupportedError extends InillucentError {
  constructor(status: number, message: string, feature?: string, detail?: string, offset?: number) {
    super(status, message, feature, detail, offset);
    this.name = 'UnsupportedError';
  }
}

/** The shared library could not be found, or its ABI does not match. */
export class DriverLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverLoadError';
  }
}
