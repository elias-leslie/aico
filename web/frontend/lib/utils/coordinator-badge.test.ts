import { describe, expect, it } from 'vitest'
import { getCoordinatorBadge } from './coordinator-badge'

describe('getCoordinatorBadge', () => {
  it('labels a coordinator in its own colour', () => {
    expect(
      getCoordinatorBadge({
        is_coordinator: true,
        coordinator_color: '#f0a35e',
      }),
    ).toEqual({ label: 'Coordinator', color: '#f0a35e' })
  })

  it('names a lane’s coordinator in that coordinator’s colour', () => {
    expect(
      getCoordinatorBadge({
        coordinator_id: 'd2852144',
        coordinator_name: 'Personal Workspace',
        coordinator_color: '#6fa8ff',
      }),
    ).toEqual({ label: '↳ Personal Workspace', color: '#6fa8ff' })
  })

  it('falls back when the coordinator ended or the colour is missing', () => {
    expect(getCoordinatorBadge({ coordinator_id: 'deadbeef' })).toEqual({
      label: '↳ Coordinator',
      color: '#6fa8ff',
    })
    expect(
      getCoordinatorBadge({ is_coordinator: true, coordinator_color: 'red' }),
    ).toEqual({ label: 'Coordinator', color: '#6fa8ff' })
  })

  it('shows nothing for a session outside any coordinator', () => {
    expect(getCoordinatorBadge({})).toBeNull()
    expect(getCoordinatorBadge(null)).toBeNull()
  })
})
