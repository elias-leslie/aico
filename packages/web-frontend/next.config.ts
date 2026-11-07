import type { NextConfig } from 'next'

// A static export: packages/web-server serves `out/` with the API, the terminal
// WebSocket and every response header (CSP from scripts/csp-hashes.mjs).
const nextConfig: NextConfig = {
  // @aico/tether-client/teams: the session-list team rule.
  transpilePackages: ['@aico/shared', '@aico/tether-client', '@aico/ui-kit'],
  output: 'export',
}

export default nextConfig
