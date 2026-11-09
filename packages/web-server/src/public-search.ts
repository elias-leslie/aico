// Search results are discovery leads, never verified product or price evidence.
import { publicSearch } from '@aico/agent'
import { publicFallbackAllowed } from '@aico/webtools'

type Payload = Record<string, unknown>
type Search = typeof publicSearch
type RetailOptions = {
  rejectedUrls: string[]
  nonPurchaseUrls: {
    host: string
    path_prefix?: string
    except_path_contains?: string
    query_key?: string
    query_value?: string
  }[]
}
type Lead = { title: string; url: string }

function host(url: string): string {
  return new URL(url).hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}

function nonPurchase(url: string, rules: RetailOptions['nonPurchaseUrls']): boolean {
  const parsed = new URL(url)
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  return rules.some(
    (rule) =>
      (hostname === rule.host || hostname.endsWith(`.${rule.host}`)) &&
      (!rule.path_prefix || parsed.pathname.startsWith(rule.path_prefix)) &&
      (!rule.except_path_contains || !parsed.pathname.includes(rule.except_path_contains)) &&
      (!rule.query_key || parsed.searchParams.get(rule.query_key) === rule.query_value),
  )
}

/** Stable round-robin by host, with previously rejected hosts as a soft fallback. */
function diverse(leads: Lead[], rejectedUrls: string[]): Lead[] {
  const rejected = new Set(rejectedUrls.filter(publicFallbackAllowed).map(host))
  const ordered: Lead[] = []
  for (const previouslyRejected of [false, true]) {
    let pending = leads.filter((lead) => rejected.has(host(lead.url)) === previouslyRejected)
    while (pending.length) {
      const seen = new Set<string>()
      const next: Lead[] = []
      for (const lead of pending) {
        const hostname = host(lead.url)
        if (seen.has(hostname)) next.push(lead)
        else {
          seen.add(hostname)
          ordered.push(lead)
        }
      }
      pending = next
    }
  }
  return ordered
}

function noResults(query: string): Payload {
  return {
    provider: 'agy-search-web',
    query,
    search_type: 'text',
    status: 'no_results',
    result_count: 0,
    results: [],
  }
}

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
  retail?: RetailOptions,
): Promise<Payload> {
  try {
    const result = await search(task ?? query, model, {}, env)
    if (result.outcome.kind !== 'done')
      return { error: 'Public search fallback unavailable', detail: result.outcome.kind, query }
    const raw = result.outcome.data
    if (
      retail &&
      (!raw ||
        typeof raw !== 'object' ||
        !Array.isArray((raw as Payload).results) ||
        ((raw as Payload).results as unknown[]).some(
          (item) =>
            !item ||
            typeof item !== 'object' ||
            typeof (item as Payload).title !== 'string' ||
            typeof (item as Payload).url !== 'string',
        ))
    )
      return { error: 'Public search fallback malformed result', query }
    const data = raw as { results: { title: string; url: string }[] }
    if (task !== undefined && Array.isArray(data.results) && data.results.length === 0)
      return noResults(query)
    const domains = sites(query)
    const resolved = await Promise.all(
      data.results.map(async (item) => ({
        title: item.title,
        url: await directUrl(item.url, fetcher),
      })),
    )
    const seen = new Set<string>()
    const valid = resolved.filter((item): item is { title: string; url: string } => {
      if (
        !item.url ||
        (retail && !publicFallbackAllowed(item.url)) ||
        (domains.length && !matchesSites(item.url, domains)) ||
        seen.has(item.url)
      )
        return false
      seen.add(item.url)
      return true
    })
    const eligible = retail
      ? valid.filter((item) => !nonPurchase(item.url, retail.nonPurchaseUrls))
      : valid
    // A policy-only empty set is a successful discovery; invalid, private or
    // out-of-scope candidates must still report a failure.
    if (
      retail &&
      valid.length > 0 &&
      eligible.length === 0 &&
      resolved.every(
        (item) =>
          item.url &&
          publicFallbackAllowed(item.url) &&
          (!domains.length || matchesSites(item.url, domains)),
      )
    )
      return noResults(query)
    const results = (retail ? diverse(eligible, retail.rejectedUrls) : eligible)
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
