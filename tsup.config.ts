import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node22',
    outDir: 'dist',
    treeshake: true,
    splitting: false,
  },
  {
    entry: { cli: 'src/cli/start.ts' },
    format: ['esm'],
    sourcemap: true,
    target: 'node22',
    outDir: 'dist',
    treeshake: true,
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
  },
])
