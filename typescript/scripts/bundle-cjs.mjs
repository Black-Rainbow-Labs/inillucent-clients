// Builds the CommonJS entry point beside the ESM one, so `require('inillucent')`
// works in a project that has not moved to modules.
//
// `import.meta.url` has no meaning in CommonJS, so it is replaced with the same
// value computed from __filename. Without this the bundle builds and then cannot
// find the shared library, which is a failure a long way from its cause.
//
// The paths are resolved from this script's own folder, so the build works from
// any working directory, including the repository root.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [resolve(packageRoot, 'src', 'index.ts')],
  outfile: resolve(packageRoot, 'dist', 'index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['koffi'],
  define: { 'import.meta.url': 'INILLUCENT_MODULE_URL' },
  banner: {
    js: "const INILLUCENT_MODULE_URL = require('node:url').pathToFileURL(__filename).href;",
  },
});
console.log('built dist/index.cjs');
