import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const configDirectory = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(configDirectory, '.'),
      '@xterm/xterm/css/xterm.css': resolve(
        configDirectory,
        './test-stubs/xterm-style.ts',
      ),
    },
  },
  test: {
    name: 'web-frontend',
    environment: 'jsdom',
    // Threads share one process per worker: a quarter of the system time of forked jsdom workers.
    pool: 'threads',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
})
