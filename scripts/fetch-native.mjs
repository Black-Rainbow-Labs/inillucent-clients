#!/usr/bin/env node
/**
 * Copies the engine's built C ABI shared library into `native/`, so every client
 * library in this repository can find it without an environment variable.
 *
 * Run it with no argument and it looks for the engine checkout next to this one;
 * pass a path to say where the engine is instead.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

/**
 * Returns the shared library file names this platform uses, most likely first.
 */
function libraryNames() {
  if (process.platform === 'win32') return ['inillucent_driver_capi.dll'];
  if (process.platform === 'darwin') return ['libinillucent_driver_capi.dylib'];
  return ['libinillucent_driver_capi.so'];
}

/**
 * Returns the engine checkouts to look in, in order.
 * @param requested - a path given on the command line, or undefined
 */
function engineRoots(requested) {
  if (requested) return [resolve(requested)];
  return [resolve(repo, '..', 'inillucent'), resolve(repo, '..', '..', 'inillucent')];
}

/**
 * Finds the newest built library under the given engine checkouts.
 * @param roots - engine checkout paths to search
 */
function findBuilt(roots) {
  const found = [];
  for (const root of roots) {
    for (const profile of ['release', 'debug']) {
      for (const name of libraryNames()) {
        const candidate = join(root, 'target', profile, name);
        if (existsSync(candidate)) found.push({ candidate, at: statSync(candidate).mtimeMs });
      }
    }
  }
  found.sort((left, right) => right.at - left.at);
  return found[0]?.candidate;
}

const built = findBuilt(engineRoots(process.argv[2]));
if (!built) {
  console.error(
    'No built driver found. Build it first:\n' +
      '  cargo build --release --manifest-path <engine>/Cargo.toml -p inillucent-driver-capi\n' +
      'then run this again, passing the engine checkout if it is not beside this repository.',
  );
  process.exit(1);
}

mkdirSync(join(repo, 'native'), { recursive: true });
const target = join(repo, 'native', basename(built));
copyFileSync(built, target);
console.log(`copied ${built}\n     -> ${target}`);
