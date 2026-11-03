import { describe, expect, it } from 'vitest'
import { type PeerSync, syncLine } from './use-sync-status'

const peer = (over: Partial<PeerSync> = {}): PeerSync => ({
  name: 'gem',
  state: 'ok',
  lastSyncAt: 1_000,
  skewMs: 40,
  reason: null,
  ...over,
})
const age = (ms: number) => `${Math.round(ms / 1000)}s`

describe('syncLine', () => {
  it('says when the last sync was, quietly', () => {
    expect(syncLine(peer(), 31_000, age)).toEqual({
      text: 'Notes synced 30s ago',
      warn: false,
    })
  })

  it('warns on a clock gap past five seconds, either way', () => {
    expect(syncLine(peer({ skewMs: -9_000 }), 1_000, age)).toEqual({
      text: 'Notes synced 0s ago · clock 9 s behind',
      warn: true,
    })
  })

  it('warns when the other Aico is a different build', () => {
    expect(syncLine(peer({ buildMismatch: true }), 1_000, age)).toEqual({
      text: 'Notes synced 0s ago · different Aico version',
      warn: true,
    })
  })

  it('names why sync is paused, and says a down link is only waiting', () => {
    expect(
      syncLine(
        peer({ state: 'paused', reason: 'Update the other one.' }),
        0,
        age,
      ),
    ).toEqual({ text: 'Notes sync paused: Update the other one.', warn: true })
    expect(
      syncLine(peer({ state: 'down', lastSyncAt: null }), 0, age).text,
    ).toBe('Notes sync waiting for the link (not synced yet)')
  })
})
