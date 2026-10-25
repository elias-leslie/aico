import { describe, expect, it } from 'vitest'
import config from '../../electron.vite.config'
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

  it('keeps fonts out of data: URIs, which font-src blocks', () => {
    expect(directives).toContain("font-src 'self'")
    const limit = config.renderer?.build?.assetsInlineLimit
    expect(typeof limit).toBe('function')
    if (typeof limit !== 'function') return
    expect(limit('assets/fonts/FreeMono-Symbols.woff2', Buffer.alloc(2568))).toBe(false)
    expect(limit('assets/mark.svg', Buffer.alloc(100))).toBeUndefined()
  })
})
