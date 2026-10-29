import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  liveTiming,
  useLiveVersion,
} from '../../../../electron/shared/chat/live'
import type {
  ChatCallResult,
  ChatInfo,
  ChatTransport,
} from '../../../../electron/shared/chat/types'

const info = (readOnly: boolean): ChatInfo => ({
  sessionId: 'a1',
  agentSlug: 'coder',
  requestedModel: null,
  readOnly,
})

const read = (status: string, text: string): ChatCallResult => ({
  ok: true,
  value: { status, messages: [{ id: 1, content: text }] },
})

/** A transport whose session reads come from a list, the last one repeating. */
function transportOf(answers: ChatCallResult[]) {
  let calls = 0
  const transport: ChatTransport = {
    call: async () => answers[Math.min(calls++, answers.length - 1)],
    openStream: async () => () => undefined,
  }
  return { transport, calls: () => calls }
}

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

describe('the live version of a step view', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('moves on when the running step wrote something new, and not when it did not', async () => {
    const { transport } = transportOf([
      read('active', 'one'),
      read('active', 'one'),
      read('active', 'one two'),
      read('active', 'one two'),
    ])
    const { result } = renderHook(() => useLiveVersion(info(true), transport))
    await settle()
    expect(result.current).toEqual({ version: 0, stale: false }) // the first read is what the view loaded
    await wait(liveTiming.firstMs)
    expect(result.current.version).toBe(0) // nothing new
    await wait(liveTiming.firstMs * liveTiming.growth)
    expect(result.current.version).toBe(1) // the step wrote more
  })

  it('reads once more when the step ends, then stops', async () => {
    const { transport, calls } = transportOf([
      read('active', 'one'),
      read('completed', 'one done'),
    ])
    const { result } = renderHook(() => useLiveVersion(info(true), transport))
    await settle()
    await wait(liveTiming.firstMs)
    expect(result.current.version).toBe(1)
    const before = calls()
    await wait(liveTiming.maxMs * 3)
    expect(calls()).toBe(before)
  })

  it('says it may be behind while reads fail, and clears when one works', async () => {
    const down: ChatCallResult = {
      ok: false,
      error: { code: 'tether_unavailable', message: 'down' },
    }
    const { transport } = transportOf([
      read('active', 'one'),
      down,
      read('active', 'one'),
    ])
    const { result } = renderHook(() => useLiveVersion(info(true), transport))
    await settle()
    await wait(liveTiming.firstMs)
    expect(result.current.stale).toBe(true)
    await wait(liveTiming.maxMs)
    expect(result.current).toEqual({ version: 0, stale: false })
  })

  it('reads nothing for a chat the owner can talk to', async () => {
    const { transport, calls } = transportOf([read('active', 'one')])
    renderHook(() => useLiveVersion(info(false), transport))
    await wait(liveTiming.maxMs * 2)
    expect(calls()).toBe(0)
  })
})
