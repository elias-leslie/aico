import { beforeEach, describe, expect, it } from 'vitest'
import {
  attentionOf,
  compareAttention,
  formatAge,
  markSeen,
  mostUrgent,
  resetSeenForTests,
  seenSnapshot,
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
  it('sorts most urgent first; longest wait first among needs-you', () => {
    const items = [
      attentionOf({ activity: 'idle', activity_at: at(1) }, 0, NOW),
      attentionOf({ activity: 'blocked', activity_at: at(1) }, 0, NOW),
      attentionOf({ activity: 'working', activity_at: at(1) }, 0, NOW),
      attentionOf({ activity: 'blocked', activity_at: at(9) }, 0, NOW),
    ]
    expect([...items].sort(compareAttention).map((a) => a.detail)).toEqual([
      'waiting 9m',
      'waiting 1m',
      'working 1m',
      'idle 1m',
    ])
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
})
