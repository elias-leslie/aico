import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// node-pty is a native module — keep it external (never bundled) in main.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'electron/main/index.ts') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      // Sandboxed Electron preloads are evaluated as CommonJS. If this emits an
      // ESM .mjs bundle, Electron logs "Cannot use import statement outside a
      // module", the contextBridge never installs, and the renderer paints only
      // static HTML.
      lib: {
        entry: resolve(__dirname, 'electron/preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'electron/renderer'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'electron/renderer/index.html') },
    },
  },
})
