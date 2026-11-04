import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'webtools',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
