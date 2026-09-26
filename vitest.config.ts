import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  // Evaluation CLIs import built JS; tests must also work before the build step.
  resolve: {
    alias: [
      {
        find: /^\.\.\/dist\/([^/]+)\.js$/,
        replacement:
          fileURLToPath(new URL('./src/', import.meta.url)).replaceAll(
            '\\',
            '/',
          ) + '$1.ts',
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
