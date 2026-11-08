import { describe, expect, it } from 'vitest'
import {
  applyMemoryPolicyPatch,
  DEFAULT_MEMORY_POLICY,
  MemoryPolicyError,
  parseStoredMemoryPolicy,
} from './memory-policy'

describe('memory policy', () => {
  it('applies a valid partial update', () => {
    const next = applyMemoryPolicyPatch(
      { ...DEFAULT_MEMORY_POLICY },
      { killOrder: 'background-first', killMinGib: 0.5 },
    )
    expect(next).toMatchObject({
      killOrder: 'background-first',
      killMinGib: 0.5,
      paneMemoryMaxGib: 12,
    })
  })

  it('names the field it refuses', () => {
    const base = { ...DEFAULT_MEMORY_POLICY }
    for (const patch of [
      { paneMemoryMaxGib: 12.5 },
      { killGapSeconds: 1 },
      { killOrder: 'oldest' },
      { killEnabled: 'yes' },
      { other: 1 },
    ]) {
      expect(() => applyMemoryPolicyPatch(base, patch)).toThrow(MemoryPolicyError)
    }
  })

  it('reads a stored value leniently', () => {
    expect(parseStoredMemoryPolicy(null)).toEqual(DEFAULT_MEMORY_POLICY)
    expect(parseStoredMemoryPolicy('{"paneMemoryMaxGib":16,"killGapSeconds":-4}')).toMatchObject({
      paneMemoryMaxGib: 16,
      killGapSeconds: 30,
    })
    expect(parseStoredMemoryPolicy('not json')).toEqual(DEFAULT_MEMORY_POLICY)
  })
})
