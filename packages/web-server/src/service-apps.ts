// App integrations have their own LAN listener. This router is never mounted on
// the browser server: a service token cannot open sessions, run commands or read
// another app's rows, prompts or asks.
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'
import { ask, dataDir } from '@aico/agent'
import { Catalog, contextDbPath, getPrompt, openContext } from '@aico/context'
import { privateFile, secretsDir } from '@aico/fleet/secrets'
import { NoticeError, parseNotice } from '@aico/notify'
import { machineId, parseRow, RowError, type StatusStore } from '@aico/status'
import type { TetherClient } from '@aico/tether-client'
import { count, counterRow, fetchPage, openCounter, searchWeb, today } from '@aico/webtools'
import settings from '../data/service-apps.json' with { type: 'json' }
import { objectBody, RAW, type RequestContext, Router, requiredString, sendJson } from './http'
import { fromLan, type NotifyHub, tetherAsks } from './notify'
import { HttpError } from './tether'

type Profile = { model: string; prompts: string[] }
type App = { machine: string; agents: Record<string, Profile>; prompts: string[] }
type Apps = Record<string, App>
export const SERVICE_APPS: Apps = settings.apps

export interface ServiceAppsDeps {
  status: StatusStore
  notify: Pick<NotifyHub, 'notifier' | 'store' | 'rowsWritten'>
  tether: Pick<TetherClient, 'request'>
  env?: NodeJS.ProcessEnv
  apps?: Apps
  ask?: typeof ask
  prompt?: (slug: string) => string | null
  web?: { search: typeof searchWeb; fetch: typeof fetchPage }
}

/** Hashes live in Aico's owner-only secrets folder; raw tokens stay in the apps. */
export function serviceTokenApp(
  req: IncomingMessage,
  apps: Apps,
  env = process.env,
): string | null {
  if (
    !fromLan(req) ||
    ['origin', 'cf-ray', 'cf-access-jwt-assertion', 'x-forwarded-proto', 'x-real-ip', 'via'].some(
      (name) => req.headers[name] !== undefined,
    )
  )
    return null
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')
  if (!match) return null
  const offered = createHash('sha256')
    .update(match[1] as string)
    .digest()
  for (const app of Object.keys(apps)) {
    try {
      const hash = privateFile(join(secretsDir(env), `service-${app}.sha256`))
        .toString()
        .trim()
      if (/^[0-9a-f]{64}$/.test(hash) && timingSafeEqual(Buffer.from(hash, 'hex'), offered))
        return app
    } catch {
      /* A missing or invalid token file authorizes nobody. */
    }
  }
  return null
}

function ownRow(value: unknown, app: string, machine: string) {
  try {
    const row = parseRow(value)
    if (
      row.project !== app ||
      row.machine !== machine ||
      !row.id.startsWith(`${app}/`) ||
      row.actions?.length
    )
      throw new HttpError(403, 'Write your own project rows, without command actions')
    return row
  } catch (error) {
    if (error instanceof RowError) throw new HttpError(422, `${error.field}: ${error.message}`)
    throw error
  }
}

export function serviceAppsRouter(deps: ServiceAppsDeps): Router {
  const env = deps.env ?? process.env
  const apps = deps.apps ?? SERVICE_APPS
  const router = new Router(settings.max_body_bytes)
  const catalog = new Catalog()
  const asks = tetherAsks(deps.tether)
  const prompt =
    deps.prompt ??
    ((slug: string) => {
      const db = openContext(contextDbPath(dataDir(env)))
      try {
        return getPrompt(db, slug)?.content ?? null
      } finally {
        db.close()
      }
    })
  const on = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, app: string) => unknown,
  ) => {
    router.on(method, path, (ctx) => {
      const app = serviceTokenApp(ctx.req, apps, env)
      if (!app) throw new HttpError(401, 'A LAN app service token is required')
      return handler(ctx, app)
    })
  }
  const readPrompt = (slug: string) => {
    const content = prompt(slug)
    if (!content?.trim()) throw new HttpError(503, `Required Aico prompt '${slug}' is missing`)
    return content
  }
  const ownAsk = async (id: string, app: string) => {
    if (!/^[0-9a-f]{12}$/.test(id)) throw new HttpError(404, 'Ask not found')
    const { body } = await deps.tether.request<Record<string, unknown>>('GET', `/v1/asks/${id}`)
    if (body.requester !== app) throw new HttpError(404, 'Ask not found')
    return body
  }
  on('GET', '/v1/ask/config', (_ctx, app) => {
    const config = apps[app] as App
    return {
      agents: Object.fromEntries(
        Object.entries(config.agents).map(([slug, profile]) => [
          slug,
          {
            ...profile,
            provider: catalog.get(profile.model)?.provider ?? 'unknown',
          },
        ]),
      ),
      prompts: config.prompts,
    }
  })
  on('GET', '/v1/ask/prompts/:slug', (ctx, app) => {
    if (!(apps[app] as App).prompts.includes(ctx.params.slug as string))
      throw new HttpError(404, 'Prompt not found')
    return { content: readPrompt(ctx.params.slug as string) }
  })
  on('POST', '/v1/ask/evidence', async (ctx, app) => {
    const body = objectBody(await ctx.body())
    if (
      Object.keys(body).length !== 1 ||
      !Object.keys(body).every((key) => ['query', 'url'].includes(key))
    )
      throw new HttpError(422, 'Send one public search query or URL')
    const verb = body.query !== undefined ? 'search' : 'fetch'
    const value = requiredString(body, verb === 'search' ? 'query' : 'url', { max: 2000 })
    if (!value.trim()) throw new HttpError(422, 'A query or URL is required')
    const web = deps.web ?? { search: searchWeb, fetch: fetchPage }
    const payload =
      verb === 'search'
        ? await web.search(value, { max: settings.evidence.max_results }, { fetch, env })
        : // The public reader rejects private and credential-bearing URLs; no direct
          // requests to app-selected hosts run on Aico's LAN.
          await web.fetch(
            value,
            { maxChars: settings.evidence.max_chars, backend: 'jina' },
            { fetch, env },
          )
    try {
      const db = openCounter(dataDir(env))
      try {
        const at = new Date()
        count(db, at, {
          verb: `${app}/${verb}`,
          failed: 'error' in payload,
          fallback: Boolean(payload.fallback_reason || payload.provider_errors),
        })
        deps.status.upsert([counterRow(machineId(), today(db, at), at)])
      } finally {
        db.close()
      }
    } catch {
      /* A counter write must not lose fetched evidence. */
    }
    return payload
  })
  on('POST', '/v1/ask', async (ctx, app) => {
    const body = objectBody(await ctx.body())
    const extra = Object.keys(body).find(
      (key) => !['agent_slug', 'question', 'schema', 'images', 'effort'].includes(key),
    )
    if (extra) throw new HttpError(422, `Unknown ask field: ${extra}`)
    const slug = requiredString(body, 'agent_slug')
    const agents = (apps[app] as App).agents
    const profile = Object.hasOwn(agents, slug) ? agents[slug] : undefined
    if (!profile) throw new HttpError(403, 'This app has no such model role')
    const model = catalog.get(profile.model)
    // App roles never choose Claude, including via an alias in a bad config.
    if (!model || model.provider === 'claude') throw new HttpError(403, 'App model is unavailable')
    const question = requiredString(body, 'question')
    if (!question.trim()) throw new HttpError(422, 'question is required')
    if (body.effort !== undefined && typeof body.effort !== 'string')
      throw new HttpError(422, 'effort must be a string')
    const result = await (deps.ask ?? ask)(
      {
        model: model.id,
        cwd: process.cwd(),
        question: [...profile.prompts.map(readPrompt), question].join('\n\n'),
        ...(body.schema !== undefined && { schema: body.schema }),
        // ask validates every image and its combined size before dispatch.
        ...(body.images !== undefined && {
          images: body.images as { data: string; mimeType: string }[],
        }),
        ...(body.effort !== undefined && { effort: body.effort as string }),
      },
      {},
      env,
    )
    sendJson(
      ctx.res,
      result.outcome.kind === 'done' ? 200 : result.outcome.kind === 'bad_input' ? 422 : 502,
      result,
    )
    return RAW
  })
  on('GET', '/v1/status/rows', (_ctx, app) => deps.status.read({ project: [app] }))
  on('POST', '/v1/status/rows', async (ctx, app) => {
    const body = await ctx.body()
    const items = Array.isArray(body) ? body : [body]
    if (!items.length || items.length > 500) throw new HttpError(422, 'Send 1 to 500 rows')
    const rows = items.map((item) => ownRow(item, app, (apps[app] as App).machine))
    deps.status.upsert(rows)
    deps.notify.rowsWritten(rows)
    return { written: rows.length }
  })
  on('POST', '/v1/notices', async (ctx, app) => {
    try {
      const raw = await ctx.body()
      const notice = parseNotice(raw)
      if (
        notice.source !== app ||
        notice.command ||
        notice.if_ignored ||
        notice.actions.some((action) => ['look-into', 'expected', 'not-expected'].includes(action))
      )
        throw new HttpError(
          403,
          'Send your own app notices, without command or host verdict actions',
        )
      return deps.notify.notifier.receive(raw, 'local')
    } catch (error) {
      if (error instanceof NoticeError) throw new HttpError(422, `${error.field}: ${error.message}`)
      throw error
    }
  })
  on('POST', '/v1/notices/resolve', async (ctx, app) => {
    const body = objectBody(await ctx.body())
    const key = requiredString(body, 'key', { max: 200 })
    const text = requiredString(body, 'text', { max: 1000 })
    return deps.notify.notifier.resolve(app, key, text)
  })
  on('POST', '/v1/asks', async (ctx, app) => {
    const body = objectBody(await ctx.body())
    if (
      Object.keys(body).some((key) => !['question', 'options', 'body', 'recommended'].includes(key))
    )
      throw new HttpError(422, 'Send question, options, body and recommended only')
    const { body: created } = await deps.tether.request('POST', '/v1/asks', {
      ...body,
      requester: app,
      blocking: false,
    })
    return created
  })
  on('GET', '/v1/asks/:id', (ctx, app) => ownAsk(ctx.params.id as string, app))
  for (const how of ['done', 'withdraw'])
    on('POST', `/v1/asks/:id/${how}`, async (ctx, app) => {
      const id = ctx.params.id as string
      await ownAsk(id, app)
      await asks.close(id, how as 'done' | 'withdraw')
      return { closed: true }
    })
  return router
}

export function createServiceAppsServer(deps: ServiceAppsDeps): Server {
  const router = serviceAppsRouter(deps)
  return createServer((req, res) => {
    // Even unknown routes authenticate at the boundary; no browser API is present here.
    if (!serviceTokenApp(req, deps.apps ?? SERVICE_APPS, deps.env))
      return sendJson(res, 401, { detail: 'A LAN app service token is required' })
    router
      .handle(req, res, new URL(req.url ?? '/', 'http://apps'))
      .then((handled) => {
        if (!handled) sendJson(res, 404, { detail: 'Not Found' })
      })
      .catch(() => {
        if (!res.headersSent) sendJson(res, 500, { detail: 'Unexpected error' })
      })
  })
}
