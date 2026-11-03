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

// A static export: packages/web-server serves `out/` with the API, the terminal
// WebSocket and every response header (CSP from scripts/csp-hashes.mjs).
const nextConfig: NextConfig = {
  // @aico/tether-client/teams: the session-list team rule.
  transpilePackages: [
    '@aico/tether-client',
    '@aico/ui-kit',
    ...(hasPassportClient() ? ['@agent-hub/passport-client'] : []),
  ],
  output: 'export',
}

export default nextConfig
