import { describe, expect, it } from 'vitest'
import { TETHER_CAN } from '@/test-stubs/session-fixtures'
import type { ATermSession } from './use-a-term-sessions'
import {
  deriveActiveSessionId,
  parsePersistedSessionId,
  shouldSyncSessionParam,
} from './use-active-session'

const sessions: ATermSession[] = [
  {
    id: 'session-1',
    name: 'A-Term 1',
    user_id: null,
    project_id: null,
    working_dir: null,
    mode: 'shell',
    display_order: 0,
    is_alive: true,
    created_at: '2026-03-06T00:00:00Z',
    last_accessed_at: '2026-03-06T00:00:00Z',
    ...TETHER_CAN,
  },
  {
    id: 'session-2',
    name: 'A-Term 2',
    user_id: null,
    project_id: 'project-2',
    working_dir: null,
    mode: 'shell',
    display_order: 1,
    is_alive: true,
    created_at: '2026-03-06T00:00:00Z',
    last_accessed_at: '2026-03-06T00:00:00Z',
    ...TETHER_CAN,
  },
]

describe('deriveActiveSessionId', () => {
  it('uses the URL session when it still exists', () => {
    expect(deriveActiveSessionId(sessions, 'session-2', null)).toBe('session-2')
  })

  it('falls back to the first live session when the URL session is stale', () => {
    expect(deriveActiveSessionId(sessions, 'stale-session', null)).toBe(
      'session-1',
    )
  })

  it('uses the project session when there is no valid URL session', () => {
    expect(deriveActiveSessionId(sessions, null, 'project-2')).toBe('session-2')
  })

  it('uses the persisted session when URL state is missing and the session still exists', () => {
    expect(deriveActiveSessionId(sessions, null, null, 'session-2')).toBe(
      'session-2',
    )
  })

  it('never picks a free-standing View on its own: another agent may be using it', () => {
    const otherAgent = { ...sessions[1], id: 'other-agent', is_external: true }
    expect(deriveActiveSessionId([otherAgent, ...sessions], null, null)).toBe(
      'session-1',
    )
    expect(deriveActiveSessionId([otherAgent], null, null)).toBe(null)
    expect(deriveActiveSessionId([otherAgent], null, 'project-2')).toBe(null)
  })

  it('keeps a free-standing View the user chose by URL or earlier', () => {
    const otherAgent = { ...sessions[1], id: 'other-agent', is_external: true }
    expect(deriveActiveSessionId([otherAgent], 'other-agent', null)).toBe(
      'other-agent',
    )
    expect(deriveActiveSessionId([otherAgent], null, null, 'other-agent')).toBe(
      'other-agent',
    )
  })

  it('returns null when sessions array is empty', () => {
    expect(deriveActiveSessionId([], 'session-1', null)).toBe(null)
  })
})

describe('parsePersistedSessionId', () => {
  it('reads the current JSON string format', () => {
    expect(parsePersistedSessionId('"session-2"')).toBe('session-2')
  })

  it('preserves legacy raw string values', () => {
    expect(parsePersistedSessionId('session-2')).toBe('session-2')
  })

  it('ignores non-string JSON payloads', () => {
    expect(parsePersistedSessionId('{"session":"session-2"}')).toBe(null)
  })
})

describe('shouldSyncSessionParam', () => {
  it('requires a sync when the URL session is stale', () => {
    expect(shouldSyncSessionParam('session-1', 'stale-session')).toBe(true)
  })

  it('requires a sync when there is no session in the URL', () => {
    expect(shouldSyncSessionParam('session-1', null)).toBe(true)
  })

  it('does not sync when the URL already matches the active session', () => {
    expect(shouldSyncSessionParam('session-1', 'session-1')).toBe(false)
  })

  it('does not sync when activeSessionId is null', () => {
    expect(shouldSyncSessionParam(null, 'session-1')).toBe(false)
  })
})
