import type { NextConfig } from 'next'

// Only transpile passport-client if installed (voice features)
function hasPassportClient(): boolean {
  try {
    require.resolve('@agent-hub/passport-client')
    return true
  } catch {
    return false
  }
}

// A static export: web/server serves `out/` with the API, the terminal
// WebSocket and every response header (CSP from scripts/csp-hashes.mjs).
const nextConfig: NextConfig = {
  // tether/teams: the session-list team rule, shared with the desktop tray.
  transpilePackages: [
    'tether',
    ...(hasPassportClient() ? ['@agent-hub/passport-client'] : []),
  ],
  output: 'export',
}

export default nextConfig
