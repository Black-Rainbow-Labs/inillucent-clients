/**
 * What the engine says it can do, and how to ask before composing a statement.
 */

import { calls, driver } from './ffi.js';

export const Support = { No: 0, Yes: 1, Partial: -1, Unknown: -2 } as const;

export type SupportState = (typeof Support)[keyof typeof Support];

const SUPPORT_NAMES: Record<number, string> = {
  0: 'no',
  1: 'yes',
  [-1]: 'partial',
  [-2]: 'unknown',
};

/** One row of the engine's capability table. */
export interface Capability {
  /** What the capability is called. */
  name: string;
  /** No, yes, partial, or unknown. */
  support: SupportState;
  /** The support state as a word. */
  supportName: string;
  /** What the engine does and does not do here. Partial says what the limit is. */
  note: string;
  /** Whether the engine will do this at all. Partial counts, and the note says how far. */
  supported: boolean;
}

/**
 * Returns every capability the engine declares.
 *
 * Ask this before composing a statement rather than after. Every row is checked
 * against the running engine by a test in both directions, so a claim of support
 * that fails and a claim of absence that now works each turn it red.
 */
export function capabilities(): Capability[] {
  const c = calls();
  const found: Capability[] = [];
  const count = Number(c.capability_count());
  for (let nth = 0; nth < count; nth += 1) {
    const name: [string | null] = [null];
    const state: [number] = [0];
    const note: [string | null] = [null];
    if ((c.capability(nth, name, state, note) as number) !== 0) continue;
    const support = state[0] as SupportState;
    found.push({
      name: name[0] ?? '',
      support,
      supportName: SUPPORT_NAMES[support] ?? `state ${support}`,
      note: note[0] ?? '',
      supported: support === Support.Yes || support === Support.Partial,
    });
  }
  return found;
}

/**
 * Returns whether the engine does something, by name.
 *
 * `Support.Unknown` means this build has never heard of the capability, and it
 * should be treated as no rather than as yes: one that was never declared was
 * certainly never checked.
 *
 * @param name - the capability name
 */
export function supports(name: string): SupportState {
  return calls().supports(name) as SupportState;
}

/** Returns what the driver calls itself. */
export function version(): string {
  return (calls().version() as string) ?? '';
}

/** Returns the shared library's ABI version as major.minor.patch. */
export function abiVersion(): string {
  const reported = calls().abi_version() as number;
  return `${Math.floor(reported / 1_000_000)}.${Math.floor(reported / 1000) % 1000}.${reported % 1000}`;
}

/** Returns the file the shared library was loaded from. */
export function driverPath(): string {
  return driver().path;
}
