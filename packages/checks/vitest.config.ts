import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'checks',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
