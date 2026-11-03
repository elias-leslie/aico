import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'notes',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
