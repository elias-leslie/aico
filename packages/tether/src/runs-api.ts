// `/v1/runs`: the workflow runs Tether follows (src/agent-hub/runs.ts), and
// the owner's controls on them. Tether only controls a run it lists, which is
// one a session of this machine launched.

import type { IdleEvent, Session, TurnEvent } from '@agent-hub/sdk'
import { guarded, parseAfterSeq, streamTurn } from './agent-hub/chat-api'
import { RunControlError, type RunTracker, type StepSession } from './agent-hub/runs'
import { classifyHubError } from './agent-hub/runtime'
import { HttpError, type Router, readJsonObject, sendJson } from './http'
import type { Hub } from './hub/hub'

/** What Tether asks Agent Hub to read a step's attempt session. */
export interface StepChatSource {
  session(sessionId: string): Promise<Session>
  attach(
    sessionId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): AsyncGenerator<TurnEvent | IdleEvent, void, undefined>
}

/** `GET /v1/runs/:id/steps/:key/chat/info`: who the attempt session is, for the chat window. */
export type StepChatInfo = Pick<
  StepSession,
  'sessionId' | 'agentSlug' | 'requestedModel' | 'attempt'
>

const STEP_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/
const DECISIONS = new Set(['retry', 'skip', 'fail'])

/** Tether's refusal or Agent Hub's, as an HTTP error. */
function failure(error: unknown): never {
  if (error instanceof HttpError) throw error
  if (error instanceof RunControlError) {
    throw new HttpError(error.code === 'not_allowed' ? 409 : 404, error.code, {
      reason: error.message,
    })
  }
  const hub = classifyHubError(error)
  if (hub.code === 'agent_hub_unavailable') throw new HttpError(503, hub.code)
  throw new HttpError(409, hub.code, { reason: hub.message })
}

export function registerRunRoutes(
  router: Router,
  tracker: RunTracker,
  chats?: StepChatSource | null,
  /** Merges the remote hosts' runs into the list. */
  hub?: Pick<Hub, 'mergeRuns'> | null,
): void {
  const runId = (value: string | undefined): string => {
    if (!value || value.length > 80) throw new HttpError(404, 'unknown_run')
    return value
  }
  const run = async (work: () => Promise<unknown> | unknown): Promise<{ ok: true }> => {
    try {
      await work()
      return { ok: true }
    } catch (error) {
      return failure(error)
    }
  }
  const attemptOf = (
    params: Record<string, string | undefined>,
    query?: URLSearchParams,
  ): StepSession => {
    const key = params.key ?? ''
    if (!STEP_KEY.test(key)) throw new HttpError(404, 'unknown_step')
    const session = query?.get('session') || undefined
    if (session !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(session))
      throw new HttpError(404, 'no_session')
    try {
      return tracker.stepSession(runId(params.id), key, session)
    } catch (error) {
      return failure(error)
    }
  }
  const chatSource = (): StepChatSource => {
    if (!chats) throw new HttpError(503, 'agent_hub_unavailable')
    return chats
  }
  router
    .add('GET', '/v1/runs', (_req, res) => {
      const local = tracker.snapshot()
      sendJson(res, 200, hub ? hub.mergeRuns(local) : local)
    })
    .add('POST', '/v1/runs/:id/resume', async (req, res, params) => {
      const body = await readJsonObject(req)
      const unknown = Object.keys(body).filter((key) => key !== 'action' && key !== 'stepKey')
      if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
      const action = body.action
      if (typeof action !== 'string' || !DECISIONS.has(action))
        throw new HttpError(400, 'invalid_body', { field: 'action' })
      const stepKey = body.stepKey ?? null
      if (stepKey !== null && (typeof stepKey !== 'string' || !STEP_KEY.test(stepKey)))
        throw new HttpError(400, 'invalid_body', { field: 'stepKey' })
      sendJson(
        res,
        200,
        await run(() =>
          tracker.resume(
            runId(params.id),
            stepKey as string | null,
            action as 'retry' | 'skip' | 'fail',
          ),
        ),
      )
    })
    .add('POST', '/v1/runs/:id/cancel', async (_req, res, params) => {
      sendJson(res, 200, await run(() => tracker.cancel(runId(params.id), null)))
    })
    .add('POST', '/v1/runs/:id/steps/:key/cancel', async (_req, res, params) => {
      const key = params.key ?? ''
      if (!STEP_KEY.test(key)) throw new HttpError(404, 'unknown_step')
      sendJson(res, 200, await run(() => tracker.cancel(runId(params.id), key)))
    })
    // A step's latest attempt, read-only: only for a step of a run listed here.
    .add('GET', '/v1/runs/:id/steps/:key/chat/info', (_req, res, params) => {
      const { sessionId, agentSlug, requestedModel, attempt } = attemptOf(params)
      const info: StepChatInfo = { sessionId, agentSlug, requestedModel, attempt }
      sendJson(res, 200, info)
    })
    .add('GET', '/v1/runs/:id/steps/:key/chat', async (_req, res, params, query) => {
      const source = chatSource()
      const attempt = attemptOf(params, query)
      const session = await guarded(() => source.session(attempt.sessionId))
      sendJson(res, 200, { session, queued: [] as string[] })
    })
    .add('GET', '/v1/runs/:id/steps/:key/chat/stream', async (req, res, params, query) => {
      const source = chatSource()
      const attempt = attemptOf(params, query)
      const afterSeq = parseAfterSeq(query)
      await guarded(() =>
        streamTurn((signal) => source.attach(attempt.sessionId, afterSeq, signal), req, res),
      )
    })
    .add('POST', '/v1/runs/:id/dismiss', async (_req, res, params) => {
      sendJson(res, 200, await run(() => tracker.dismiss(runId(params.id))))
    })
}
