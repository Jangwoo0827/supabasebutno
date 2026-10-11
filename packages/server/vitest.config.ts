import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Several suites hash passwords with argon2 (deliberately slow) and run in parallel,
    // so the 5 s default is too tight on a busy machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
