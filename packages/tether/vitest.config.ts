import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'tether',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
