// The Hosts sheet's API: each remote host's state, power and per-tool sign-in.
// Tether's hub does the work (docs/api-v1.md "Remote hosts"); these routes pass
// it through and keep Tether's own reason as the detail the app shows.

import {
  hostLogins,
  hostPower,
  hostSignIn,
  type TetherClient,
  TetherError,
  trustHost,
} from 'tether/client'
import { objectBody, type Router } from './http'
import { tetherCall } from './lifecycle'
import { fromTether } from './sessions'
import { HttpError, WEB_ORIGIN } from './tether'

/** A hosts.json host name, as Tether names it. */
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TOOL = /^[a-z0-9][a-z0-9-]{0,39}$/
/** Power on answers at once; sign-in may wait for the host to come up. */
const SIGN_IN_TIMEOUT_MS = 300_000

function hostName(value: string): string {
  if (!HOST_NAME.test(value)) throw new HttpError(422, 'Unknown host')
  return value
}

/** Tether's plain-words reason, kept as the detail; its status stays. */
async function hostCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof TetherError && error.reason) {
      const status = error.status >= 500 || error.status === 0 ? 502 : error.status
      throw new HttpError(status, error.reason, error)
    }
    return tetherCall(() => Promise.reject(error))
  }
}

export function registerHostRoutes(router: Router, tether: TetherClient) {
  // The remote hosts ("This computer" is implied), with their link state, the
  // sessions running there, and a start in progress or its failure.
  router.on('GET', '/api/hosts', async () => {
    const hosts = await tetherCall(() => tether.hosts())
    return {
      items: hosts.map((host) => ({
        name: host.name,
        state: host.state,
        since: host.since ?? null,
        sessions: host.sessions ?? 0,
        error: host.error ?? null,
        wake: host.wake ?? null,
      })),
    }
  })

  router.on('GET', '/api/hosts/:host/logins', async (ctx) => {
    const host = hostName(ctx.params.host)
    return hostCall(() => hostLogins(tether, host))
  })

  router.on('POST', '/api/hosts/:host/power', async (ctx) => {
    const host = hostName(ctx.params.host)
    const body = objectBody(await ctx.body())
    if (body.action !== 'on' && body.action !== 'off')
      throw new HttpError(400, 'action must be on or off')
    return hostCall(() => hostPower(tether, host, body.action as 'on' | 'off', body.force === true))
  })

  router.on('POST', '/api/hosts/:host/trust', async (ctx) => {
    const host = hostName(ctx.params.host)
    await hostCall(() => trustHost(tether, host))
    return { trusted: true }
  })

  // Sign in or out of one tool there. A sign-in (and a sign-out done inside the
  // tool) answers with the session it opened on the host.
  router.on('POST', '/api/hosts/:host/logins/:tool', async (ctx) => {
    const host = hostName(ctx.params.host)
    const tool = ctx.params.tool
    if (!TOOL.test(tool)) throw new HttpError(422, 'Unknown tool')
    const body = objectBody(await ctx.body())
    if (body.action !== 'sign_in' && body.action !== 'sign_out')
      throw new HttpError(400, 'action must be sign_in or sign_out')
    const answer = await hostCall(() =>
      hostSignIn(tether, host, tool, body.action as 'sign_in' | 'sign_out', {
        origin: WEB_ORIGIN,
        timeoutMs: SIGN_IN_TIMEOUT_MS,
      }),
    )
    return answer.session ? { ...answer, session: fromTether(answer.session, null) } : answer
  })
}
