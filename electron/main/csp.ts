// The renderer's Content-Security-Policy, carried as a <meta> tag in the
// packaged renderer (electron.vite.config.ts). The renderer makes no network
// connections of its own: main and the preload bridge do all I/O.
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // xterm.js injects a <style> for theming
  "img-src 'self' data:", // inline SVG marks + the chrome noise data: URI
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ')
