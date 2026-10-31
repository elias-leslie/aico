import { defineConfig } from 'vitest/config'

// One run for the whole workspace: the code the web app shares (shared/) here,
// plus Tether, the web server and the web frontend with their own configs.
export default defineConfig({
  test: {
    projects: [
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
