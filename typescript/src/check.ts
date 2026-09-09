/**
 * Turning a failed C call into the right JavaScript exception.
 */

import { calls } from './ffi.js';
import { InillucentError, Status, UnsupportedError, statusName } from './errors.js';

/**
 * Builds the exception a C error describes, and frees the error either way.
 *
 * The free happens in a finally because an exception built from an error must
 * not leak it.
 *
 * @param handle - the C error handle, which is owned by this call
 */
function errorFrom(handle: unknown): InillucentError {
  const c = calls();
  try {
    const status = c.error_status(handle) as number;
    const message = (c.error_message(handle) as string) ?? '';
    const feature = (c.error_feature(handle) as string) || undefined;
    const detail = (c.error_detail(handle) as string) || undefined;
    const reported = c.error_offset(handle) as number;
    const offset = reported >= 0 ? reported : undefined;
    const kind = status === Status.Unsupported ? UnsupportedError : InillucentError;
    return new kind(status, message, feature, detail, offset);
  } finally {
    c.error_free(handle);
  }
}

/**
 * Throws when a call failed, using the error it produced.
 *
 * A non zero status with no error still throws: a call that failed and said
 * nothing is not a reason to carry on.
 *
 * @param status - what the call returned
 * @param error - the error out parameter the call was given
 */
export function check(status: number, error: [unknown]): void {
  if (status === Status.Ok) return;
  if (error[0]) throw errorFrom(error[0]);
  throw new InillucentError(status, `the call failed with ${statusName(status)}`);
}
