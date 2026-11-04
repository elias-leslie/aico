import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'jobs',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
