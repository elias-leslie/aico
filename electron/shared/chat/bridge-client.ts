// An Agent Hub client for the chat view that talks only to a chat transport:
// Electron's preload bridge (`window.aico.chat`) or the web app's HTTP. It has
// the shape the shared chat component expects of an `@agent-hub/sdk` client,
// but nothing here knows where Agent Hub is, who the owner is or which session
// other than this view's: the other end answers for the view's own session
// through Tether, and Tether holds the credentials.

import type { ChatHubClient } from '@agent-hub/chat-ui'
import type {
  AgentHubError,
  CancelResult,
  IdleEvent,
  StreamOptions,
  TurnEvent,
  TurnRequest,
} from '@agent-hub/sdk'
import type { ChatFailure, ChatInfo, ChatStreamItem, ChatTransport } from './types'

export type ChatBridge = ChatTransport

/** Reconnects in a row without progress, as the SDK's own default. */
const REATTACH_ATTEMPTS = 5
const REATTACH_INITIAL_MS = 500
const REATTACH_MAX_MS = 10_000
/** Failures that mean "try the stream again"; any other ends the turn view. */
const RECONNECTABLE = new Set(['tether_unavailable', 'stream_interrupted', 'agent_hub_unavailable'])

type AnyEvent = TurnEvent | IdleEvent

function aborted(): Error {
  return Object.assign(new Error('Aborted'), { name: 'AbortError' })
}

/** An error the chat component reads like the SDK's: a message, a code and an HTTP-style status. */
export function hubError(failure: ChatFailure): AgentHubError {
  return Object.assign(new Error(failure.message), {
    name: 'AgentHubError',
    code: failure.code,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
  }) as unknown as AgentHubError
}

function isTerminal(event: AnyEvent): boolean {
  return (
    event.type === 'idle' ||
    event.type === 'done' ||
    event.type === 'error' ||
    event.type === 'cancel_acknowledged'
  )
}

/** Items from the bridge, one at a time, for a loop that awaits them. */
class ItemQueue {
  private readonly items: ChatStreamItem[] = []
  private waiting: ((item: ChatStreamItem) => void) | null = null

  push = (item: ChatStreamItem): void => {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve(item)
    } else {
      this.items.push(item)
    }
  }

  next(): Promise<ChatStreamItem> {
    const item = this.items.shift()
    if (item) return Promise.resolve(item)
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(aborted())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface FollowOptions {
  signal?: AbortSignal
  onReattach?: StreamOptions['onReattach']
}

export interface BridgeClientOptions {
  /** The model for a message sent now: a catalog model, or null for the agent's own routing. */
  model?: () => string | null
  /** The effort for a message sent now: a level, or null for the model's own default. */
  effort?: () => string | null
  /** A turn is running (its events are arriving), or none is. Fires on a change only. */
  onBusy?: (busy: boolean) => void
  /** Stop took follow-ups that were waiting behind the turn out of the queue. They were
   * not sent: the view puts their text back in the message box, oldest first. */
  onRestore?: (texts: string[]) => void
}

export function createBridgeClient(
  bridge: ChatBridge,
  info: ChatInfo,
  hooks: BridgeClientOptions = {},
): ChatHubClient {
  // Followers that have seen a turn event and not yet its end; more than one can be
  // open at once (a send's stream and the chat's own attach).
  let running = 0
  const track = (delta: number): void => {
    const was = running > 0
    running = Math.max(0, running + delta)
    if (running > 0 !== was) hooks.onBusy?.(running > 0)
  }

  /** A message to send: its text, and the model and effort chosen for it when the window has pickers. */
  const outgoing = (text: string): Record<string, unknown> => ({
    text,
    ...(hooks.model ? { model: hooks.model() } : {}),
    ...(hooks.effort ? { thinkingLevel: hooks.effort() } : {}),
  })

  async function call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const answer = await bridge.call(method, { sessionId: info.sessionId, ...args })
    if (!answer.ok) throw hubError(answer.error)
    return answer.value as T
  }

  /** The turn's events after `afterSeq`, each once, reconnecting when the stream drops. */
  async function* follow(afterSeq: number, options: FollowOptions): AsyncGenerator<AnyEvent> {
    let live = false
    const mark = (on: boolean): void => {
      if (on === live) return
      live = on
      track(on ? 1 : -1)
    }
    try {
      yield* followEvents(afterSeq, options, mark)
    } finally {
      mark(false)
    }
  }

  async function* followEvents(
    afterSeq: number,
    options: FollowOptions,
    mark: (on: boolean) => void,
  ): AsyncGenerator<AnyEvent> {
    let last = afterSeq
    let failures = 0
    for (;;) {
      if (options.signal?.aborted) throw aborted()
      const queue = new ItemQueue()
      let close: () => void = () => undefined
      let cut: AgentHubError | null = null
      const onAbort = () => {
        close()
        queue.push({ kind: 'error', error: { code: 'aborted', message: 'Aborted' } })
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        close = await bridge.openStream(last, queue.push)
        if (options.signal?.aborted) throw aborted()
        for (;;) {
          const item = await queue.next()
          if (options.signal?.aborted) throw aborted()
          if (item.kind === 'event') {
            const event = item.event as unknown as AnyEvent
            const seq = (event as { seq?: unknown }).seq
            if (typeof seq === 'number') {
              if (seq <= last) continue
              last = seq
            }
            failures = 0
            mark(!isTerminal(event))
            yield event
            if (isTerminal(event)) return
          } else if (item.kind === 'end') {
            cut = hubError({
              code: 'stream_interrupted',
              message: 'The connection to the running turn ended early.',
            })
            break
          } else if (RECONNECTABLE.has(item.error.code)) {
            cut = hubError(item.error)
            break
          } else {
            throw hubError(item.error)
          }
        }
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        close()
      }
      failures += 1
      if (failures > REATTACH_ATTEMPTS) throw cut
      const delayMs = Math.min(REATTACH_INITIAL_MS * 2 ** (failures - 1), REATTACH_MAX_MS)
      options.onReattach?.({
        attempt: failures,
        delayMs,
        afterSeq: last,
        error: cut as AgentHubError,
      })
      await sleep(delayMs, options.signal)
    }
  }

  function lastUserText(request: TurnRequest): string {
    const messages = (request as { messages?: { role: string; content: unknown }[] }).messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === 'user' && typeof message.content === 'string') return message.content
    }
    throw hubError({ code: 'invalid_text', message: 'There is no message to send.' })
  }

  return {
    baseUrl: 'aico',
    turns: {
      // A send goes through Tether (its follow-up queue); the answer is then followed
      // from the first event of whichever turn is running, so a send that found the
      // session busy still shows that turn instead of failing.
      async *stream(request, options) {
        if (options?.signal?.aborted) throw aborted()
        await call('send', outgoing(lastUserText(request)))
        yield* follow(0, options ?? {}) as AsyncGenerator<TurnEvent>
      },
      attach: (_sessionId, options) => follow(options?.afterSeq ?? 0, options ?? {}),
      cancel: async (sessionId) => {
        const answer = await call<CancelResult & { restored?: string[] }>('cancel', { sessionId })
        if (answer.restored?.length) hooks.onRestore?.(answer.restored)
        return answer
      },
    },
    sessions: {
      get: (sessionId) => call('session', { sessionId }),
      fork: () =>
        Promise.reject(
          hubError({ code: 'unsupported', message: 'Forking is not available here.' }),
        ),
    },
    models: { list: () => call('models') },
    followUps: {
      send: (sessionId, text) => call('send', { sessionId, ...outgoing(text) }),
      pending: (sessionId) => call('queue', { sessionId }),
    },
  }
}
