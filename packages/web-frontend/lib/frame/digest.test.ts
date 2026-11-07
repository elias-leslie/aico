import { describe, expect, it } from 'vitest'
import {
  type Digest,
  digestParts,
  resolveDigestStart,
  spendText,
} from './digest'

const digest = (patch: Partial<Digest> = {}): Digest => ({
  since: 0,
  generatedAt: 0,
  finished: 3,
  failed: 1,
  stuck: { quiet: 0, waiting: 0 },
  asks: 0,
  problems: { count: 0, failed: 0 },
  spend: null,
  unavailable: [],
  ...patch,
})

describe('digest start', () => {
  const now = 10_000_000
  it('keeps the start a reload already had, so the line does not fall to nothing', () => {
    expect(resolveDigestStart(now - 60_000, now - 3_000_000, now)).toBe(
      now - 3_000_000,
    )
  })
  it('starts a new digest at the last look after a long absence', () => {
    expect(resolveDigestStart(now - 3_600_000, now - 7_000_000, now)).toBe(
      now - 3_600_000,
    )
  })
  it('has no start for a device that never looked', () => {
    expect(resolveDigestStart(null, now - 1000, now)).toBeNull()
  })
})

describe('digest parts', () => {
  it('splits the failed phrase out so it can open the failed sessions', () => {
    const parts = digestParts(digest())
    expect(parts.finished).toBe('3 finished, 1 of them failed')
    expect(parts.finishedLead).toBe('3 finished,')
    expect(parts.failedPhrase).toBe('1 of them failed')
    expect(digestParts(digest({ failed: 0 })).failedPhrase).toBeNull()
  })
  it('counts the questions waiting now, not just the new ones', () => {
    expect(digestParts(digest({ asks: 0 }), 1).rest).toEqual([
      '1 question waiting',
    ])
    expect(digestParts(digest({ asks: 2 })).rest).toEqual([
      '2 new questions waiting',
    ])
    expect(digestParts(digest(), 0).rest).toEqual([])
  })
  it('calls a reminder a notice and a failed Status row a failed check', () => {
    const parts = digestParts(digest({ asks: 0 }), 0, {
      notices: 1,
      checks: 2,
    })
    expect(parts.rest).toEqual(['1 notice waiting', '2 failed checks waiting'])
    expect(parts.quiet).toBe(false)
  })
})

describe('spend text', () => {
  it('says spent, so it does not read as a balance', () => {
    expect(
      spendText(
        digest({
          spend: {
            sinceDay: '2026-11-06',
            items: [{ provider: 'codex', credits: 1500 }],
          },
        }),
      ),
    ).toBe('Codex spent 1.5K credits')
  })
})
