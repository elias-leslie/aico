// Search results are discovery leads, never verified product or price evidence.
import { publicSearch } from '@aico/agent'

type Payload = Record<string, unknown>
type Search = typeof publicSearch

function site(query: string): string | undefined {
  return /(?:^|\s)site:([a-z0-9.-]+)(?=\s|$)/i.exec(query)?.[1]?.toLowerCase()
}

function matchesSite(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === domain || host.endsWith(`.${domain}`)
  } catch {
    return false
  }
}

export function needsPublicSearch(query: string, payload: Payload): boolean {
  const results = Array.isArray(payload.results) ? payload.results : []
  if (payload.error || !results.length) return true
  const domain = site(query)
  return Boolean(
    domain &&
      !results.some(
        (r: unknown) =>
          r &&
          typeof r === 'object' &&
          typeof (r as Payload).url === 'string' &&
          matchesSite((r as Payload).url as string, domain),
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
  search: Search = publicSearch,
  fetcher: typeof fetch = fetch,
): Promise<Payload> {
  try {
    const result = await search(query, model, {}, env)
    if (result.outcome.kind !== 'done')
      return { error: 'Public search fallback unavailable', detail: result.outcome.kind, query }
    const data = result.outcome.data as { results: { title: string; url: string }[] }
    const domain = site(query)
    const resolved = await Promise.all(
      data.results.map(async (item) => ({
        title: item.title,
        url: await directUrl(item.url, fetcher),
      })),
    )
    const seen = new Set<string>()
    const results = resolved
      .filter((item): item is { title: string; url: string } => {
        if (!item.url || (domain && !matchesSite(item.url, domain)) || seen.has(item.url))
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
