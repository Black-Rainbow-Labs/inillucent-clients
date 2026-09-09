// Builds the CommonJS entry point beside the ESM one, so `require('inillucent')`
// works in a project that has not moved to modules.
//
// `import.meta.url` has no meaning in CommonJS, so it is replaced with the same
// value computed from __filename. Without this the bundle builds and then cannot
// find the shared library, which is a failure a long way from its cause.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs',
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
