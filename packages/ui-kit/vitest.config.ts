import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'ui-kit',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    passWithNoTests: false,
  },
})
