import { describe, expect, it } from 'vitest'
import type { Attention } from '../attention'
import { askText, NO_ASKS, rowState } from './triage'

const NOW = Date.parse('2026-11-06T20:00:00')
const attention = (
  group: Attention['group'],
  at: number | null,
): Attention => ({
  group,
  activity: 'working',
  at,
  detail: null,
  age: null,
})

describe('rowState', () => {
  it('says needs you', () => {
    expect(rowState(attention('needs-you', NOW), undefined, NOW)).toMatchObject(
      { text: 'waiting for you', tone: 'need' },
    )
  })
  it('says working until it has been quiet a while, then how long', () => {
    const working = attention('working', NOW - 3_600_000)
    expect(
      rowState(
        working,
        {
          session: 's',
          conversation: 'c',
          activity: 'working',
          lastWriteAt: NOW - 3 * 60_000,
        },
        NOW,
      ),
    ).toMatchObject({ text: 'working', tone: 'work', quiet: null })
    expect(
      rowState(
        working,
        {
          session: 's',
          conversation: 'c',
          activity: 'working',
          lastWriteAt: NOW - 14 * 60_000,
        },
        NOW,
      ),
    ).toMatchObject({ text: 'working, quiet 14 min', tone: 'quiet', quiet: 14 })
  })
  it('does not call a working session quiet when the write time is unknown', () => {
    expect(
      rowState(
        attention('working', NOW),
        {
          session: 's',
          conversation: null,
          activity: 'working',
          lastWriteAt: null,
        },
        NOW,
      ).quiet,
    ).toBeNull()
  })
  it('says idle since a time and finished with its time', () => {
    expect(
      rowState(attention('idle', NOW - 60_000), undefined, NOW).text,
    ).toMatch(/^idle since \d{1,2}:\d{2} (AM|PM)$/)
    expect(
      rowState(attention('finished', NOW - 60_000), undefined, NOW).text,
    ).toMatch(/^finished \d{1,2}:\d{2} (AM|PM)$/)
    expect(rowState(attention('idle', null), undefined, NOW).text).toBe('idle')
  })
})

describe('a shell row', () => {
  it('reads running, not no status, since a shell has no agent state', () => {
    expect(
      rowState(attention('no-status', null), undefined, NOW, true),
    ).toMatchObject({
      text: 'running',
    })
    expect(rowState(null, undefined, NOW, true).text).toBe('running')
    expect(rowState(null, undefined, NOW).text).toBe('no status')
  })
})

describe('askText', () => {
  it('names only the questions that do not block', () => {
    expect(askText(NO_ASKS)).toBeNull()
    expect(askText({ blocking: 1, other: 0 })).toBeNull()
    expect(askText({ blocking: 0, other: 1 })).toBe('1 question for you')
    expect(askText({ blocking: 0, other: 2 })).toBe('2 questions for you')
  })
})
