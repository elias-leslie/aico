import { afterEach, describe, expect, it, vi } from 'vitest'
import { getNextPath } from './LoginScreen'

describe('getNextPath', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setLocation(path: string) {
    vi.stubGlobal('window', {
      location: new URL(path, 'http://localhost:3002'),
    })
  }

  it('keeps same-origin return paths', () => {
    setLocation('/login?next=%2F%3Fproject%3Da-term')

    expect(getNextPath()).toBe('/?project=a-term')
  })

  it('rejects protocol-relative redirects', () => {
    setLocation('/login?next=%2F%2Fevil.example')

    expect(getNextPath()).toBe('/')
  })

  it('rejects cross-origin absolute redirects', () => {
    setLocation('/login?next=https%3A%2F%2Fevil.example%2F')

    expect(getNextPath()).toBe('/')
  })

  it('rejects login loops', () => {
    setLocation('/login?next=%2Flogin%3Fnext%3D%252F')

    expect(getNextPath()).toBe('/')
  })
})
