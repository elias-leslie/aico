import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'fleet',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
