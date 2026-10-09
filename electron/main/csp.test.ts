import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, voiceConnectSource } from './csp'

const connectSrc = (csp: string) => csp.split('; ').find((d) => d.startsWith('connect-src'))

describe('renderer CSP', () => {
  it('opens connect-src only to the given sources', () => {
    expect(connectSrc(contentSecurityPolicy([]))).toBe("connect-src 'self'")
    expect(connectSrc(contentSecurityPolicy(['ws://127.0.0.1:8003']))).toBe(
      "connect-src 'self' ws://127.0.0.1:8003",
    )
  })

  it('locks everything else down', () => {
    const csp = contentSecurityPolicy([])
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-src 'none'")
  })
})

describe('voice connect source', () => {
  it('keeps the origin of the voice websocket', () => {
    expect(voiceConnectSource('ws://127.0.0.1:8003/api/voice/ws?user_id=aico')).toBe(
      'ws://127.0.0.1:8003',
    )
    expect(voiceConnectSource('wss://localhost/ws')).toBe('wss://localhost')
  })

  it('leaves out IPv6 literals, which CSP cannot express', () => {
    expect(voiceConnectSource('ws://[::1]:8003/ws')).toBeNull()
  })

  it('leaves out a malformed override', () => {
    expect(voiceConnectSource('not a url')).toBeNull()
  })
})
