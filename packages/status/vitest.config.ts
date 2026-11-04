import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'status',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
