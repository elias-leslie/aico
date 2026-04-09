import { describe, expect, it } from 'vitest'
import nextConfig from './next.config'

describe('next.config headers', () => {
  it('leaves CSP to middleware while keeping other security headers', async () => {
    const routes = await nextConfig.headers?.()
    const rootHeaders = routes?.find((route) => route.source === '/(.*)')?.headers ?? []
    const csp = rootHeaders.find((header) => header.key === 'Content-Security-Policy')
    const xFrameOptions = rootHeaders.find((header) => header.key === 'X-Frame-Options')?.value

    expect(csp).toBeUndefined()
    expect(xFrameOptions).toBe('DENY')
  })
})
