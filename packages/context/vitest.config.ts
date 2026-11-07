import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'context',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    // Fixtures hold local times with their zone.
    env: { TZ: 'America/New_York', AICO_CLI_NAME: 'st' },
  },
})
