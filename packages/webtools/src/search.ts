// Keyless public web search. SearXNG when WEB_SEARCH_SEARXNG_URL names one; otherwise
// DuckDuckGo's lite page for text and Bing's RSS for news. Fallbacks must retain
// the requested scope and recency; unsupported provider filters fail closed.

import { plainText } from './extract'
import { normalizeWhitespace } from './focus'

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
const SEARCH_TIMEOUT_MS = 12_000
const MAX_RESULTS = 10

export interface SearchResult {
  rank: number
  title: string
  url: string
  snippet?: string
  source?: string
  search_engine?: string
  published?: string
}

export interface SearchRequest {
  query: string
  max: number
  type: 'text' | 'news'
  timelimit?: string | undefined
}

export interface SearchOutcome {
  provider: string
  results: SearchResult[]
  /** Providers tried first that failed or had nothing. */
  errors: { provider: string; detail: string }[]
}

type Raw = Omit<SearchResult, 'rank'>

function collect(raw: Raw[], max: number): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const item of raw) {
    if (!item.url || seen.has(item.url)) continue
    seen.add(item.url)
    out.push({ rank: out.length + 1, ...item })
    if (out.length >= max) break
  }
  return out
}

type Fetch = typeof fetch

async function get(fetcher: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetcher(url, {
    ...init,
    headers: { 'user-agent': USER_AGENT, ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
  return response
}

const SEARXNG_RANGE: Record<string, string> = { d: 'day', w: 'week', m: 'month', y: 'year' }

async function searxng(fetcher: Fetch, base: string, req: SearchRequest): Promise<Raw[]> {
  const params = new URLSearchParams({ q: req.query, format: 'json', safesearch: '1' })
  if (req.type === 'news') params.set('categories', 'news')
  if (req.timelimit) params.set('time_range', SEARXNG_RANGE[req.timelimit] as string)
  const payload = (await (
    await get(fetcher, `${base}/search?${params}`, { headers: { accept: 'application/json' } })
  ).json()) as { results?: Record<string, unknown>[] }
  if (!Array.isArray(payload.results)) throw new Error('SearXNG response missing results list')
  return payload.results.map((r) => ({
    title: normalizeWhitespace(String(r.title ?? r.url ?? '')),
    url: String(r.url ?? r.href ?? '').trim(),
    ...(r.content ? { snippet: normalizeWhitespace(String(r.content)) } : {}),
    ...(r.engine ? { search_engine: String(r.engine) } : {}),
    ...(r.publishedDate ? { published: String(r.publishedDate) } : {}),
  }))
}

/** DuckDuckGo's lite page: a link row, then its snippet row, per result. */
export function parseLite(html: string): Raw[] {
  const out: Raw[] = []
  const link = /<a\b[^>]*class=['"]result-link['"][^>]*>/g
  const links = [...html.matchAll(link)]
  for (const [i, match] of links.entries()) {
    const href = /href=["']([^"']+)["']/.exec(match[0])?.[1]
    const end = links[i + 1]?.index ?? html.length
    const after = html.slice((match.index ?? 0) + match[0].length, end)
    const title = plainText(after.slice(0, after.indexOf('</a>')))
    const snippet = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/.exec(after)
    const near = snippet ? plainText(snippet[1] as string) : ''
    if (href) out.push({ title: title || href, url: decode(href), ...(near && { snippet: near }) })
  }
  return out
}

const decode = (value: string) => plainText(value)

async function duckduckgo(fetcher: Fetch, req: SearchRequest): Promise<Raw[]> {
  const body = new URLSearchParams({ q: req.query, kl: 'wt-wt', kp: '-1' })
  if (req.timelimit) body.set('df', req.timelimit)
  const html = await (
    await get(fetcher, 'https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
  ).text()
  const results = parseLite(html)
  if (!results.length && /anomaly|captcha/i.test(html))
    throw new Error('DuckDuckGo asked for a challenge')
  return results
}

const BING_INTERVAL: Record<string, string> = { d: '7', w: '8', m: '9' }

/** Bing's RSS (web or news): <item> with title, link, description, pubDate. */
export function parseRss(xml: string): Raw[] {
  const field = (item: string, tag: string) =>
    plainText(
      (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? '').replace(
        /^<!\[CDATA\[([\s\S]*?)\]\]>$/,
        '$1',
      ),
    )
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const item = m[1] as string
    let url = field(item, 'link')
    try {
      const target = new URL(url).searchParams.get('url')
      if (target) url = target
    } catch {}
    const snippet = field(item, 'description')
    const source = field(item, 'News:Source')
    const published = field(item, 'pubDate')
    return {
      title: field(item, 'title') || url,
      url,
      ...(snippet && { snippet }),
      ...(source && { source }),
      ...(published && { published }),
    }
  })
}

async function bing(fetcher: Fetch, req: SearchRequest): Promise<Raw[]> {
  if (req.timelimit && (req.type === 'text' || req.timelimit === 'y'))
    throw new Error(
      `Bing RSS cannot preserve the requested ${req.type} recency filter (${req.timelimit})`,
    )
  const params = new URLSearchParams({ q: req.query, format: 'rss' })
  const interval = req.timelimit && BING_INTERVAL[req.timelimit]
  if (interval && req.type === 'news') params.set('qft', `interval="${interval}"`)
  const path = req.type === 'news' ? 'news/search' : 'search'
  return parseRss(await (await get(fetcher, `https://www.bing.com/${path}?${params}`)).text())
}

export async function search(
  req: SearchRequest,
  env: NodeJS.ProcessEnv,
  fetcher: Fetch,
): Promise<SearchOutcome> {
  const max = Math.max(1, Math.min(req.max, MAX_RESULTS))
  const base = env.WEB_SEARCH_SEARXNG_URL?.trim().replace(/\/$/, '')
  const order: [string, () => Promise<Raw[]>][] = [
    ...(base
      ? ([['searxng', () => searxng(fetcher, base, req)]] as [string, () => Promise<Raw[]>][])
      : []),
    ...(req.type === 'news'
      ? ([['bing', () => bing(fetcher, req)]] as [string, () => Promise<Raw[]>][])
      : ([
          ['duckduckgo', () => duckduckgo(fetcher, req)],
          ['bing', () => bing(fetcher, req)],
        ] as [string, () => Promise<Raw[]>][])),
  ]
  const errors: SearchOutcome['errors'] = []
  for (const [provider, run] of order) {
    try {
      const results = collect(await run(), max)
      if (results.length) return { provider, results, errors }
      errors.push({ provider, detail: 'no results' })
    } catch (error) {
      errors.push({ provider, detail: (error as Error).message })
    }
  }
  const last = errors.at(-1)
  // Every provider answered with nothing: that is "no results", not a failure.
  if (errors.every((e) => e.detail === 'no results'))
    return { provider: last?.provider ?? 'none', results: [], errors: [] }
  return { provider: 'none', results: [], errors }
}
