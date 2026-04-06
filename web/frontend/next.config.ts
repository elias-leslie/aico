import type { NextConfig } from 'next'
import { PORTS } from './lib/api-config'

// Only transpile passport-client if installed (voice features)
function hasPassportClient(): boolean {
  try {
    require.resolve('@agent-hub/passport-client')
    return true
  } catch {
    return false
  }
}

const nextConfig: NextConfig = {
  transpilePackages: hasPassportClient() ? ['@agent-hub/passport-client'] : [],
  output: 'standalone',
  // Proxy /api/* and /ws/* to backend server-to-server to avoid CORS issues with CF Access
  // In production: browser requests a-term.summitflow.dev/api/* (same-origin)
  // Next.js rewrites proxy to localhost:8002 (server-to-server, no CORS)
  async rewrites() {
    const apiUrl = process.env.API_URL || `http://localhost:${PORTS.backend}`
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
      // WebSocket paths - same-origin routing for CF Access compatibility
      {
        source: '/ws/:path*',
        destination: `${apiUrl}/ws/:path*`,
      },
    ]
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(self), geolocation=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ]
  },
}

export default nextConfig
