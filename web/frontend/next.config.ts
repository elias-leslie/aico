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
  transpilePackages: [
    '@summitflow/notes-ui',
    ...(hasPassportClient() ? ['@agent-hub/passport-client'] : []),
  ],
  output: 'standalone',
  // Proxy /api/* and /ws/* to backend server-to-server to avoid CORS issues with CF Access
  // The frontend build injects API_URL from the repo runtime env so installs that
  // move off the default backend port still proxy correctly after build.
  async rewrites() {
    const backendPort = process.env.A_TERM_PORT || String(PORTS.backend)
    const apiUrl = process.env.API_URL || `http://127.0.0.1:${backendPort}`
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
