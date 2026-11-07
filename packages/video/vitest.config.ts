import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'video',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
  },
})
