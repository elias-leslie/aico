import { describe, expect, it } from 'vitest'
import { searchWeb } from './fetch'
import { search } from './search'

const RSS = '<item><title>Old result</title><link>https://example.com/old</link></item>'

describe('search fallback constraints', () => {
  it.each(['d', 'w', 'm', 'y'])(
    'never drops the text recency filter %s on fallback',
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
      expect(result).toHaveProperty('error')
      expect(calls).toEqual(['https://lite.duckduckgo.com/lite/'])
    },
  )

  it('refuses an unsupported yearly news filter before requesting unfiltered results', async () => {
    const calls: string[] = []
    const result = await search(
      { query: 'topic', type: 'news', timelimit: 'y', max: 1 },
      {},
      (async (url) => {
        calls.push(String(url))
        return new Response(RSS)
      }) as typeof fetch,
    )
    expect(result.provider).toBe('none')
    expect(result.errors[0]?.detail).toContain('recency')
    expect(calls).toEqual([])
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
