import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script, no types
import * as cf from '../../../native/cloudflare/cloudflare.mjs'

describe('st cloudflare', () => {
  it('derives the RFC 7636 S256 challenge', () => {
    expect(cf.challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('reads the reply for the request id from JSON or an event stream', () => {
    const msg = { jsonrpc: '2.0', id: 2, result: { ok: true } }
    expect(cf.parseRpc(JSON.stringify(msg), 'application/json', 2)).toEqual(msg)
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'ping' })}\n\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`
    expect(cf.parseRpc(sse, 'text/event-stream', 2)).toEqual(msg)
    expect(() => cf.parseRpc(sse, 'text/event-stream', 9)).toThrow('No reply')
  })

  it('builds execute code that quotes the path and projects server side', () => {
    const code = cf.requestCode({ path: '/zones?name=a"b', project: cf.projections.zones })
    expect(code).toContain('cloudflare.request({ method: "GET", path: "/zones?name=a\\"b" })')
    expect(code).toContain('return (')
    expect(cf.requestCode({ method: 'POST', path: '/x', body: { a: 1 } })).toContain(
      'body: {"a":1}',
    )
  })

  it('requests only DNS, Access and Tunnel scopes plus read basics', () => {
    const scopes = cf.DEFAULT_SCOPES.split(' ')
    expect(scopes).toEqual(
      expect.arrayContaining(['dns.write', 'access-app.write', 'argotunnel.write']),
    )
    expect(scopes.some((s: string) => /^(zone\.write|account\.write|workers|r2|d1)/.test(s))).toBe(
      false,
    )
  })
})
