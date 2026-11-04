import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'context',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
