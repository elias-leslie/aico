import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'web-server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
