import { describe, expect, it } from 'vitest'
import { parseBoundsRequest, parsePins } from './ipc-validation'

describe('window bounds requests', () => {
  it('rounds finite bounds', () => {
    expect(parseBoundsRequest({ x: 1.4, y: 2.6, w: 300.2, h: 200.5 })).toEqual({
      x: 1,
      y: 3,
      width: 300,
      height: 201,
    })
  })

  it('rejects missing, non-finite and empty bounds', () => {
    expect(parseBoundsRequest(null)).toBeNull()
    expect(parseBoundsRequest({ x: 0, y: 0, w: Number.NaN, h: 10 })).toBeNull()
    expect(parseBoundsRequest({ x: 0, y: 0, w: '10', h: 10 })).toBeNull()
    expect(parseBoundsRequest({ x: 0, y: 0, w: 0, h: 10 })).toBeNull()
  })
})

describe('pinned action ids', () => {
  it('accepts a short list of strings', () => {
    expect(parsePins(['grab', 'voice'])).toEqual(['grab', 'voice'])
    expect(parsePins([])).toEqual([])
  })

  it('rejects anything else', () => {
    expect(parsePins('grab')).toBeNull()
    expect(parsePins([1])).toBeNull()
    expect(parsePins([''])).toBeNull()
    expect(parsePins(Array.from({ length: 65 }, (_, i) => `a${i}`))).toBeNull()
  })
})
