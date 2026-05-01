import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
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
