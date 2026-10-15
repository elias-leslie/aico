import { describe, expect, it } from 'vitest'
import { safeNextPath } from './safe-next'

const BASE = 'https://terminal.summitflow.dev/login'

describe('safeNextPath', () => {
  it('keeps same-origin paths with query and hash', () => {
    expect(safeNextPath('/?project=a-term#p', BASE)).toBe('/?project=a-term#p')
  })

  it.each([
    null,
    '',
    '//evil.example',
    '//evil.example/path',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    'https://evil.example/',
    'javascript:alert(1)',
    '/login?next=%2F',
    '/.//evil.example',
    '/..//evil.example',
    '/a/..//evil.example',
    '/%2e//evil.example',
    '/%2E%2E//evil.example',
    '/./\\evil.example',
  ])('falls back to / for %j', (next) => {
    expect(safeNextPath(next, BASE)).toBe('/')
  })
})
