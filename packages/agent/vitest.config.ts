import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'agent',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
