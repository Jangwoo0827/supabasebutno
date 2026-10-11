import { defineConfig } from 'tsup';

const common = {
  entry: { index: 'src/index.ts' },
  target: 'es2019', // keeps the browser build usable in older browsers and WebViews
  platform: 'neutral' as const,
  sourcemap: true,
  dts: false, // declarations come from tsc (TypeScript 7 has no JS API for tsup's dts step)
  treeshake: true,
};

export default defineConfig([
  // For bundlers and Node.
  {
    ...common,
    format: ['esm', 'cjs'],
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.js' : '.cjs' }),
    clean: true,
  },
  // For a plain <script> tag: defines the global `supabasebutno`. Both a readable and a minified file.
  {
    ...common,
    format: ['iife'],
    globalName: 'supabasebutno',
    outExtension: () => ({ js: '.global.js' }),
  },
  {
    ...common,
    format: ['iife'],
    globalName: 'supabasebutno',
    minify: true,
    outExtension: () => ({ js: '.global.min.js' }),
  },
]);
