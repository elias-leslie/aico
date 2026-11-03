import { describe, expect, it } from 'vitest'
import { fingerprint, isRunning, liveTiming, nextDelay, readSession } from './live'
import type { ChatTransport } from './types'

const session = (extra: object = {}) => ({
  status: 'active',
  total_input_tokens: 10,
  total_output_tokens: 2,
  messages: [{ id: 1, content: 'hi', tool_executions: [{ id: 't1', status: 'running' }] }],
  ...extra,
})

describe('live refresh timing', () => {
  it('starts at the first wait, slows when nothing changes up to the longest, and starts over on a change', () => {
    let delay = nextDelay(null, false)
    expect(delay).toBe(liveTiming.firstMs)
    const seen = [delay]
    for (let i = 0; i < 8; i++) {
      delay = nextDelay(delay, false)
      seen.push(delay)
    }
    expect(seen.every((value, i) => i === 0 || value >= seen[i - 1])).toBe(true)
    expect(delay).toBe(liveTiming.maxMs)
    expect(nextDelay(delay, true)).toBe(liveTiming.firstMs)
  })
})

describe('what counts as a change', () => {
  it('differs when a message grows, a tool line finishes, or the step ends', () => {
    const base = fingerprint(session())
    expect(fingerprint(session())).toBe(base)
    expect(
      fingerprint(session({ messages: [{ id: 1, content: 'hi there', tool_executions: [] }] })),
    ).not.toBe(base)
    expect(
      fingerprint(
        session({
          messages: [{ id: 1, content: 'hi', tool_executions: [{ id: 't1', status: 'complete' }] }],
        }),
      ),
    ).not.toBe(base)
    expect(fingerprint(session({ status: 'completed' }))).not.toBe(base)
    expect(fingerprint(null)).toBe(fingerprint({}))
  })

  it('knows a running attempt from a finished one', () => {
    expect(isRunning(session())).toBe(true)
    for (const status of ['completed', 'failed', 'cancelled', undefined]) {
      expect(isRunning(session({ status }))).toBe(false)
    }
  })
})

describe('reading the session', () => {
  const transport = (answer: Awaited<ReturnType<ChatTransport['call']>>): ChatTransport => ({
    call: async () => answer,
    openStream: async () => () => undefined,
  })

  it('reports a failed read as failed, never as an empty session', async () => {
    const read = await readSession(
      transport({ ok: false, error: { code: 'tether_unavailable', message: 'down' } }),
      's',
    )
    expect(read).toEqual({ kind: 'failed' })
  })

  it('reports whether the step is still running and what it holds', async () => {
    const read = await readSession(transport({ ok: true, value: session() }), 's')
    expect(read).toEqual({ kind: 'read', running: true, fingerprint: fingerprint(session()) })
  })
})
