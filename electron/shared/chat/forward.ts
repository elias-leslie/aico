// The owner-side half of an Agent Hub chat, shared by the desktop's main
// process and the web server: given the session (or workflow step) a view
// shows, it forwards the view's requests to Tether over its private socket
// and turns Tether's stream into chat stream items.
//
// Why Tether and not the view: Tether is the one process that reads the owner
// token (per request, from its file) and knows a session's Agent Hub id and
// follow-up queue. Nothing here sees the token, an Agent Hub address or the
// Agent Hub id of a session the view was not opened on.

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  type SessionDescriptor,
  type TetherClient,
  TetherError,
  TetherUnavailable,
} from 'tether/client'
import type { ChatCallResult, ChatFailure, ChatInfo, ChatStreamItem } from './types'

/** A follow-up is typed text; this is the same bound Tether's inject route holds. */
export const MAX_CHAT_TEXT = 60_000
/** Tether's bound on a model id. */
const MAX_MODEL_ID = 128
/** A thinking level is one lowercase word (Tether holds the same shape). */
const THINKING_LEVEL = /^[a-z]{1,16}$/
export const CHAT_METHODS: ReadonlySet<string> = new Set([
  'session',
  'queue',
  'send',
  'cancel',
  'models',
])

export type ChatTether = Pick<TetherClient, 'request' | 'stream'>

/** A refusal in the chat's own words (not Tether's). */
export class ChatRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The words the owner sees for a failure; never a token, address or stack. */
export function failure(error: unknown): ChatFailure {
  if (error instanceof TetherError) {
    const agentHubDown = error.code === 'agent_hub_unavailable'
    return {
      code: error.code,
      status: error.status,
      message: agentHubDown
        ? 'Agent Hub is not reachable.'
        : error.code === 'stale_generation' || error.code === 'identity_changed'
          ? 'This session changed. Reopen the window.'
          : error.code === 'workload_unavailable'
            ? // Agent Hub's own reason for a refused message (a folder it will not work in).
              error.reason
              ? `Agent Hub refused: ${error.reason}`
              : 'This session is not ready yet.'
            : error.code === 'unknown_model'
              ? 'Agent Hub cannot use that model. Pick another.'
              : `Aico's session service refused the request (${error.code}).`,
    }
  }
  if (error instanceof TetherUnavailable)
    return { code: 'tether_unavailable', message: "Aico's session service is not reachable." }
  if (error instanceof ChatRefusal) return { code: error.code, message: error.message }
  return { code: 'chat_failed', message: 'The chat request failed.' }
}

/**
 * The branch a project folder has checked out, read from its git files (also in a linked worktree, where `.git`
 * is a file pointing at the real directory). Null when it is not a repository or HEAD is detached.
 */
export function gitBranch(root: string | null | undefined): string | null {
  if (!root) return null
  try {
    let gitDir = join(root, '.git')
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim()
      if (!pointer) return null
      gitDir = isAbsolute(pointer) ? pointer : resolve(root, pointer)
    }
    const head = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, 'HEAD'), 'utf8'))
    return head?.[1]?.trim() || null
  } catch {
    return null
  }
}

/** What a view reads: its own session, or a step's attempt (no input). */
export type ChatTarget =
  | { kind: 'session'; descriptor: SessionDescriptor; info: ChatInfo }
  | { kind: 'step'; runId: string; stepKey: string; info: ChatInfo }

/** The target of an Agent Hub session, or null when the descriptor is not one. */
export function sessionTarget(
  descriptor: SessionDescriptor,
  branch: string | null,
): ChatTarget | null {
  if (descriptor.backend !== 'agent-hub' || !descriptor.agentHub) return null
  return {
    kind: 'session',
    descriptor,
    info: {
      sessionId: descriptor.agentHub.sessionId,
      agentSlug: descriptor.agentHub.agentSlug,
      requestedModel: descriptor.agentHub.requestedModel,
      answeredModel: descriptor.agentHub.model,
      ...(branch ? { branch } : {}),
    },
  }
}

/** The attempt session of a step, as Tether names it for the read-only view. */
interface StepAttempt {
  sessionId: string
  agentSlug: string
  requestedModel: string | null
}

export const stepPath = (runId: string, stepKey: string, tail: string, session: string): string =>
  `/v1/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepKey)}/chat${tail}` +
  (tail === '/info'
    ? ''
    : `${tail.includes('?') ? '&' : '?'}session=${encodeURIComponent(session)}`)

/** A step's latest attempt (or the given one) as a read-only target; throws Tether's failure. */
export async function stepTarget(
  tether: ChatTether,
  runId: string,
  stepKey: string,
): Promise<ChatTarget> {
  const { body } = await tether.request<StepAttempt & { attempt: number | null }>(
    'GET',
    stepPath(runId, stepKey, '/info', ''),
  )
  return {
    kind: 'step',
    runId,
    stepKey,
    info: {
      sessionId: body.sessionId,
      agentSlug: body.agentSlug,
      requestedModel: body.requestedModel,
      readOnly: true,
    },
  }
}

function sessionPath(descriptor: SessionDescriptor, tail = ''): string {
  return `/v1/sessions/${encodeURIComponent(descriptor.id)}/chat${tail}`
}

/**
 * One request of the chat view, answered through Tether. `current` is the
 * session's newest descriptor (its generation moves); a step target ignores it.
 */
export async function chatCall(
  tether: ChatTether,
  target: ChatTarget,
  current: SessionDescriptor | null,
  method: unknown,
  args: unknown,
): Promise<ChatCallResult> {
  try {
    if (typeof method !== 'string' || !CHAT_METHODS.has(method))
      throw new ChatRefusal('unknown_method', 'Unknown chat request.')
    const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    if (method === 'models') {
      const { body } = await tether.request<{ items: unknown }>('GET', '/v1/chat/models')
      return { ok: true, value: body.items }
    }
    if (input.sessionId !== target.info.sessionId)
      throw new ChatRefusal('session_mismatch', 'That is not this view’s session.')
    if (target.kind === 'step') {
      // A step's attempt is read, never written: no message, no stop.
      if (method === 'send' || method === 'cancel')
        throw new ChatRefusal('read_only', 'This view is read-only.')
      if (method === 'queue') return { ok: true, value: [] }
      const { body } = await tether.request<{ session: unknown }>(
        'GET',
        stepPath(target.runId, target.stepKey, '', target.info.sessionId),
        undefined,
        { timeoutMs: 20_000 },
      )
      return { ok: true, value: body.session }
    }
    if (method === 'session' || method === 'queue') {
      const { body } = await tether.request<{ session: unknown; queued: string[] }>(
        'GET',
        sessionPath(
          target.descriptor,
          method === 'queue' || input.includeMessages === false ? '?messages=false' : '',
        ),
        undefined,
        { timeoutMs: 20_000 },
      )
      return { ok: true, value: method === 'queue' ? body.queued : body.session }
    }
    const now = current ?? target.descriptor
    if (method === 'send') {
      const text = input.text
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_CHAT_TEXT)
        throw new ChatRefusal('invalid_text', 'That message cannot be sent.')
      // The model chosen for this message: an id, or null (or empty) for the agent's own
      // routing. A call that names none leaves the session's model alone.
      const model = input.model
      if (
        model !== undefined &&
        model !== null &&
        (typeof model !== 'string' || model.length > MAX_MODEL_ID)
      )
        throw new ChatRefusal('invalid_model', 'That model cannot be used.')
      // The effort for this message: a level word, or null (or empty) for the model's own default.
      const level = input.thinkingLevel
      if (
        level !== undefined &&
        level !== null &&
        level !== '' &&
        (typeof level !== 'string' || !THINKING_LEVEL.test(level))
      )
        throw new ChatRefusal('invalid_effort', 'That effort cannot be used.')
      const { body } = await tether.request<{ queued?: boolean }>(
        'POST',
        `/v1/sessions/${encodeURIComponent(now.id)}/inject`,
        {
          generation: now.generation,
          text,
          mode: 'paste',
          submit: true,
          ...(model === undefined ? {} : { model: model || null }),
          ...(level === undefined ? {} : { thinkingLevel: level || null }),
        },
        { timeoutMs: 45_000 },
      )
      return { ok: true, value: { queued: body.queued === true } }
    }
    const { body } = await tether.request<{ cancelled?: boolean; restored?: unknown }>(
      'POST',
      sessionPath(now, '/cancel'),
      { generation: now.generation },
      { timeoutMs: 20_000 },
    )
    const restored = Array.isArray(body.restored)
      ? body.restored.filter((text): text is string => typeof text === 'string')
      : []
    return { ok: true, value: { cancelled: body.cancelled === true, restored } }
  } catch (error) {
    return { ok: false, error: failure(error) }
  }
}

/** The afterSeq a view may ask for: a positive safe integer, else from the start. */
export function afterSeqOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Follow a target's running turn from `afterSeq`, handing each event to `push`.
 * Resolves after the last item (`end` or `error`) is pushed, or when `signal`
 * aborts; a heartbeat goes to `onHeartbeat`, not to `push`.
 */
export function followChat(
  tether: ChatTether,
  target: ChatTarget,
  afterSeq: number,
  signal: AbortSignal,
  push: (item: ChatStreamItem) => void,
  onHeartbeat?: () => void,
): Promise<void> {
  const path =
    target.kind === 'step'
      ? `${stepPath(target.runId, target.stepKey, '/stream', target.info.sessionId)}&afterSeq=${afterSeq}`
      : `${sessionPath(target.descriptor, '/stream')}?afterSeq=${afterSeq}`
  let ended = false
  return tether
    .stream(
      path,
      {},
      (line) => {
        const item = line as Record<string, unknown> | null
        if (!item || typeof item.type !== 'string') return
        if (item.type === 'heartbeat') {
          onHeartbeat?.()
          return
        }
        if (item.type === 'stream_error') {
          ended = true
          push({
            kind: 'error',
            error: {
              code: typeof item.code === 'string' ? item.code : 'stream_interrupted',
              message: 'The connection to the running turn was lost.',
            },
          })
          return
        }
        push({ kind: 'event', event: item })
      },
      signal,
    )
    .then(
      () => {
        if (!ended) push({ kind: 'end' })
      },
      (error: unknown) => push({ kind: 'error', error: failure(error) }),
    )
}
