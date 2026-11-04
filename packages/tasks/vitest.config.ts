import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'tasks',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
