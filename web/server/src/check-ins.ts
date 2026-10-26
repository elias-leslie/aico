// Check-ins (Tether's scheduled wakes) for the web app: the session menu's
// choices and pending list, setting and cancelling one, and the ones kept past
// an End. Tether owns the schedule; these routes only word it for the UI.

import {
  OWNER_CHECK_IN_NOTE,
  type TetherClient,
  TetherError,
  wakeChoices,
  wakeClock,
} from 'tether/client'
import { objectBody, optionalInt, type Router } from './http'
import { type Lifecycle, tetherCall } from './lifecycle'
import { HttpError, toHttpError } from './tether'

const WAKE_ID = /^[0-9a-f]{12}$/

export function registerCheckInRoutes(router: Router, life: Lifecycle, tether: TetherClient) {
  router.on('GET', '/api/sessions/:sessionId/check-ins', async (ctx) => {
    const session = await life.getSession(ctx.params.sessionId)
    const { items, policy } = await tetherCall(
      () => tether.sessionWakes(session.id),
      `Session ${session.id} not found`,
    )
    const now = Date.now()
    return {
      // Tether can only tell when Claude Code or Codex is idle.
      status: session.activity === 'unknown' ? 'unsupported' : 'ready',
      choices: wakeChoices(policy, now).map((choice) => ({
        label: choice.label,
        time: wakeClock(choice.dueAt, now),
        dueAt: choice.dueAt,
      })),
      pending: items.map((wake) => ({
        id: wake.id,
        time: wakeClock(wake.dueAt, now),
        dueAt: wake.dueAt,
      })),
    }
  })

  router.on('POST', '/api/sessions/:sessionId/check-ins', async (ctx) => {
    const session = await life.getSession(ctx.params.sessionId)
    const dueAt = optionalInt(objectBody(await ctx.body()), 'dueAt')
    if (dueAt === undefined) throw new HttpError(422, 'dueAt is required')
    try {
      const wake = await tether.addWake(session.id, {
        dueAt,
        note: OWNER_CHECK_IN_NOTE,
        createdBy: 'owner',
      })
      return { id: wake.id, dueAt: wake.dueAt, time: wakeClock(wake.dueAt) }
    } catch (error) {
      if (error instanceof TetherError && error.code === 'invalid_body')
        throw new HttpError(400, 'Pick a time from now to a year ahead', error)
      throw toHttpError(error, `Session ${session.id} not found`)
    }
  })

  // Only a wake Tether lists can be cancelled from here.
  router.on('DELETE', '/api/check-ins/:wakeId', async (ctx) => {
    const wakeId = ctx.params.wakeId
    if (!WAKE_ID.test(wakeId)) throw new HttpError(404, 'Check-in not found')
    const { items } = await tetherCall(() => tether.wakes())
    if (!items.some((wake) => wake.id === wakeId)) throw new HttpError(404, 'Check-in not found')
    try {
      await tether.cancelWake(wakeId)
    } catch (error) {
      // Already gone (it fired or was cancelled elsewhere): the goal is met.
      if (!(error instanceof TetherError && error.code === 'not_found')) throw toHttpError(error)
    }
    return { deleted: true, id: wakeId }
  })

  // Check-ins of ended sessions: they start a new session when due.
  router.on('GET', '/api/check-ins/kept', async () => {
    const { items } = await tetherCall(() => tether.wakes())
    const kept = items.filter((wake) => wake.sessionId === null)
    // Project names for the titles; the ids read fine if Tether will not list them.
    const projects = kept.length
      ? new Map(
          (await tether.projects().catch(() => [])).map((project) => [project.id, project.name]),
        )
      : new Map<string, string | undefined>()
    const now = Date.now()
    return {
      items: kept.map((wake) => {
        const ended = wake.endedSession
        const name = ended?.name?.trim()
        const project = ended?.projectId ? (projects.get(ended.projectId) ?? ended.projectId) : null
        return {
          id: wake.id,
          dueAt: wake.dueAt,
          time: wakeClock(wake.dueAt, now),
          // `Project — Task`, as session titles read.
          session: [project, name].filter(Boolean).join(' — ') || ended?.tool || 'Ended session',
          failed: wake.lastError !== null,
        }
      }),
    }
  })
}
