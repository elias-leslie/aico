import { defineConfig } from 'vitest/config'

// One run for the whole repo: every package under packages/ is a project with
// its own vitest.config.ts.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts'],
  },
})
