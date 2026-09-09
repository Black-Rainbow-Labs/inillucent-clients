#!/usr/bin/env node
/**
 * Runs the person example in every language and prints what each one printed.
 *
 * The READMEs and inillucent.com both show these outputs, so this is how they
 * are checked rather than trusted. A language with no toolchain on the machine
 * is reported as skipped.
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

const portable = join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'toolchains');
const go = firstOf([join(portable, 'go', 'bin', 'go.exe'), join(portable, 'go', 'bin', 'go')], 'go');
const php = firstOf([join(portable, 'php', 'php.exe'), join(portable, 'php', 'php')], 'php');
const dotnet = firstOf(
  [join(portable, 'dotnet', 'dotnet.exe'), join(portable, 'dotnet', 'dotnet')],
  'dotnet',
);

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

const jdk = findJdk(join(portable, 'jdk'));

/**
 * Runs one command and returns its output.
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
  return {
    ok: done.status === 0,
    missing: done.error?.code === 'ENOENT',
    said: `${done.stdout ?? ''}${done.stderr ?? ''}`.trimEnd(),
  };
}

const examples = [
  {
    name: 'python',
    run: () =>
      run('python', [join(repo, 'python', 'examples', 'person.py')], repo, {
        PYTHONPATH: join(repo, 'python', 'src'),
      }),
  },
  {
    name: 'typescript',
    run: () =>
      run(process.execPath, ['--experimental-strip-types', 'examples/person.ts'], join(repo, 'typescript')),
  },
  {
    name: 'javascript',
    run: () => run(process.execPath, ['examples/person.cjs'], join(repo, 'javascript')),
  },
  {
    name: 'rust',
    run: () =>
      run('cargo', ['run', '--quiet', '--manifest-path', join(repo, 'rust', 'Cargo.toml'), '--example', 'person'], repo),
  },
  { name: 'go', run: () => run(go, ['run', './examples/person'], join(repo, 'go')) },
  {
    name: 'java',
    run: () => {
      if (!jdk) return { ok: false, missing: true, said: 'no JDK 22 or later found' };
      return run(
        join(jdk, 'java'),
        [
          '--enable-native-access=ALL-UNNAMED',
          `-Dinillucent.repository=${repo}`,
          '-cp',
          join(repo, 'java', 'out', 'classes'),
          'com.inillucent.Person',
        ],
        repo,
      );
    },
  },
  {
    name: 'csharp',
    run: () =>
      run(dotnet, ['run', '-v', 'quiet', '--nologo'], join(repo, 'csharp', 'examples', 'Person'), {
        INILLUCENT_REPOSITORY: repo,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
      }),
  },
  { name: 'php', run: () => run(php, [join(repo, 'php', 'examples', 'person.php')], repo) },
];

let failed = 0;
for (const example of examples) {
  const outcome = example.run();
  if (outcome.missing) {
    console.log(`\n=== ${example.name} — skipped, no toolchain ===`);
    continue;
  }
  console.log(`\n=== ${example.name} ===`);
  console.log(outcome.said.replace(/^/gm, '  '));
  if (!outcome.ok) failed += 1;
}

console.log(`\n${failed ? `${failed} FAILED` : 'every example that could run, ran'}`);
process.exit(failed ? 1 : 0);
