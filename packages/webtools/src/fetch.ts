// fetch, batch, refocus and research: direct HTTP with readable extraction, the public
// Jina reader as the fallback in `auto` (a failed or sparse page), focus and truncation,
// and the full extraction kept for refocus. Output shapes match Agent Hub's `st web`.

import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { loadArtifact, saveArtifact } from './artifacts'
import { extractHtml, type Page } from './extract'
import { type FocusMeta, normalizeWhitespace, selectFocused } from './focus'
import { type SearchRequest, search } from './search'

export const DEFAULT_MAX_CHARS = 12_000
const MAX_CHARS = 50_000
export const DEFAULT_TIMEOUT = 20
const ACCEPT =
  'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, text/plain;q=0.7, application/json;q=0.5, */*;q=0.1'
const USER_AGENT = 'aico-webtools/1 (agent web research tool)'
const JINA = 'https://r.jina.ai'
const SPARSE_CHARS = 400
const SPA_MARKERS = [
  'id="__next"',
  "id='__next'",
  'id="root"',
  "id='root'",
  'id="app"',
  "id='app'",
  'data-reactroot',
  'ng-version',
  'id="___gatsby"',
  '__nuxt__',
]
const EMPTY_CONTAINER =
  /<(div|main|section|article)[^>]+(?:id|class)=['"][^'"]+['"][^>]*>\s*<\/(?:div|main|section|article)>/
const SENSITIVE_QUERY = [
  'token',
  'credential',
  'api_key',
  'apikey',
  'password',
  'secret',
  'signature',
  'sig',
  'auth',
  'key',
  'code',
]
const LOCAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.test',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
  '.invalid',
]

type Payload = Record<string, unknown>
export type Backend = 'auto' | 'direct' | 'jina'
export const BACKENDS: readonly string[] = ['auto', 'direct', 'jina']

export interface FetchOptions {
  maxChars?: number
  focusQuery?: string | undefined
  backend?: string
  /** Seconds. */
  timeout?: number
}

export interface Deps {
  fetch: typeof fetch
  env: NodeJS.ProcessEnv
}

const ms = (since: number) => Math.round((performance.now() - since) * 1000) / 1000
const error = (message: string, extra: Payload = {}): Payload => ({ error: message, ...extra })

function truncate(text: string, max: number): [string, boolean] {
  const cleaned = text.trim()
  return cleaned.length <= max
    ? [cleaned, false]
    : [`${cleaned.slice(0, max - 1).trimEnd()}…`, true]
}

/** A public reader must not receive local addresses, URL credentials or secret-looking queries. */
export function publicFallbackAllowed(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.replace(/\.$/, '').toLowerCase()
  if (!['http:', 'https:'].includes(parsed.protocol) || !host || parsed.username || parsed.password)
    return false
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare)) {
    if (!isGlobalIp(bare)) return false
  } else if (
    !host.includes('.') ||
    host === 'localhost' ||
    LOCAL_SUFFIXES.some((s) => host.endsWith(s))
  )
    return false
  for (const key of parsed.searchParams.keys())
    if (SENSITIVE_QUERY.some((marker) => key.toLowerCase().includes(marker))) return false
  return !parsed.hash
}

function isGlobalIp(ip: string): boolean {
  return ipaddr.parse(ip).range() === 'unicast'
}

function sparse(contentType: string, raw: string, content: string): boolean {
  if (contentType && !contentType.includes('html')) return false
  const text = content.trim()
  const lowered = raw.toLowerCase()
  if (text.length < SPARSE_CHARS) {
    if (raw.length >= 1000) return true
    if (lowered.includes('<script') && EMPTY_CONTAINER.test(lowered)) return true
  }
  return text.length < SPARSE_CHARS * 3 && SPA_MARKERS.some((marker) => lowered.includes(marker))
}

class Unsupported extends Error {}

function extractPage(contentType: string, raw: string, tokens: string | null): Page {
  let page: Page
  if (contentType.includes('markdown')) page = { content: raw.trim(), format: 'markdown' }
  else if (contentType.includes('html') || !contentType) page = extractHtml(raw)
  else if (contentType.startsWith('text/') || contentType.includes('json'))
    page = { content: raw, format: 'text' }
  else throw new Unsupported('unsupported content type')
  if (tokens && /^\d+$/.test(tokens)) page.markdown_tokens_estimate = Number(tokens)
  return page
}

function view(page: Page, max: number, focusQuery: string | undefined) {
  const query = normalizeWhitespace(focusQuery ?? '')
  const focus = selectFocused(page.content, query || null, max)
  const chosen = focus.meta.focused ? focus.text : page.content
  const [content, truncated] = truncate(chosen, max)
  const [excerpt] = truncate(normalizeWhitespace(content.replace(/\n/g, ' ')), Math.min(500, max))
  return { content, truncated, excerpt, meta: focus.meta, query: query || null }
}

function build(
  page: Page,
  status: number,
  backend: string,
  url: string,
  finalUrl: string,
  contentType: string,
  shown: ReturnType<typeof view>,
): Payload {
  const meta: FocusMeta = shown.meta
  const payload: Payload = {
    content: shown.content,
    content_type: contentType || 'unknown',
    fetch_backend: backend,
    final_url: finalUrl,
    format: page.format,
    status_code: status,
    truncated: shown.truncated,
    url,
  }
  for (const key of ['title', 'site_name', 'author'] as const)
    if (page[key]) payload[key] = page[key]
  if (page.published) {
    payload.published = page.published
    payload.published_date_inferred = page.published_date_inferred ?? false
  }
  if (shown.excerpt) payload.excerpt = shown.excerpt
  if (page.markdown_tokens_estimate !== undefined)
    payload.markdown_tokens_estimate = page.markdown_tokens_estimate
  if (shown.query) payload.focus_query = shown.query
  if (meta.focused) {
    payload.focused = true
    payload.focus_strategy = meta.focus_strategy
    payload.selected_chunk_count = meta.selected_chunk_count
    payload.candidate_chunk_count = meta.candidate_chunk_count
  } else if (shown.query) payload.focused = false
  payload.content_complete = Boolean(shown.content) && !shown.truncated && !meta.focused
  if (!payload.content_complete)
    payload.incomplete_reason = meta.focused
      ? 'focus_selection'
      : shown.truncated
        ? 'character_limit'
        : 'empty_extraction'
  return payload
}

/** Keeps the full extraction for refocus and bounds the diagnostic text left in the answer. */
function retain(payload: Payload, content: string, max: number, env: NodeJS.ProcessEnv): Payload {
  payload.coverage ??= { scope: 'document', source_completeness: 'unverified' }
  const coverage = payload.coverage as Payload
  try {
    Object.assign(payload, saveArtifact(payload, content, env))
    coverage.full_extraction_retained = true
  } catch (cause) {
    payload.artifact_error = (cause as Error).message
    coverage.full_extraction_retained = false
    payload.stages ??= []
    ;(payload.stages as Payload[]).push({
      stage: 'artifact_write',
      error: (cause as Error).message,
    })
  }
  const cut: string[] = []
  const bound = (value: unknown, prefix: string) => {
    if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) bound(item, `${prefix}[${i}]`)
    } else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (
          ['raw_receipt', 'stderr', 'detail'].includes(key) &&
          typeof item === 'string' &&
          item.length > max
        ) {
          ;(value as Payload)[key] = truncate(item, max)[0]
          cut.push(path)
        } else bound(item, path)
      }
  }
  bound(payload, '')
  if (cut.length) {
    payload.diagnostic_truncated = cut
    payload.diagnostic_artifact_available = Boolean(payload.artifact_id)
  }
  return payload
}

async function reader(
  url: string,
  o: Required<Pick<FetchOptions, 'maxChars' | 'timeout'>> & Pick<FetchOptions, 'focusQuery'>,
  deps: Deps,
  stages: Payload[],
  reason?: string,
  prior?: Payload,
): Promise<Payload> {
  if (!publicFallbackAllowed(url))
    return error('fetch_web_page public reader rejects private or credential-bearing URL')
  const readerUrl = `${JINA}/${url}`
  const started = performance.now()
  let response: Response
  let text: string
  try {
    response = await deps.fetch(readerUrl, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain, text/markdown;q=0.9' },
      signal: AbortSignal.timeout(o.timeout * 1000),
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    text = await response.text()
  } catch (cause) {
    return error('fetch_web_page jina request failed', {
      detail: (cause as Error).message,
      fallback_reason: reason ?? null,
      reader_url: readerUrl,
      url,
      stages: [
        ...stages,
        { stage: 'jina_request', duration_ms: ms(started), error: (cause as Error).message },
      ],
      direct_failure: prior ?? null,
    })
  }
  const page: Page = { content: text.trim(), format: 'markdown', site_name: 'Jina Reader' }
  const contentType = response.headers.get('content-type') ?? 'text/plain'
  const payload = build(
    page,
    response.status,
    'jina',
    url,
    response.url,
    contentType,
    view(page, o.maxChars, o.focusQuery),
  )
  payload.reader_url = readerUrl
  payload.stages = [...stages, { stage: 'jina_request', duration_ms: ms(started) }]
  if (prior) payload.direct_failure = prior
  if (reason) payload.fallback_reason = reason
  return retain(payload, page.content, o.maxChars, deps.env)
}

export async function fetchPage(url: string, options: FetchOptions, deps: Deps): Promise<Payload> {
  const started = performance.now()
  const target = url.trim()
  if (!target) return error('fetch_web_page requires a non-empty url')
  if (!/^https?:\/\//.test(target))
    return error('fetch_web_page only supports http:// and https:// URLs')
  const backend = (options.backend || 'auto').trim().toLowerCase()
  if (!BACKENDS.includes(backend))
    return error('fetch_web_page backend must be one of: auto, direct, jina', { backend })
  const timeout = options.timeout ?? DEFAULT_TIMEOUT
  if (!Number.isFinite(timeout) || timeout <= 0)
    return error('fetch_web_page timeout must be finite and positive')
  const max = Math.max(100, Math.min(options.maxChars ?? DEFAULT_MAX_CHARS, MAX_CHARS))
  const o = { maxChars: max, timeout, focusQuery: options.focusQuery }
  const stages: Payload[] = []

  const viaReader = async (reason?: string, at = target, prior?: Payload) => {
    const result = await reader(at, o, deps, stages, reason, prior)
    result.stages ??= stages
    result.total_ms = ms(started)
    return result
  }
  if (backend === 'jina') return viaReader()

  const requested = performance.now()
  let response: Response
  let raw: string
  try {
    response = await deps.fetch(target, {
      headers: { 'user-agent': USER_AGENT, accept: ACCEPT },
      signal: AbortSignal.timeout(timeout * 1000),
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    raw = await response.text()
  } catch (cause) {
    stages.push({
      stage: 'direct_request',
      error: (cause as Error).message,
      duration_ms: ms(requested),
    })
    if (backend === 'auto') return viaReader('direct request failed: provider returned an error')
    return error('fetch_web_page request failed', {
      detail: (cause as Error).message,
      url: target,
      stages,
    })
  }
  stages.push({ stage: 'direct_request', duration_ms: ms(requested) })
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  const finalUrl = response.url || target
  const extracting = performance.now()
  let page: Page
  try {
    page = extractPage(contentType, raw, response.headers.get('x-markdown-tokens'))
  } catch (cause) {
    const unsupported = cause instanceof Unsupported
    stages.push({
      stage: 'direct_extraction',
      error: (cause as Error).message,
      duration_ms: ms(extracting),
    })
    const failure = retain(
      {
        error: unsupported
          ? 'fetch_web_page only supports text-like responses'
          : 'fetch_web_page extraction failed',
        detail: (cause as Error).message,
        content_type: contentType,
        url: target,
        stages: [...stages],
        artifact_kind: 'raw_response',
        content_complete: false,
      },
      raw,
      max,
      deps.env,
    )
    if (backend === 'auto')
      return viaReader(
        `${unsupported ? 'unsupported content type' : 'direct extraction failed'}: ${contentType}`,
        target,
        failure,
      )
    return failure
  }
  stages.push({ stage: 'direct_extraction', duration_ms: ms(extracting) })

  const thin = sparse(contentType, raw, page.content)
  let fallbackFailure: Payload | undefined
  if (backend === 'auto' && thin) {
    const viaJina = await viaReader(
      'direct extraction looked like a sparse dynamic shell',
      publicFallbackAllowed(target) ? finalUrl : target,
    )
    if (!('error' in viaJina)) return viaJina
    fallbackFailure = viaJina
  }
  const payload = build(
    page,
    response.status,
    'direct',
    target,
    finalUrl,
    contentType,
    view(page, max, options.focusQuery),
  )
  payload.stages = stages
  payload.total_ms = ms(started)
  payload.coverage = {
    scope: 'document',
    source_completeness: 'unverified',
    sparse_dynamic_shell: thin,
    full_extraction_retained: true,
  }
  if (fallbackFailure) payload.fallback_failure = fallbackFailure
  if (thin) {
    payload.content_complete = false
    payload.incomplete_reason = 'sparse_dynamic_shell'
  }
  return retain(payload, page.content, max, deps.env)
}

/** Restore only display-limited text from this public fetch's own retained extraction. */
export function fullPageContent(payload: Payload, url: string, env: NodeJS.ProcessEnv): Payload {
  const unavailable = () => ({ ...payload, error: 'fetch_web_page full content unavailable' })
  if (payload.error) return payload
  if (!publicFallbackAllowed(url) || payload.url !== url) return unavailable()
  if (payload.status_code !== 200) return payload
  if (payload.content_complete === true && payload.truncated !== true) return payload
  // A retained extraction cannot repair a partial source, selected focus or failed request.
  if (payload.incomplete_reason !== 'character_limit' || payload.truncated !== true) return payload
  if (typeof payload.artifact_id !== 'string' || !/^[a-f0-9]{32}$/.test(payload.artifact_id))
    return unavailable()
  let record: Payload
  try {
    record = loadArtifact(payload.artifact_id, env)
  } catch {
    return unavailable()
  }
  const coverage = record.coverage as Payload | undefined
  if (
    record.artifact_content_scope !== 'full_extracted_text' ||
    record.artifact_kind === 'raw_response' ||
    record.error ||
    record.url !== url ||
    record.final_url !== payload.final_url ||
    record.fetch_backend !== payload.fetch_backend ||
    record.status_code !== payload.status_code ||
    record.incomplete_reason !== 'character_limit' ||
    record.truncated !== true ||
    record.focused === true ||
    coverage?.sparse_dynamic_shell === true ||
    typeof record.content !== 'string' ||
    !record.content.trim() ||
    record.full_content_chars !== record.content.length
  )
    return unavailable()
  const complete: Payload = {
    ...payload,
    content: record.content,
    truncated: false,
    content_complete: true,
  }
  delete complete.incomplete_reason
  return complete
}

export function refocus(
  artifact: string,
  options: { maxChars?: number; focusQuery?: string | undefined },
  deps: Pick<Deps, 'env'>,
): Payload {
  let record: Payload
  try {
    record = loadArtifact(artifact, deps.env)
  } catch (cause) {
    return error('web artifact refocus failed', { detail: (cause as Error).message })
  }
  if (record.artifact_kind === 'raw_response')
    return error('web artifact contains a failed raw response, not extracted content', {
      artifact_id: record.artifact_id,
    })
  const max = Math.max(100, Math.min(options.maxChars ?? DEFAULT_MAX_CHARS, MAX_CHARS))
  const page: Page = {
    content: record.content as string,
    format: (record.format as Page['format']) ?? 'text',
    ...(record.title ? { title: record.title as string } : {}),
    ...(record.site_name ? { site_name: record.site_name as string } : {}),
    ...(record.author ? { author: record.author as string } : {}),
    ...(record.published
      ? {
          published: record.published as string,
          published_date_inferred: Boolean(record.published_date_inferred),
        }
      : {}),
    ...(typeof record.markdown_tokens_estimate === 'number'
      ? { markdown_tokens_estimate: record.markdown_tokens_estimate }
      : {}),
  }
  const shown = view(page, max, options.focusQuery)
  const payload = build(
    page,
    (record.status_code as number) ?? 0,
    (record.fetch_backend as string) ?? 'unknown',
    (record.url as string) ?? '',
    (record.final_url as string) ?? '',
    (record.content_type as string) ?? '',
    shown,
  )
  Object.assign(payload, {
    artifact_id: record.artifact_id,
    artifact_path: record.artifact_path,
    full_content_chars: page.content.length,
    coverage: record.coverage ?? {},
    network_access: false,
  })
  // A cached view cannot strengthen the original source's coverage claim.
  payload.content_complete = false
  if (!shown.truncated && !shown.meta.focused)
    payload.incomplete_reason = 'source_completeness_unverified'
  return payload
}

export async function fetchBatch(
  urls: string[],
  options: FetchOptions,
  deps: Deps,
): Promise<Payload> {
  const results: Payload[] = []
  for (const url of urls) results.push(await fetchPage(url, options, deps))
  const failed = results.filter((r) => 'error' in r).length
  const payload: Payload = { results, failed_count: failed, result_count: results.length }
  if (failed) payload.error = 'web batch contains failed fetches'
  return payload
}

export interface SearchOptions {
  max?: number
  type?: string
  timelimit?: string | undefined
}

export async function searchWeb(
  query: string,
  options: SearchOptions,
  deps: Deps,
): Promise<Payload> {
  const q = query.trim()
  const type = options.type ?? 'text'
  if (!q) return error('search_web requires a non-empty query')
  if (type !== 'text' && type !== 'news')
    return error('search_web search_type must be one of: text, news', { search_type: type })
  if (options.timelimit !== undefined && !['d', 'w', 'm', 'y'].includes(options.timelimit))
    return error('search_web timelimit must be one of: d, w, m, y', {
      timelimit: options.timelimit,
    })
  const request: SearchRequest = {
    query: q,
    max: options.max ?? 5,
    type,
    timelimit: options.timelimit,
  }
  const outcome = await search(request, deps.env, deps.fetch)
  if (outcome.provider === 'none' && outcome.errors.length)
    return error('search_web request failed', {
      detail: outcome.errors.map((e) => `${e.provider}: ${e.detail}`).join('; '),
      query: q,
      provider_errors: outcome.errors,
    })
  const payload: Payload = {
    provider: outcome.provider,
    query: q,
    result_count: outcome.results.length,
    results: outcome.results,
    search_type: type,
  }
  if (outcome.errors.length) payload.provider_errors = outcome.errors
  payload.status = outcome.results.length ? 'results' : 'no_results'
  if (options.timelimit) payload.timelimit = options.timelimit
  if (outcome.time_filtered === false) {
    payload.time_filtered = false
    payload.note = `${outcome.provider} cannot filter by time; these results are NOT limited to the requested timelimit (${options.timelimit}).`
  }
  return payload
}

export async function research(
  query: string,
  options: SearchOptions & FetchOptions & { resultIndex?: number },
  deps: Deps,
): Promise<Payload> {
  const q = normalizeWhitespace(query)
  if (!q) return error('research_web requires a non-empty query')
  const index = options.resultIndex ?? 1
  if (index < 1)
    return error('research_web result_index must be at least 1', { result_index: index })
  const found = await searchWeb(q, options, deps)
  if ('error' in found) return { error: 'research_web search step failed', query: q, search: found }
  const results = found.results as Payload[]
  if (!results.length)
    return {
      query: q,
      search: found,
      selected_result: null,
      fetched: false,
      message: 'No search results to fetch.',
    }
  if (index > results.length)
    return error('research_web result_index exceeds available search results', {
      query: q,
      result_index: index,
      available_results: results.length,
    })
  const selected = results[index - 1] as Payload
  const focus = normalizeWhitespace(options.focusQuery ?? q)
  const page = await fetchPage(String(selected.url ?? ''), { ...options, focusQuery: focus }, deps)
  if ('error' in page)
    return {
      error: 'research_web fetch step failed',
      focus_query: focus,
      page,
      query: q,
      search: found,
      selected_result: selected,
    }
  return {
    fetched: true,
    focus_query: focus,
    page,
    query: q,
    search: found,
    selected_result: selected,
  }
}
