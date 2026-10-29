// Agent Hub chat for the web app: the same operations the desktop's main process
// answers over IPC (electron/main/chat-bridge.ts), here over HTTP. Both forward
// to Tether through electron/shared/chat/forward.ts; Tether holds the Agent Hub
// owner token and nothing here sees it, so it never reaches the browser.
//
//   POST /api/chat/info    {session} or {run, step}          -> {ok, value: ChatInfo}
//   POST /api/chat/call    {session | run, step, attempt?, method, args}
//                                                             -> {ok, value} | {ok: false, error}
//   GET  /api/chat/stream?session=ID | run=ID&step=KEY[&attempt=ID][&afterSeq=N]
//                                  -> text/event-stream; each `data:` is a ChatStreamItem
//
// A request names the Tether session (or the run and step) the view shows, the
// way an Electron window is bound to its own. The guard (guard.ts) has already
// refused foreign hosts and, for POST, foreign origins before a route runs.

import type { TetherClient } from 'tether/client'
import {
  afterSeqOf,
  ChatRefusal,
  type ChatTarget,
  chatCall,
  failure,
  followChat,
  gitBranch,
  sessionTarget,
  stepTarget,
} from '../../../electron/shared/chat/forward'
import type { ChatCallResult, ChatFailure } from '../../../electron/shared/chat/types'
import { API_CSP } from './guard'
import { objectBody, RAW, type Router, sendJson } from './http'
import { findSession } from './tether'

/** Chat streams open at once, over every browser tab. */
export const MAX_CHAT_STREAMS = 24

const ID = /^[A-Za-z0-9_-]{1,80}$/
const STEP_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The HTTP status for a failure that carries none of Tether's own. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  tether_unavailable: 503,
  agent_hub_unavailable: 503,
  not_found: 404,
  not_a_chat: 409,
  read_only: 403,
  session_mismatch: 409,
  unknown_method: 400,
  invalid_text: 400,
  invalid_model: 400,
  invalid_target: 400,
  too_many_streams: 429,
}

function statusOf(error: ChatFailure): number {
  if (error.status !== undefined && error.status >= 400 && error.status < 600) return error.status
  return STATUS_BY_CODE[error.code] ?? 502
}

function refuse(res: Parameters<typeof sendJson>[0], error: ChatFailure): void {
  const answer: ChatCallResult = { ok: false, error }
  sendJson(res, statusOf(error), answer)
}

/** What a request names: a Tether session, or a workflow step (and the attempt to stay on). */
type Named =
  | { kind: 'session'; id: string }
  | { kind: 'step'; run: string; step: string; attempt: string | null }

function named(source: (key: string) => unknown): Named {
  const text = (key: string): string | null => {
    const value = source(key)
    return typeof value === 'string' && value ? value : null
  }
  const session = text('session')
  const run = text('run')
  const step = text('step')
  const attempt = text('attempt')
  if (session && !run && !step) {
    if (!ID.test(session)) throw new ChatRefusal('invalid_target', 'That session cannot be opened.')
    return { kind: 'session', id: session }
  }
  if (run && step && !session) {
    if (!ID.test(run) || !STEP_KEY.test(step) || (attempt !== null && !ID.test(attempt)))
      throw new ChatRefusal('invalid_target', 'That step cannot be opened.')
    return { kind: 'step', run, step, attempt }
  }
  throw new ChatRefusal('invalid_target', 'Name a session, or a run and its step.')
}

async function resolve(
  tether: TetherClient,
  name: Named,
): Promise<{ target: ChatTarget; current: Awaited<ReturnType<typeof findSession>> }> {
  if (name.kind === 'step') {
    // A retry makes a new attempt; a view stays on the one it opened with.
    const target = name.attempt
      ? ({
          kind: 'step',
          runId: name.run,
          stepKey: name.step,
          info: { sessionId: name.attempt, agentSlug: '', requestedModel: null, readOnly: true },
        } satisfies ChatTarget)
      : await stepTarget(tether, name.run, name.step)
    return { target, current: null }
  }
  const descriptor = await findSession(tether, name.id)
  if (!descriptor) throw new ChatRefusal('not_found', 'That session is no longer listed.')
  const target = sessionTarget(descriptor, gitBranch(descriptor.projectRoot))
  if (!target) throw new ChatRefusal('not_a_chat', 'This session is not an Agent Hub chat.')
  return { target, current: descriptor }
}

export function registerChatRoutes(router: Router, tether: TetherClient): void {
  let streams = 0

  router.on('POST', '/api/chat/info', async (ctx) => {
    const body = objectBody(await ctx.body())
    try {
      const { target } = await resolve(
        tether,
        named((key) => body[key]),
      )
      const answer: ChatCallResult = { ok: true, value: target.info }
      return answer
    } catch (error) {
      refuse(ctx.res, failure(error))
      return RAW
    }
  })

  router.on('POST', '/api/chat/call', async (ctx) => {
    const body = objectBody(await ctx.body())
    let answer: ChatCallResult
    try {
      const { target, current } = await resolve(
        tether,
        named((key) => body[key]),
      )
      answer = await chatCall(tether, target, current, body.method, body.args)
    } catch (error) {
      answer = { ok: false, error: failure(error) }
    }
    if (answer.ok) return answer
    refuse(ctx.res, answer.error)
    return RAW
  })

  router.on('GET', '/api/chat/stream', async (ctx) => {
    const { res } = ctx
    if (streams >= MAX_CHAT_STREAMS) {
      refuse(res, { code: 'too_many_streams', message: 'Too many chat streams are open.' })
      return RAW
    }
    let target: ChatTarget
    try {
      const rawAfter = ctx.query.get('afterSeq')
      if (rawAfter !== null && !/^\d{1,15}$/.test(rawAfter))
        throw new ChatRefusal('invalid_target', 'That stream position cannot be used.')
      target = (
        await resolve(
          tether,
          named((key) => ctx.query.get(key)),
        )
      ).target
      streams += 1
      const controller = new AbortController()
      const stop = () => controller.abort()
      res.once('close', stop)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'Content-Security-Policy': API_CSP,
        // Keep a buffering proxy from holding the events back.
        'X-Accel-Buffering': 'no',
      })
      // The headers go out now, so the browser's fetch settles before the first event.
      res.write(': open\n\n')
      const send = (text: string) => {
        if (!res.destroyed && !res.writableEnded) res.write(text)
      }
      try {
        await followChat(
          tether,
          target,
          afterSeqOf(rawAfter === null ? 0 : Number(rawAfter)),
          controller.signal,
          (item) => send(`data: ${JSON.stringify(item)}\n\n`),
          () => send(': keep-alive\n\n'),
        )
      } finally {
        streams -= 1
        controller.abort()
        if (!res.writableEnded) res.end()
      }
    } catch (error) {
      if (!res.headersSent) refuse(res, failure(error))
      else if (!res.writableEnded) res.end()
    }
    return RAW
  })
}
