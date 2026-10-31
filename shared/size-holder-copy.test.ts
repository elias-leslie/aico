import { describe, expect, it } from 'vitest'
import { sizeHolderName } from './size-holder-copy'

describe('sizeHolderName', () => {
  it('names the size holder as the bar says it, for a browser, an unnamed device and no claimer', () => {
    expect(sizeHolderName({ app: 'web', device: 'Safari on iPhone' })).toBe('Safari on iPhone')
    expect(sizeHolderName({ app: 'web', device: '' })).toBe('another device')
    expect(sizeHolderName(null)).toBe('another device')
  })
})
