import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'ops',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
