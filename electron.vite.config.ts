import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// The packaged renderer loads from file://, where Electron never applies a
// response-header CSP, so production builds carry the policy as a <meta> tag.
// main/index.ts still sets the matching header for any non-file load. Dev is
// left alone: Vite's HMR needs inline scripts and its own websocket. Voice is
// the only remote connection and its service is loopback-only.
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ')

function rendererCspMeta(): Plugin {
  return {
    name: 'aico-renderer-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP },
        injectTo: 'head-prepend',
      },
    ],
  }
}

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
    plugins: [rendererCspMeta()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'electron/renderer/index.html') },
    },
  },
})
