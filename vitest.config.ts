import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.{ts,js}', 'dev/**/*.test.{ts,js}', 'benchmarks/**/*.test.{ts,js}'],
    exclude: ['node_modules', 'dev/poc-mcp', 'dev/poc-vocs'],
    testTimeout: 30_000,
    coverage: {
      include: ['src/**/*.{ts,js}'],
      exclude: ['src/**/*.test.{ts,js}', 'src/browser.ts'],
    },
  },
})