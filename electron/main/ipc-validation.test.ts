import { describe, expect, it } from 'vitest'
import { parsePins } from './ipc-validation'

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
