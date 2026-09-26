import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
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
    // MCP/CLI tests also spawn child processes; bound concurrent native/IO work.
    maxWorkers: Math.min(4, availableParallelism()),
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
