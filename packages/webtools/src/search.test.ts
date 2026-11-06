import { describe, expect, it } from 'vitest'
import { searchWeb } from './fetch'
import { search } from './search'

const RSS = '<item><title>Old result</title><link>https://example.com/old</link></item>'

describe('search fallback constraints', () => {
  it.each(['d', 'w', 'm', 'y'])(
    'falls back to Bing for text recency %s and labels the results as not time-filtered',
    async (timelimit) => {
      const calls: string[] = []
      const result = await searchWeb(
        'topic',
        { timelimit },
        {
          env: {},
          fetch: (async (url) => {
            calls.push(String(url))
            return new Response(String(url).includes('duckduckgo') ? 'captcha' : RSS)
          }) as typeof fetch,
        },
      )
      expect(result).not.toHaveProperty('error')
      expect(result).toMatchObject({
        provider: 'bing',
        status: 'results',
        timelimit,
        time_filtered: false,
      })
      expect(String(result.note)).toContain('NOT limited')
      expect(calls).toHaveLength(2)
    },
  )

  it('labels yearly news as not time-filtered instead of failing', async () => {
    const result = await search(
      { query: 'topic', type: 'news', timelimit: 'y', max: 1 },
      {},
      (async () => new Response(RSS)) as typeof fetch,
    )
    expect(result.provider).toBe('bing')
    expect(result.time_filtered).toBe(false)
    expect(result.results).toHaveLength(1)
  })

  it('does not label a filtered Bing news answer as unfiltered', async () => {
    const result = await search(
      { query: 'topic', type: 'news', timelimit: 'w', max: 1 },
      {},
      (async () => new Response(RSS)) as typeof fetch,
    )
    expect(result).not.toHaveProperty('time_filtered')
  })

  it('reports zero results as no_results even after a failed provider', async () => {
    const result = await searchWeb(
      'topic',
      {},
      {
        env: {},
        fetch: (async (url) =>
          String(url).includes('duckduckgo')
            ? new Response('captcha')
            : new Response('<rss></rss>')) as typeof fetch,
      },
    )
    expect(result).not.toHaveProperty('error')
    expect(result).toMatchObject({ status: 'no_results', result_count: 0, provider: 'bing' })
  })

  it('does not fall back from news to ordinary DuckDuckGo text results', async () => {
    const calls: string[] = []
    const result = await searchWeb(
      'topic',
      { type: 'news' },
      {
        env: {},
        fetch: (async (url) => {
          calls.push(String(url))
          return String(url).includes('bing')
            ? new Response('', { status: 429 })
            : new Response('<a href="https://example.com/" class="result-link">Web result</a>')
        }) as typeof fetch,
      },
    )
    expect(result).toHaveProperty('error')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/news/search?')
  })

  it.each(['d', 'w', 'm', 'y'])(
    'keeps news scope and recency %s with SearXNG',
    async (timelimit) => {
      let requested = ''
      const result = await searchWeb(
        'topic',
        { type: 'news', timelimit },
        {
          env: { WEB_SEARCH_SEARXNG_URL: 'https://search.example' },
          fetch: (async (url) => {
            requested = String(url)
            return Response.json({ results: [{ title: 'News', url: 'https://example.com/news' }] })
          }) as typeof fetch,
        },
      )
      const params = new URL(requested).searchParams
      expect(params.get('categories')).toBe('news')
      expect(params.get('time_range')).toBe(
        { d: 'day', w: 'week', m: 'month', y: 'year' }[timelimit],
      )
      expect(result).toMatchObject({ search_type: 'news', timelimit, result_count: 1 })
    },
  )
})
