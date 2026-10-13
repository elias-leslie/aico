import { describe, expect, it } from 'vitest'
import { getCoordinatorBadge } from './coordinator-badge'

describe('getCoordinatorBadge', () => {
  it('shows Tether’s badge as it is', () => {
    expect(
      getCoordinatorBadge({
        badge: { kind: 'coordinator', text: 'Coordinator', color: '#f0a35e' },
      }),
    ).toEqual({ label: 'Coordinator', color: '#f0a35e' })
    expect(
      getCoordinatorBadge({
        badge: {
          kind: 'child',
          text: '↳ Personal Workspace',
          color: '#6fa8ff',
        },
      }),
    ).toEqual({ label: '↳ Personal Workspace', color: '#6fa8ff' })
  })

  it('shows nothing without a well-formed badge', () => {
    expect(getCoordinatorBadge({})).toBeNull()
    expect(getCoordinatorBadge(null)).toBeNull()
    expect(
      getCoordinatorBadge({
        badge: { kind: 'child', text: '↳ X', color: 'red' },
      }),
    ).toBeNull()
    expect(
      getCoordinatorBadge({
        badge: { kind: 'child', text: ' ', color: '#6fa8ff' },
      }),
    ).toBeNull()
  })
})
