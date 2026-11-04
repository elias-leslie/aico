import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'usage',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
