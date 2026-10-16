import { describe, expect, it } from 'vitest'
import { RENDERER_CSP } from './csp'

const directives = RENDERER_CSP.split('; ')

describe('renderer CSP', () => {
  it('allows connections only to the page origin', () => {
    expect(directives.filter((d) => d.startsWith('connect-src'))).toEqual(["connect-src 'self'"])
  })

  it('allows no blob: sources', () => {
    expect(RENDERER_CSP).not.toContain('blob:')
  })

  it('locks everything else down', () => {
    expect(directives).toContain("default-src 'self'")
    expect(directives).toContain("script-src 'self'")
    expect(directives).toContain("object-src 'none'")
    expect(directives).toContain("base-uri 'none'")
    expect(directives).toContain("frame-src 'none'")
  })
})
