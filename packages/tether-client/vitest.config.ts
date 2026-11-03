import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'tether-client',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
