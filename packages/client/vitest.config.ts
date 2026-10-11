import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests start a real server (argon2 hashing, WebSockets) alongside the SDK.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
