import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // mongodb-memory-server cold-start dominates the first integration
    // test run (binary download, ~30 s). The default 5 s timeout is too
    // tight; bump to 90 s globally. Individual tests can still pass a
    // shorter timeout via beforeAll/beforeEach options.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/__fixtures__/**',
        'dist/**',
        'bin/**',
        'tmp-*/**',
        'benchmark-harness/**',
        'perf/**',
        'config-template/**',
        'scripts/**',
        'node_modules/**',
        'coverage/**',
        'test/**',
      ],
    },
  },
});
