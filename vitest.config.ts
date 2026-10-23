import { defineConfig } from 'vitest/config'

// One run for the whole workspace: the desktop here, plus Tether, the web
// server and the web frontend with their own configs.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'desktop',
          environment: 'node',
          include: ['electron/**/*.{test,spec}.ts'],
        },
      },
      'tether',
      'web/server',
      'web/frontend',
    ],
  },
})
