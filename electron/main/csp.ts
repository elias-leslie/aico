// The renderer's Content-Security-Policy, shared by the packaged <meta> tag
// (electron.vite.config.ts) and the main-process response header, so the two
// cannot drift apart. Only connect-src differs: the meta tag allows any
// loopback voice port, the header only the configured voice websocket.
export function contentSecurityPolicy(connectSources: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'", // xterm.js injects a <style> for theming
    "img-src 'self' data:", // inline SVG marks + the chrome noise data: URI
    "font-src 'self'",
    ["connect-src 'self'", ...connectSources].join(' '), // voice WS only
    "worker-src 'self' blob:", // voice audio worklet
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join('; ')
}

/** The connect-src source for the voice websocket, or null when it can't be
 * expressed. Chromium's CSP host grammar has no IPv6 literals: `ws://[::1]:port`
 * makes the whole directive invalid, so a [::1] voice service is left out (as
 * the meta tag's loopback sources leave it out). A malformed URL is too. */
export function voiceConnectSource(voiceWsUrl: string): string | null {
  try {
    const u = new URL(voiceWsUrl)
    return u.hostname.startsWith('[') ? null : `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}
