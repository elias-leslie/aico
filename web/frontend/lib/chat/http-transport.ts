// The chat view's transport in the browser: HTTP to this app's own server
// (web/server/src/chat.ts), which forwards to Tether. The same two
// operations the desktop's preload bridge offers, so the shared chat view
// cannot tell them apart. No token or Agent Hub address is ever in the page.

import type {
  ChatCallResult,
  ChatFailure,
  ChatInfo,
  ChatStreamItem,
  ChatTransport,
} from '../../../../shared/chat/types'

/** What a chat view reads: a Tether session, or a workflow step's attempt. */
export type ChatSource =
  | { session: string }
  | { run: string; step: string; attempt?: string }

const JSON_HEADERS = { 'Content-Type': 'application/json' }

const fail = (
  code: string,
  message: string,
  status?: number,
): ChatCallResult => ({
  ok: false,
  error: { code, message, ...(status !== undefined ? { status } : {}) },
})

const UNREACHABLE = "Aico's web server is not reachable."

function isResult(value: unknown): value is ChatCallResult {
  if (!value || typeof value !== 'object') return false
  const { ok, error } = value as { ok?: unknown; error?: unknown }
  return ok === true || (ok === false && !!error && typeof error === 'object')
}

/** The server's answer, or the words for an answer that is not one of ours. */
async function readResult(response: Response): Promise<ChatCallResult> {
  const body: unknown = await response.json().catch(() => null)
  if (isResult(body)) return body
  if (response.status === 403)
    return fail(
      'refused',
      'The web app refused this request. Reload the page.',
      403,
    )
  return fail('chat_failed', 'The chat request failed.', response.status)
}

async function post(
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<ChatCallResult> {
  try {
    const response = await fetchImpl(path, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    return await readResult(response)
  } catch {
    return fail('tether_unavailable', UNREACHABLE)
  }
}

/** Failures carry the server's words; this is the Error a query shows. */
export class ChatInfoError extends Error {
  constructor(readonly failure: ChatFailure) {
    super(failure.message)
  }
}

/** Which Agent Hub session the source shows (and, for a step, which attempt). */
export async function fetchChatInfo(
  source: ChatSource,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatInfo> {
  const answer = await post('/api/chat/info', source, fetchImpl)
  if (!answer.ok) throw new ChatInfoError(answer.error)
  return answer.value as ChatInfo
}

/** The whole `data:` frames in `buffer`, and what is left of a frame still arriving. */
function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split('\n\n')
  return { frames: parts.slice(0, -1), rest: parts.at(-1) ?? '' }
}

function isItem(value: unknown): value is ChatStreamItem {
  const kind = (value as { kind?: unknown } | null)?.kind
  return kind === 'event' || kind === 'end' || kind === 'error'
}

export function createHttpTransport(
  source: ChatSource,
  fetchImpl: typeof fetch = fetch,
): ChatTransport {
  return {
    call: (method, args) =>
      post('/api/chat/call', { ...source, method, args }, fetchImpl),

    async openStream(afterSeq, onItem) {
      const controller = new AbortController()
      let closed = false
      const deliver = (item: ChatStreamItem) => {
        if (!closed) onItem(item)
      }
      // A cut connection is something to reattach, not a final failure.
      const cut: ChatStreamItem = {
        kind: 'error',
        error: {
          code: 'stream_interrupted',
          message: 'The connection to the running turn was lost.',
        },
      }
      const run = async () => {
        try {
          const query = new URLSearchParams(
            Object.entries(source).filter(
              (pair): pair is [string, string] => !!pair[1],
            ),
          )
          if (afterSeq > 0) query.set('afterSeq', String(afterSeq))
          const response = await fetchImpl(`/api/chat/stream?${query}`, {
            headers: { Accept: 'text/event-stream' },
            cache: 'no-store',
            signal: controller.signal,
          })
          if (!response.ok || !response.body) {
            const answer = await readResult(response)
            deliver({
              kind: 'error',
              error: answer.ok
                ? { code: 'chat_failed', message: 'The chat request failed.' }
                : answer.error,
            })
            return
          }
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let finished = false
          while (!finished && !closed) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const split = splitFrames(buffer)
            buffer = split.rest
            for (const frame of split.frames) {
              if (!frame.startsWith('data: ')) continue
              let item: unknown
              try {
                item = JSON.parse(frame.slice(6))
              } catch {
                continue
              }
              if (!isItem(item)) continue
              deliver(item)
              if (item.kind !== 'event') {
                finished = true
                break
              }
            }
          }
          if (!finished) deliver(cut)
        } catch {
          deliver(cut)
        }
      }
      void run()
      return () => {
        closed = true
        controller.abort()
      }
    },
  }
}
