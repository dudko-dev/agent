import { defineConfig } from 'tsup'

// Size policy:
//   - sourcemap: false   -> drops ~290 KB of unpacked weight from the tarball.
//                           Stack traces from dist/ point at minified bundle
//                           positions; consumers rarely debug into our code,
//                           and dev builds can re-enable it locally.
//   - minify:  true      -> ~50% smaller code bundles.
//   - keepNames: true    -> minifier preserves function/class names so error
//                           stacks still show meaningful symbols.
const shared = {
  sourcemap: false,
  minify: true,
  keepNames: true,
  clean: true,
  target: 'node22',
  outDir: 'dist',
  treeshake: true,
  splitting: false,
} as const

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
  },
  {
    ...shared,
    // CLI is bundled standalone (it duplicates the library code) so the
    // installed `dd-agent` bin doesn't depend on dist/index.js layout.
    clean: false,
    entry: { cli: 'src/cli/start.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
  },
])
