import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserScopeId } from './browser-scope-id'

const originalCrypto = globalThis.crypto

function setCrypto(value: Partial<Crypto> | undefined): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value,
  })
}

describe('createBrowserScopeId', () => {
  afterEach(() => {
    setCrypto(originalCrypto)
  })

  it('uses crypto.randomUUID when available', () => {
    setCrypto({
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
    })

    expect(createBrowserScopeId('window')).toBe(
      '00000000-0000-4000-8000-000000000000',
    )
  })

  it('uses crypto.getRandomValues without Math.random fallback', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set([0, 1, 2, 3, 10, 11, 12, 13, 16, 17, 18, 19, 254, 255, 128, 64])
      return bytes
    })
    setCrypto({ getRandomValues } as Partial<Crypto>)

    expect(createBrowserScopeId('window')).toBe(
      'window-000102030a0b0c0d10111213feff8040',
    )
    expect(getRandomValues).toHaveBeenCalledOnce()
  })
})
