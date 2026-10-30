import { defineConfig } from 'vitest/config'

// One run for the whole workspace: the desktop and the code it shares with the
// web app (shared/) here, plus Tether, the web server and the web frontend with
// their own configs.
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
      {
        test: {
          name: 'shared',
          environment: 'node',
          include: ['shared/**/*.{test,spec}.ts'],
        },
      },
      'tether',
      'web/server',
      'web/frontend',
    ],
  },
})
