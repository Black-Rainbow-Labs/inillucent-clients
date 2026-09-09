#!/usr/bin/env node
/**
 * Runs the conformance suite in every language that has a toolchain on this
 * machine, and prints one line per client.
 *
 * A client that cannot be run here is reported as skipped with the reason, never
 * as passing. "Eight clients pass" is a claim this script has to be able to
 * back, so a missing toolchain has to look different from a green run.
 *
 * Run it with `node scripts/test-all.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Returns the first path that exists, or the bare command so PATH can find it.
 * @param candidates - full paths to try, most specific first
 * @param fallback - the command name to fall back to
 */
function firstOf(candidates, fallback) {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return fallback;
}

// Toolchains installed under the user's own directory are preferred when they
// are there, because a machine that has no system wide Go or PHP can still run
// the whole suite from a portable install.
const portable = join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'toolchains');
const go = firstOf([join(portable, 'go', 'bin', 'go.exe'), join(portable, 'go', 'bin', 'go')], 'go');
const php = firstOf([join(portable, 'php', 'php.exe'), join(portable, 'php', 'php')], 'php');
const dotnet = firstOf(
  [join(portable, 'dotnet', 'dotnet.exe'), join(portable, 'dotnet', 'dotnet')],
  'dotnet',
);
const jdk = findJdk(join(portable, 'jdk'));

/**
 * Returns a JDK's bin directory under the portable install, or an empty string.
 * @param root - where portable JDKs are unpacked
 */
function findJdk(root) {
  if (!existsSync(root)) return '';
  for (const entry of readdirSync(root)) {
    const bin = join(root, entry, 'bin');
    if (existsSync(join(bin, 'javac.exe')) || existsSync(join(bin, 'javac'))) return bin;
  }
  return '';
}

/**
 * Runs one command and returns whether it succeeded, with its tail output.
 * @param command - the program to run
 * @param args - its arguments
 * @param cwd - the directory to run it in
 * @param env - extra environment variables
 */
function run(command, args, cwd, env = {}) {
  const done = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: false,
  });
  const said = `${done.stdout ?? ''}${done.stderr ?? ''}`;
  return { ok: done.status === 0, said, missing: done.error?.code === 'ENOENT' };
}

const javac = jdk ? join(jdk, 'javac') : '';
const java = jdk ? join(jdk, 'java') : '';

const clients = [
  {
    name: 'python',
    how: 'ctypes',
    run: () => run('python', [join(repo, 'python', 'tests', 'conformance.py')], repo, {
      PYTHONPATH: join(repo, 'python', 'src'),
    }),
  },
  {
    name: 'typescript',
    how: 'koffi',
    run: () => {
      // The compiler is run through node rather than through npx, because npx on
      // Windows is a .cmd shim that spawnSync cannot find without a shell, and a
      // client that cannot be built must not be reported as one that is missing.
      const tsc = join(repo, 'typescript', 'node_modules', 'typescript', 'bin', 'tsc');
      if (!existsSync(tsc)) {
        return { ok: false, missing: true, said: 'run npm install in typescript/ first' };
      }
      const built = run(process.execPath, [tsc, '-p', 'tsconfig.json'], join(repo, 'typescript'));
      if (!built.ok) return built;
      const bundled = run(
        process.execPath,
        [join(repo, 'typescript', 'scripts', 'bundle-cjs.mjs')],
        join(repo, 'typescript'),
      );
      if (!bundled.ok) return bundled;
      return run(process.execPath, ['--test', 'test/conformance.test.js'], join(repo, 'typescript'));
    },
  },
  {
    name: 'javascript',
    how: 'the same package, both module systems',
    run: () =>
      run(
        process.execPath,
        ['--test', 'test/commonjs.test.cjs', 'test/esm.test.mjs'],
        join(repo, 'javascript'),
      ),
  },
  {
    name: 'rust',
    how: 'libloading',
    run: () => run('cargo', ['test', '--manifest-path', join(repo, 'rust', 'Cargo.toml')], repo),
  },
  {
    name: 'go',
    how: 'purego',
    run: () => run(go, ['test', './...'], join(repo, 'go')),
  },
  {
    name: 'java',
    how: 'the Foreign Function and Memory API',
    run: () => {
      if (!jdk) return { ok: false, missing: true, said: 'no JDK 22 or later found' };
      const out = join(repo, 'java', 'out');
      const sources = [
        join(repo, 'java', 'src', 'main', 'java', 'com', 'inillucent'),
        join(repo, 'java', 'src', 'test', 'java', 'com', 'inillucent'),
      ];
      const files = sources.flatMap((dir) =>
        readdirSync(dir).filter((name) => name.endsWith('.java')).map((name) => join(dir, name)),
      );
      const built = run(javac, ['-d', join(out, 'classes'), '--release', '22', ...files], repo);
      if (!built.ok) return built;
      return run(
        java,
        [
          '--enable-native-access=ALL-UNNAMED',
          `-Dinillucent.repository=${repo}`,
          '-cp',
          join(out, 'classes'),
          'com.inillucent.ConformanceTest',
        ],
        repo,
      );
    },
  },
  {
    name: 'csharp',
    how: 'DllImport',
    run: () =>
      run(dotnet, ['run', '-v', 'quiet', '--nologo'], join(repo, 'csharp', 'test', 'Inillucent.Conformance'), {
        INILLUCENT_REPOSITORY: repo,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      }),
  },
  {
    name: 'php',
    how: 'the FFI extension',
    run: () => run(php, [join(repo, 'php', 'tests', 'conformance.php')], repo),
  },
];

console.log(`inillucent client libraries, conformance in every language\nrepository: ${repo}\n`);

let failed = 0;
let skipped = 0;
for (const client of clients) {
  const outcome = client.run();
  if (outcome.missing) {
    // Only a toolchain that could not be started at all counts as skipped. A
    // failure whose output happens to mention a missing file is a failure, and
    // reporting it as skipped is how "eight clients pass" becomes untrue.
    skipped += 1;
    console.log(`  SKIP  ${client.name.padEnd(11)} ${outcome.said.trim() || 'no toolchain on this machine'}`);
    continue;
  }
  if (outcome.ok) {
    console.log(`  ok    ${client.name.padEnd(11)} ${client.how}`);
    continue;
  }
  failed += 1;
  console.log(`  FAIL  ${client.name.padEnd(11)} ${client.how}`);
  for (const line of outcome.said.trimEnd().split('\n').slice(-25)) console.log(`          ${line}`);
}

console.log(
  `\n${clients.length - failed - skipped} of ${clients.length} clients pass` +
    (skipped ? `, ${skipped} skipped for a missing toolchain` : '') +
    (failed ? `, ${failed} FAILED` : ''),
);
process.exit(failed ? 1 : 0);
