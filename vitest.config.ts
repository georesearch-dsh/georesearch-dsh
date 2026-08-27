import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
