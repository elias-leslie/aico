// Workflow runs for the web app: the runs Tether follows for the sessions
// here, and the owner's answers to them. Tether owns the runs and holds the
// Agent Hub credentials; these routes only pass its answers on and word its
// refusals for the UI.

import { DECISIONS, type TetherClient } from 'tether/client'
import { objectBody, optionalString, type Router } from './http'
import { tetherCall } from './lifecycle'
import { HttpError } from './tether'

const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/
const STEP_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/

function runId(raw: string): string {
  if (!RUN_ID.test(raw)) throw new HttpError(404, 'Run not found')
  return raw
}

export function registerRunRoutes(router: Router, tether: TetherClient) {
  // The runs and steps to show, with whether Agent Hub could be read.
  router.on('GET', '/api/runs', () => tetherCall(() => tether.runs()))

  // Retry, skip or fail a step waiting on the owner (no step: the run itself).
  router.on('POST', '/api/runs/:runId/resume', async (ctx) => {
    const id = runId(ctx.params.runId)
    const body = objectBody(await ctx.body())
    const action = optionalString(body, 'action', { max: 16 })
    if (!action || !(DECISIONS as readonly string[]).includes(action))
      throw new HttpError(422, 'action must be retry, skip or fail')
    const stepKey = optionalString(body, 'stepKey', { max: 128, pattern: STEP_KEY }) || null
    await tetherCall(
      () => tether.resumeRun(id, action as (typeof DECISIONS)[number], stepKey),
      'Run not found',
    )
    return { ok: true }
  })

  // Stop a run, or one step of it.
  router.on('POST', '/api/runs/:runId/cancel', async (ctx) => {
    const id = runId(ctx.params.runId)
    const body = objectBody(await ctx.body())
    const stepKey = optionalString(body, 'stepKey', { max: 128, pattern: STEP_KEY }) || null
    await tetherCall(() => tether.cancelRun(id, stepKey), 'Run not found')
    return { ok: true }
  })

  // Drop an ended run from the list.
  router.on('POST', '/api/runs/:runId/dismiss', async (ctx) => {
    const id = runId(ctx.params.runId)
    await tetherCall(() => tether.dismissRun(id), 'Run not found')
    return { ok: true }
  })
}
