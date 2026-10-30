import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attentionOf,
  formatAge,
  markSeen,
  mostUrgent,
  resetSeenForTests,
  seenAtOf,
  seenSnapshot,
  shareSeen,
} from './attention'

const NOW = 10 * 3_600_000
const at = (minutesAgo: number) => NOW - minutesAgo * 60_000

describe('attentionOf', () => {
  it('is needs-you while blocked and not seen since', () => {
    const blocked = {
      activity: 'blocked',
      activity_previous: 'working',
      activity_at: at(3),
    } as const
    expect(attentionOf(blocked, 0, NOW)).toMatchObject({
      group: 'needs-you',
      detail: 'waiting 3m',
      age: '3m',
    })
    // Opened after it blocked: still waiting, but no longer needs-you.
    expect(attentionOf(blocked, at(1), NOW)).toMatchObject({
      group: 'idle',
      detail: 'waiting 3m',
    })
  })

  it('needs you while a blocking ask is open, even after it was opened', () => {
    const asking = {
      activity: 'idle' as const,
      activity_previous: 'working' as const,
      activity_at: at(10),
      asks: [
        { id: 'a1', question: 'Later?', blocking: false, created_at: at(9) },
        { id: 'a2', question: 'Finish it?', blocking: true, created_at: at(4) },
      ],
    }
    expect(attentionOf(asking, at(1), NOW)).toMatchObject({
      group: 'needs-you',
      activity: 'idle',
      detail: 'asks you 4m',
    })
    // A question the agent asked without stopping does not move the session.
    expect(
      attentionOf({ ...asking, asks: [asking.asks[0]] }, at(1), NOW).group,
    ).toBe('idle')
  })

  it('is finished only for a turn that ended since it was last open', () => {
    const done = {
      activity: 'idle',
      activity_previous: 'working',
      activity_at: at(1),
    } as const
    expect(attentionOf(done, at(5), NOW)).toMatchObject({
      group: 'finished',
      detail: 'done 1m',
    })
    expect(attentionOf(done, at(0), NOW)).toMatchObject({
      group: 'idle',
      detail: 'idle 1m',
    })
    // An idle agent Tether only just found (unknown -> idle) is not finished.
    const found = {
      activity: 'idle',
      activity_previous: 'unknown',
      activity_at: at(1),
    } as const
    expect(attentionOf(found, 0, NOW).group).toBe('idle')
  })

  it('handles working, unknown and missing fields', () => {
    expect(
      attentionOf({ activity: 'working', activity_at: at(120) }, 0, NOW),
    ).toMatchObject({
      group: 'working',
      detail: 'working 2h',
    })
    // No state from Tether (a shell, Pi) is not idle.
    expect(attentionOf({}, 0, NOW)).toMatchObject({
      group: 'no-status',
      activity: 'unknown',
      detail: null,
      age: null,
    })
  })
})

describe('ordering', () => {
  it('picks the most urgent of several', () => {
    const items = [
      attentionOf({ activity: 'idle', activity_at: at(1) }, 0, NOW),
      attentionOf({ activity: 'blocked', activity_at: at(1) }, 0, NOW),
      attentionOf({ activity: 'working', activity_at: at(1) }, 0, NOW),
      attentionOf({ activity: 'blocked', activity_at: at(9) }, 0, NOW),
    ]
    expect(mostUrgent(items)?.detail).toBe('waiting 1m')
    expect(mostUrgent([])).toBeNull()
  })

  it('formats ages', () => {
    expect(formatAge(10_000)).toBe('<1m')
    expect(formatAge(59 * 60_000)).toBe('59m')
    expect(formatAge(25 * 3_600_000)).toBe('1d')
  })
})

describe('seen store', () => {
  beforeEach(() => {
    localStorage.clear()
    resetSeenForTests()
  })

  it('persists per browser', () => {
    markSeen(['a0000001'], 123)
    resetSeenForTests()
    expect(seenSnapshot()).toEqual({ a0000001: 123 })
  })
  it('takes the later of this browser and any device, and tells the server', () => {
    expect(seenAtOf({ id: 'a', seen_at: 500 }, { a: 100 })).toBe(500)
    expect(seenAtOf({ id: 'a', seen_at: null }, { a: 100 })).toBe(100)
    expect(seenAtOf({ id: 'b' }, {})).toBe(0)
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      shareSeen(['a0000001'])
      shareSeen([])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/sessions/seen',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ids: ['a0000001'] }),
        }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
