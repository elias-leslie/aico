// App integrations have their own LAN listener. This router is never mounted on
// the browser server: a service token cannot open sessions, run commands or read
// another app's rows, prompts or asks.
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http'
import { join } from 'node:path'
import { type AskResult, ask, dataDir } from '@aico/agent'
import { Catalog, contextDbPath, getPrompt, openContext } from '@aico/context'
import { privateFile, secretsDir } from '@aico/fleet/secrets'
import { NoticeError, parseNotice } from '@aico/notify'
import { machineId, parseRow, RowError, type StatusStore } from '@aico/status'
import type { TetherClient } from '@aico/tether-client'
import {
  type Facts,
  loadFacts,
  loadPlans,
  openUsage,
  optionUsage,
  plansPath,
  usageDbPath,
  windowFacts,
} from '@aico/usage'
import {
  count,
  counterRow,
  fetchPage,
  fullPageContent,
  openCounter,
  searchWeb,
  today,
} from '@aico/webtools'
import settings from '../data/service-apps.json' with { type: 'json' }
import { type AskFallback, askFreeTier, wantsFreeTier } from './ask-free-tier'
import { objectBody, RAW, type RequestContext, Router, requiredString, sendJson } from './http'
import { fromLan, type NotifyHub, tetherAsks } from './notify'
import { needsPublicSearch, publicSearchFallback, publicSearchUnavailable } from './public-search'
import { frontedBy } from './service-primary'
import { HttpError } from './tether'

type Profile = {
  model: string
  prompts: string[]
  free_tier?: boolean
  fallback_models?: { model: string; subscription_only?: boolean }[]
}
type App = { machine: string; agents: Record<string, Profile>; prompts: string[] }
type Apps = Record<string, App>
export const SERVICE_APPS: Apps = settings.apps

export interface ServiceAppsDeps {
  status: StatusStore
  notify: Pick<NotifyHub, 'notifier' | 'store' | 'rowsWritten'>
  tether: Pick<TetherClient, 'request'>
  env?: NodeJS.ProcessEnv
  /** The workstation's own listener, on the standby: it gets each request first. */
  primary?: string | null
  apps?: Apps
  ask?: typeof ask
  /** Current subscription facts, injectable for isolated tests. */
  usageFacts?: (now: string) => Facts | null
  /** The Gemini free tier, for a role marked free_tier when its own model can't answer. */
  freeTier?: AskFallback
  prompt?: (slug: string) => string | null
  web?: { search: typeof searchWeb; fetch: typeof fetchPage }
  publicSearch?: typeof publicSearchFallback
}

/** Unknown or stale usage cannot establish that a subscription call avoids credits. */
function subscriptionAvailable(provider: string, facts: Facts | null, now: string): boolean {
  if (!facts?.collected_at || facts.unreadable?.[provider]) return false
  return (
    optionUsage(provider, windowFacts(facts.readings, now), facts.credits, facts.plan_ended)
      .status === 'ok'
  )
}

function productUsageFacts(env: NodeJS.ProcessEnv, now: string): Facts | null {
  const dir = dataDir(env)
  const path = usageDbPath(dir)
  if (!existsSync(path)) return null
  try {
    const db = openUsage(path)
    try {
      return loadFacts(db, loadPlans(plansPath(dir)), now)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
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
      row.actions?.length ||
      row.guard
    )
      throw new HttpError(
        403,
        'Write your own project rows, without command actions or host guard events',
      )
    return row
  } catch (error) {
    if (error instanceof RowError) throw new HttpError(422, `${error.field}: ${error.message}`)
    throw error
  }
}

/** A local model lives on the workstation's GPU: its failure here says that, not "fetch failed". */
function localModelOff<T extends { outcome: { kind: string; detail?: unknown } }>(
  provider: string,
  result: T,
): T {
  if (provider !== 'local' || result.outcome.kind !== 'error') return result
  const detail = `This model runs on the workstation's GPU, and it isn't reachable: ${String(result.outcome.detail ?? 'no answer')}`
  return { ...result, outcome: { ...result.outcome, detail } }
}

type ShoppingRequest = { request_id: string; kind: 'auto' | 'item' | 'receipt' | 'list' }

/** The service token is still the authority; the optional context is only opaque correlation. */
function shoppingRequest(value: unknown, app: string): ShoppingRequest | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || app !== 'portfolio-ai')
    throw new HttpError(422, 'Invalid Shopping context')
  const data = value as Record<string, unknown>
  if (
    Object.keys(data).length !== 2 ||
    typeof data.request_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.request_id) ||
    (data.kind !== 'auto' &&
      data.kind !== 'item' &&
      data.kind !== 'receipt' &&
      data.kind !== 'list')
  )
    throw new HttpError(422, 'Invalid Shopping context')
  return { request_id: data.request_id, kind: data.kind }
}

type ShoppingFault = 'ask_provider_failed' | 'evidence_search_failed' | 'evidence_fetch_failed'

function shoppingFault(
  deps: ServiceAppsDeps,
  shopping: ShoppingRequest | undefined,
  code: ShoppingFault,
  failed: boolean,
): void {
  if (!shopping) return
  const id = `portfolio-ai/shopping-repair/aico/${shopping.request_id}`
  try {
    const prior = deps.status.rows().find((stored) => stored.row.id === id)?.row
    const codes = new Set<ShoppingFault>()
    if (prior?.state === 'failed') {
      for (const previous of prior.meaning.split(';', 1)[0]?.split(',') ?? []) {
        if (
          previous === 'ask_provider_failed' ||
          previous === 'evidence_search_failed' ||
          previous === 'evidence_fetch_failed'
        )
          codes.add(previous)
      }
    }
    // Each failed category remains until that operation succeeds for this request.
    if (failed) codes.add(code)
    else if (!codes.delete(code)) return
    const row = {
      id,
      project: 'portfolio-ai',
      machine: machineId(),
      what: 'Shopping repair',
      kind: 'job' as const,
      state: codes.size ? ('failed' as const) : ('ok' as const),
      meaning: `${codes.size ? [...codes].sort().join(',') : 'verified'}; evidence ${shopping.request_id}; request ${shopping.request_id}`,
      last_run: new Date().toISOString(),
    }
    deps.status.upsert([row])
    deps.notify.rowsWritten([row])
  } catch {
    // Status reporting must not replace an already determined service response.
  }
}

function serviceAppsRouter(deps: ServiceAppsDeps): Router {
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
    const shopping = shoppingRequest(body.shopping, app)
    if (
      Number(body.query !== undefined) + Number(body.url !== undefined) !== 1 ||
      !Object.keys(body).every((key) =>
        ['query', 'url', 'shopping', 'intent', 'full_content'].includes(key),
      ) ||
      (body.full_content !== undefined &&
        (body.url === undefined || typeof body.full_content !== 'boolean')) ||
      (body.intent !== undefined && (body.intent !== 'product_offers' || body.query === undefined))
    )
      throw new HttpError(422, 'Send one public search query or URL')
    const verb = body.query !== undefined ? 'search' : 'fetch'
    const value = requiredString(body, verb === 'search' ? 'query' : 'url', { max: 2000 })
    if (!value.trim()) throw new HttpError(422, 'A query or URL is required')
    const web = deps.web ?? { search: searchWeb, fetch: fetchPage }
    const sharedSearch = () =>
      web
        .search(value, { max: settings.evidence.max_results }, { fetch, env })
        .catch(() => ({ error: 'Shared search unavailable' }))
    const retail = body.intent === 'product_offers'
    const modelSearch = async (): Promise<Record<string, unknown>> => {
      try {
        const discover = deps.publicSearch ?? publicSearchFallback
        const args = [
          value,
          settings.evidence.public_search_model,
          settings.evidence.max_results,
          env,
        ] as const
        if (!retail) return await discover(...args)
        const purpose = settings.evidence.purposes.product_offers
        const task = `${readPrompt(purpose.prompt)}\n\n${JSON.stringify({
          query: value,
          market: purpose.market,
          currency: purpose.currency,
        })}`
        return await discover(...args, task)
      } catch {
        return { error: 'Public search fallback unavailable' }
      }
    }
    let payload: Record<string, unknown> =
      verb === 'search'
        ? await (retail ? modelSearch() : sharedSearch())
        : // The public reader rejects private and credential-bearing URLs; no direct
          // requests to app-selected hosts run on Aico's LAN.
          await web
            .fetch(
              value,
              { maxChars: settings.evidence.max_chars, backend: 'jina' },
              { fetch, env },
            )
            .catch(() => ({ error: 'fetch_web_page jina request failed' }))
    if (verb === 'fetch' && body.full_content === true)
      payload = fullPageContent(payload, value, env)
    let searchFailed = false
    if (verb === 'search') {
      if (retail) {
        // Retail discovery needs the actual model search even when a cheap
        // provider would return unrelated links. Leads still need page checks.
        if (publicSearchUnavailable(payload)) {
          payload = await sharedSearch()
          searchFailed = Boolean(payload.error)
          if (!payload.error)
            payload.fallback_reason = 'Model-assisted retail discovery unavailable'
        } else {
          delete payload.fallback_reason
        }
      } else if (needsPublicSearch(value, payload)) {
        const primaryFailed = Boolean(payload.error)
        payload = await modelSearch()
        searchFailed = primaryFailed && publicSearchUnavailable(payload)
      }
    }
    if (verb === 'search') {
      if (searchFailed || !payload.error)
        shoppingFault(deps, shopping, 'evidence_search_failed', searchFailed)
    } else {
      const failure =
        payload.error === 'fetch_web_page jina request failed' ||
        payload.error === 'fetch_web_page full content unavailable'
      if (failure || (!payload.error && payload.status_code === 200))
        shoppingFault(deps, shopping, 'evidence_fetch_failed', failure)
    }
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
      (key) => !['agent_slug', 'question', 'schema', 'images', 'effort', 'shopping'].includes(key),
    )
    if (extra) throw new HttpError(422, `Unknown ask field: ${extra}`)
    const shopping = shoppingRequest(body.shopping, app)
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
    const prompted = [...profile.prompts.map(readPrompt), question].join('\n\n')
    const request = {
      model: model.id,
      cwd: process.cwd(),
      question: prompted,
      ...(body.schema !== undefined && { schema: body.schema }),
      // ask validates every image and its combined size before dispatch.
      ...(body.images !== undefined && {
        images: body.images as { data: string; mimeType: string }[],
      }),
      ...(body.effort !== undefined && { effort: body.effort as string }),
    }
    const callAsk = async (input: typeof request): Promise<AskResult> => {
      try {
        return await (deps.ask ?? ask)(input, {}, env)
      } catch {
        return {
          outcome: { kind: 'error', model: input.model, detail: 'Model service unavailable' },
          tokens: { input: 0, output: 0 },
          wallMs: 0,
        }
      }
    }
    let result: AskResult & { provider?: string } = await callAsk(request)
    let resultProvider = model.provider
    for (const fallbackModel of profile.fallback_models ?? []) {
      if (!wantsFreeTier(result.outcome) && result.outcome.kind !== 'schema_invalid') break
      const fallback = catalog.get(fallbackModel.model)
      if (!fallback || fallback.provider === 'claude')
        throw new HttpError(503, 'App fallback model is unavailable')
      if (fallbackModel.subscription_only) {
        const now = new Date().toISOString()
        const facts = deps.usageFacts ? deps.usageFacts(now) : productUsageFacts(env, now)
        if (!subscriptionAvailable(fallback.provider, facts, now)) continue
      }
      const first = result
      const second = await callAsk({ ...request, model: fallback.id })
      result = {
        ...second,
        tokens: {
          input: first.tokens.input + second.tokens.input,
          output: first.tokens.output + second.tokens.output,
        },
        wallMs: first.wallMs + second.wallMs,
        provider: fallback.provider,
      }
      resultProvider = fallback.provider
    }
    if (profile.free_tier && body.images === undefined && wantsFreeTier(result.outcome)) {
      console.warn(
        `[service-apps] ${app}/${slug}: ${model.id} did not answer, trying the free tier`,
      )
      const previous = result
      try {
        result = await (deps.freeTier ?? askFreeTier)(
          settings.free_tier,
          prompted,
          body.schema,
          result,
          env,
        )
      } catch {
        result = {
          ...result,
          outcome: { kind: 'error', model: model.id, detail: 'Model service unavailable' },
        }
      }
      if (result.provider === 'gemini-free-tier')
        result.tokens = {
          input: previous.tokens.input + result.tokens.input,
          output: previous.tokens.output + result.tokens.output,
        }
    }
    if (
      result.outcome.kind === 'error' ||
      result.outcome.kind === 'silent' ||
      result.outcome.kind === 'schema_invalid'
    )
      shoppingFault(deps, shopping, 'ask_provider_failed', true)
    else if (result.outcome.kind === 'done')
      shoppingFault(deps, shopping, 'ask_provider_failed', false)
    sendJson(
      ctx.res,
      result.outcome.kind === 'done' ? 200 : result.outcome.kind === 'bad_input' ? 422 : 502,
      localModelOff(resultProvider, result),
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

/** The rows an app reported through to the workstation: this machine keeps them too, so its Status
 * has them from the moment the workstation is off. Bad rows are the workstation's to refuse. */
function keepRows(req: IncomingMessage, body: Buffer, deps: ServiceAppsDeps, apps: Apps): void {
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/status/rows')) return
  const app = serviceTokenApp(req, apps, deps.env)
  if (!app) return
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    const items = Array.isArray(parsed) ? parsed : [parsed]
    deps.status.upsert(items.map((item) => ownRow(item, app, (apps[app] as App).machine)))
  } catch {
    /* The workstation's answer stands; a row this machine can't keep comes again next report. */
  }
}

export function createServiceAppsServer(deps: ServiceAppsDeps): Server {
  const router = serviceAppsRouter(deps)
  const apps = deps.apps ?? SERVICE_APPS
  const here: RequestListener = (req, res) => {
    router
      .handle(req, res, new URL(req.url ?? '/', 'http://apps'))
      .then((handled) => {
        if (!handled) sendJson(res, 404, { detail: 'Not Found' })
      })
      .catch(() => {
        if (!res.headersSent) sendJson(res, 500, { detail: 'Unexpected error' })
      })
  }
  const fronted = frontedBy(deps.primary ?? null, here, {
    maxBodyBytes: settings.max_body_bytes,
    taken: (req, body) => keepRows(req, body, deps, apps),
    // An ask opened here while the workstation was off is still here when it is back.
    askHere: (req, status) => status === 404 && !!req.url?.startsWith('/v1/asks/'),
  })
  return createServer((req, res) => {
    // Even unknown routes authenticate at the boundary; no browser API is present here.
    if (!serviceTokenApp(req, apps, deps.env))
      return sendJson(res, 401, { detail: 'A LAN app service token is required' })
    fronted(req, res)
  })
}
