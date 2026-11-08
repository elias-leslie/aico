// The owner page uses the same authority and read-copy rules as agents.

import { contextDbPath, loadPolicy, openContext } from '@aico/context'
import {
  LoginError,
  type LoginKind,
  labIdentity,
  labPayload,
  loginMachine,
  loginPolicy,
} from '@aico/fleet/logins'
import { LoginClient } from '@aico/fleet/logins-client'
import type { TetherClient } from '@aico/tether-client'
import { objectBody, type Router, requiredString } from './http'
import { HttpError } from './tether'

export function registerLoginRoutes(
  router: Router,
  env = process.env,
  tether?: TetherClient,
  dataDir?: string,
) {
  const owner = { owner: true, role: 'owner', machine: loginMachine() }
  const safe =
    <T>(fn: (client: LoginClient) => T | Promise<T>) =>
    async () => {
      try {
        return await fn(new LoginClient(env))
      } catch (error) {
        throw new HttpError(
          error instanceof LoginError ? 400 : 503,
          error instanceof LoginError ? error.message : 'Logins could not complete the operation.',
        )
      }
    }
  router.on(
    'GET',
    '/api/logins',
    safe(async (client) => {
      const entries = await client.list(owner),
        warning = client.warning,
        readOnly = client.offline
      const assignments = await client.assignments(owner)
      return {
        entries,
        machine: loginMachine(),
        assignments,
        revealSeconds: loginPolicy.revealSeconds,
        warning: warning || client.warning,
        readOnly: readOnly || client.offline,
      }
    }),
  )
  // The work roles Aico registers (the launch policy's list), so the page offers real names to tick.
  router.on('GET', '/api/logins/roles', () => {
    if (!dataDir) return { roles: [] as string[] }
    const db = openContext(contextDbPath(dataDir))
    try {
      return { roles: loadPolicy(db)?.workRoles ?? [] }
    } finally {
      db.close()
    }
  })
  router.on(
    'GET',
    '/api/logins/audit',
    safe(async (client) => ({ events: await client.audit(owner) })),
  )
  router.on(
    'GET',
    '/api/logins/sessions',
    safe(async () => ({
      sessions: ((await tether?.listSessions()) || []).map((s) => ({
        id: s.id,
        label: s.displayTitle || s.label || s.id,
      })),
    })),
  )
  router.on('POST', '/api/logins/assign', (ctx) =>
    safe(async (client) => {
      const body = objectBody(await ctx.body())
      if (!Array.isArray(body.targets) || body.targets.some((t) => typeof t !== 'string'))
        throw new LoginError('Choose lab targets')
      const session = requiredString(body, 'session')
      if (tether && !(await tether.listSessions()).some((s) => s.id === session))
        throw new LoginError('Choose a current session')
      await client.assign(session, body.targets as string[], owner)
      return { saved: true, warning: client.warning }
    })(),
  )
  router.on('POST', '/api/logins', (ctx) =>
    safe(async (client) => {
      const body = objectBody(await ctx.body())
      const entry = await client.set(
        requiredString(body, 'name'),
        requiredString(body, 'value'),
        { kind: body.kind as LoginKind, notes: typeof body.notes === 'string' ? body.notes : '' },
        owner,
      )
      return { entry, warning: client.warning }
    })(),
  )
  router.on('POST', '/api/logins/lab', (ctx) =>
    safe(async (client) => {
      const body = objectBody(await ctx.body()),
        target = requiredString(body, 'target'),
        actor = requiredString(body, 'actor')
      const p = labPayload(
        JSON.stringify({
          schema_version: 1,
          reference: labIdentity(target, actor).reference,
          kind: body.kind || 'account',
          expires_at: body.expires_at || null,
          values: body.values,
        }),
        target,
        actor,
      )
      const entry = await client.set(
        labIdentity(target, actor).name,
        JSON.stringify(p),
        {
          kind: 'lab login',
          notes: typeof body.notes === 'string' ? body.notes : '',
          lab: {
            target,
            actor,
            kind: p.kind,
            expires_at: p.expires_at,
            fields: Object.keys(p.values),
          },
        },
        owner,
        body.replace === true,
      )
      return { entry, warning: client.warning }
    })(),
  )
  router.on('POST', '/api/logins/:name/replace', (ctx) =>
    safe(async (client) => {
      const body = objectBody(await ctx.body())
      const entry = await client.set(
        ctx.params.name,
        requiredString(body, 'value'),
        {},
        owner,
        true,
      )
      return { entry, warning: client.warning }
    })(),
  )
  router.on('PATCH', '/api/logins/lab/:target/:actor', (ctx) =>
    safe(async (client) => {
      const body = objectBody(await ctx.body())
      if (
        body.set !== undefined &&
        (!body.set || typeof body.set !== 'object' || Array.isArray(body.set))
      )
        throw new LoginError('Invalid lab fields')
      if (
        body.remove !== undefined &&
        (!Array.isArray(body.remove) || body.remove.some((name) => typeof name !== 'string'))
      )
        throw new LoginError('Invalid fields to remove')
      if (
        body.expires_at !== undefined &&
        body.expires_at !== null &&
        typeof body.expires_at !== 'string'
      )
        throw new LoginError('Invalid lab login expiry')
      const entry = await client.patchLab(
        ctx.params.target,
        ctx.params.actor,
        {
          set: body.set as Record<string, string> | undefined,
          remove: body.remove as string[] | undefined,
          expires_at: body.expires_at as string | null | undefined,
        },
        owner,
      )
      return { entry, warning: client.warning }
    })(),
  )
  router.on('POST', '/api/logins/:name/reveal', (ctx) =>
    safe(async (client) => ({
      value: (await client.value(ctx.params.name, owner, 'reveal')).toString(),
      hideAfter: loginPolicy.revealSeconds,
    }))(),
  )
  router.on('POST', '/api/logins/:name/grants', (ctx) =>
    safe(async (client) => {
      const body = objectBody(await ctx.body())
      if ((body.type !== 'machine' && body.type !== 'role') || typeof body.granted !== 'boolean')
        throw new LoginError('Choose a machine or role grant')
      const entry = await client.grant(
        ctx.params.name,
        body.type,
        requiredString(body, 'value'),
        body.granted,
        owner,
      )
      return { entry, warning: client.warning }
    })(),
  )
  router.on('POST', '/api/logins/:name/remove', (ctx) =>
    safe(async (client) => {
      const body = objectBody(await ctx.body())
      await client.remove(ctx.params.name, owner, body.confirm === ctx.params.name)
      return { removed: true, warning: client.warning }
    })(),
  )
}
