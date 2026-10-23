import { describe, expect, it, vi } from 'vitest'
import { keepKeyboardOpen, remSize } from './types'

describe('remSize', () => {
  it('converts design pixels to root-relative sizes', () => {
    // The phone's text-scaling setting moves the root font size; rem follows it.
    expect(remSize(16)).toBe('1rem')
    expect(remSize(44)).toBe('2.75rem')
    expect(remSize(0)).toBe('0rem')
  })
})

describe('keepKeyboardOpen', () => {
  it('prevents the default so the key press does not take focus', () => {
    // Losing focus on the input dismisses the phone's keyboard.
    const preventDefault = vi.fn()
    keepKeyboardOpen({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })
})
