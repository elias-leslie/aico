import { describe, expect, it } from 'vitest'
import { compactRef, parseSse } from './selection'

describe('compactRef', () => {
  it('formats a single capture with the kind label and 80-char cap', () => {
    expect(compactRef([{ kind: 'dom', snippet: 'hello world' }])).toBe('[dom: "hello world"] ')
  })

  it('collapses whitespace and trims the snippet', () => {
    expect(compactRef([{ kind: 'dom', snippet: '  a\n\t b  ' }])).toBe('[dom: "a b"] ')
  })

  it('defaults a missing kind to dom', () => {
    expect(compactRef([{ snippet: 'x' }])).toBe('[dom: "x"] ')
  })

  it('formats a batch as an enumerated, 40-char-capped list', () => {
    const ref = compactRef([
      { kind: 'dom', snippet: 'first' },
      { kind: 'img', snippet: 'second' },
    ])
    expect(ref).toBe('[2 items: dom "first", img "second"] ')
  })

  it('caps each batch snippet at 40 chars', () => {
    const long = 'x'.repeat(100)
    const ref = compactRef([
      { kind: 'dom', snippet: long },
      { kind: 'dom', snippet: 'y' },
    ])
    expect(ref).toContain(`dom "${'x'.repeat(40)}"`)
  })

  it('renders a grab package as an index pointer with count + dims', () => {
    const ref = compactRef([
      {
        kind: 'region',
        snippet: '/tmp/aico-grab-123/index.md',
        meta: { package: true, items: 3, w: 3630, h: 3440 },
      },
    ])
    expect(ref).toContain('[capture: /tmp/aico-grab-123/index.md')
    expect(ref).toContain('3 items')
    expect(ref).toContain('3630×3440')
    expect(ref).toContain('cheapest-first')
  })

  it('keeps the full index path (no 80-char clip) for packages', () => {
    const deep = `/tmp/${'d'.repeat(90)}/index.md`
    const ref = compactRef([{ kind: 'region', snippet: deep, meta: { package: true, items: 2 } }])
    expect(ref).toContain(deep)
  })

  it('falls back to the plain ref when meta.package is absent', () => {
    expect(compactRef([{ kind: 'region', snippet: '/tmp/x.png' }])).toBe('[region: "/tmp/x.png"] ')
  })
})

describe('parseSse', () => {
  it('extracts data payloads from complete frames', () => {
    const { events, rest } = parseSse('data: {"a":1}\n\ndata: {"b":2}\n\n')
    expect(events).toEqual(['{"a":1}', '{"b":2}'])
    expect(rest).toBe('')
  })

  it('keeps an unterminated trailing frame in rest', () => {
    const { events, rest } = parseSse('data: {"a":1}\n\ndata: {"b":2}')
    expect(events).toEqual(['{"a":1}'])
    expect(rest).toBe('data: {"b":2}')
  })

  it('drops keepalive comment frames (no data line)', () => {
    const { events, rest } = parseSse(': connected\n\n: ping\n\ndata: {"x":1}\n\n')
    expect(events).toEqual(['{"x":1}'])
    expect(rest).toBe('')
  })

  it('returns no events for a buffer with no frame terminator', () => {
    expect(parseSse('data: partial')).toEqual({ events: [], rest: 'data: partial' })
  })
})
