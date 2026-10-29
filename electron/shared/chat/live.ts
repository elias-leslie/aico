// A running workflow step keeps writing to its attempt session, and the chat view reads a
// session once when it opens. This is how a read-only step view reads it again while the
// step runs: on a timer that slows when nothing changes, and stops when the step is over.

import { useEffect, useState } from 'react'
import type { ChatInfo, ChatTransport } from './types'

/** When a running step's conversation is read again: the first wait, how much each quiet
 * read lengthens it, and the longest wait. A read that finds something new starts over. */
export const liveTiming = { firstMs: 2_000, growth: 1.5, maxMs: 10_000 }

/** The wait before the next read. */
export function nextDelay(current: number | null, changed: boolean): number {
  if (current === null || changed) return liveTiming.firstMs
  return Math.min(liveTiming.maxMs, Math.round(current * liveTiming.growth))
}

interface SessionRead {
  status?: unknown
  total_input_tokens?: unknown
  total_output_tokens?: unknown
  messages?: {
    id?: unknown
    content?: unknown
    thinking?: unknown
    tool_executions?: { id?: unknown; status?: unknown; result?: unknown }[]
  }[]
}

const size = (value: unknown): number =>
  typeof value === 'string' ? value.length : value == null ? 0 : JSON.stringify(value).length

/** What the view shows of a session, as one string: it differs when a message, a tool line
 * or the totals changed. */
export function fingerprint(session: unknown): string {
  const read = (session && typeof session === 'object' ? session : {}) as SessionRead
  const messages = (read.messages ?? []).map((message) => [
    message.id,
    size(message.content),
    size(message.thinking),
    (message.tool_executions ?? []).map((tool) => [tool.id, tool.status, size(tool.result)]),
  ])
  return JSON.stringify([read.status, read.total_input_tokens, read.total_output_tokens, messages])
}

/** The attempt is still being worked on (Agent Hub marks a finished one completed, failed or cancelled). */
export const isRunning = (session: unknown): boolean =>
  (session as SessionRead | null)?.status === 'active'

export type LiveRead = { kind: 'failed' } | { kind: 'read'; running: boolean; fingerprint: string }

export async function readSession(transport: ChatTransport, sessionId: string): Promise<LiveRead> {
  const answer = await transport.call('session', { sessionId })
  if (!answer.ok) return { kind: 'failed' }
  return { kind: 'read', running: isRunning(answer.value), fingerprint: fingerprint(answer.value) }
}

/**
 * A read-only step view while its step runs: reads the session again on a slowing timer and
 * counts a new version whenever it changed, so the view reloads what the step has done so far.
 * `stale` is set while a read fails, so the view says it may be behind. `ended` is set once a read finds the step over. A session the owner can talk
 * to streams its own turns and is never read this way; a step that is over is read once more and left.
 */
export function useLiveVersion(
  info: ChatInfo,
  transport: ChatTransport,
): { version: number; stale: boolean; ended: boolean } {
  const [state, setState] = useState({ version: 0, stale: false, ended: false })
  const watch = info.readOnly === true
  useEffect(() => {
    if (!watch) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let seen: string | null = null
    let delay: number | null = null
    const tick = async () => {
      const read = await readSession(transport, info.sessionId)
      if (stopped) return
      if (read.kind === 'failed') {
        setState((now) => (now.stale ? now : { ...now, stale: true }))
        delay = nextDelay(delay, false)
      } else {
        // The first read is what the view itself just loaded; later ones that differ reload it.
        const changed = seen !== null && read.fingerprint !== seen
        seen = read.fingerprint
        const ended = !read.running
        setState((now) =>
          changed || now.stale || now.ended !== ended
            ? { version: now.version + (changed ? 1 : 0), stale: false, ended }
            : now,
        )
        if (!read.running) return // the step is over: this read was the last
        delay = nextDelay(delay, changed)
      }
      timer = setTimeout(() => void tick(), delay)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [watch, info.sessionId, transport])
  return state
}
