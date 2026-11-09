// Search results are discovery leads, never verified product or price evidence.
import { publicSearch } from '@aico/agent'

type Payload = Record<string, unknown>
type Search = typeof publicSearch

export function publicSearchUnavailable(payload: Payload): boolean {
  return Boolean(
    payload.error === 'Public search fallback unavailable' &&
      (payload.detail === undefined || payload.detail === 'error' || payload.detail === 'silent'),
  )
}

function sites(query: string): string[] {
  const domains: string[] = []
  for (const match of query.matchAll(/(?:^|[\s(])site:([a-z0-9.-]+)(?=[\s)]|$)/gi))
    if (match[1]) domains.push(match[1].toLowerCase())
  return domains
}

function matchesSites(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

export function needsPublicSearch(query: string, payload: Payload): boolean {
  const results = Array.isArray(payload.results) ? payload.results : []
  if (payload.error || !results.length) return true
  const domains = sites(query)
  return Boolean(
    domains.length &&
      !results.some(
        (r: unknown) =>
          r &&
          typeof r === 'object' &&
          typeof (r as Payload).url === 'string' &&
          matchesSites((r as Payload).url as string, domains),
      ),
  )
}

/** Resolve only Google's fixed grounding redirect host, without requesting its target. */
async function directUrl(value: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    if (url.hostname === 'vertexaisearch.cloud.google.com') {
      if (
        url.protocol !== 'https:' ||
        url.port ||
        !url.pathname.startsWith('/grounding-api-redirect/')
      )
        return null
      const response = await fetcher(url, { redirect: 'manual' })
      if (response.status < 300 || response.status >= 400) return null
      const location = response.headers.get('location')
      if (!location) return null
      const target = new URL(location)
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password)
        return null
      return target.href
    }
    return url.href
  } catch {
    return null
  }
}

export async function publicSearchFallback(
  query: string,
  model: string,
  max: number,
  env: NodeJS.ProcessEnv,
  task?: string,
  search: Search = publicSearch,
  fetcher: typeof fetch = fetch,
): Promise<Payload> {
  try {
    const result = await search(task ?? query, model, {}, env)
    if (result.outcome.kind !== 'done')
      return { error: 'Public search fallback unavailable', detail: result.outcome.kind, query }
    const data = result.outcome.data as { results: { title: string; url: string }[] }
    if (task !== undefined && Array.isArray(data.results) && data.results.length === 0)
      return {
        provider: 'agy-search-web',
        query,
        search_type: 'text',
        status: 'no_results',
        result_count: 0,
        results: [],
      }
    const domains = sites(query)
    const resolved = await Promise.all(
      data.results.map(async (item) => ({
        title: item.title,
        url: await directUrl(item.url, fetcher),
      })),
    )
    const seen = new Set<string>()
    const results = resolved
      .filter((item): item is { title: string; url: string } => {
        if (!item.url || (domains.length && !matchesSites(item.url, domains)) || seen.has(item.url))
          return false
        seen.add(item.url)
        return true
      })
      .slice(0, max)
      .map((item, index) => ({ rank: index + 1, ...item }))
    if (!results.length) return { error: 'Public search fallback found no matching URLs', query }
    return {
      provider: 'agy-search-web',
      query,
      search_type: 'text',
      status: 'results',
      result_count: results.length,
      results,
      fallback_reason: 'Shared search failed or returned no requested site URLs',
      note: 'Discovery only: fetch and verify sources independently before using product or price claims.',
    }
  } catch {
    return { error: 'Public search fallback unavailable', query }
  }
}
