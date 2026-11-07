import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'session-engine',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
