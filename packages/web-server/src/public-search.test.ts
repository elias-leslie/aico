import { describe, expect, it, vi } from 'vitest'
import { needsPublicSearch, publicSearchFallback, publicSearchUnavailable } from './public-search'

describe('public URL discovery', () => {
  it('keeps generic empty searches and invalid retail URLs distinct from explicit empty retail results', async () => {
    const empty = vi.fn().mockResolvedValue({
      outcome: { kind: 'done', data: { results: [] } },
    })
    expect(await publicSearchFallback('query', 'model', 5, {}, undefined, empty)).toMatchObject({
      error: 'Public search fallback found no matching URLs',
    })
    const invalid = vi.fn().mockResolvedValue({
      outcome: { kind: 'done', data: { results: [{ title: 'Invalid', url: 'not a URL' }] } },
    })
    expect(
      await publicSearchFallback('query', 'model', 5, {}, 'Retail task', invalid),
    ).toMatchObject({
      error: 'Public search fallback found no matching URLs',
    })
  })

  it('sends the configured task to model discovery while preserving the original query scope', async () => {
    const query = 'site:retailer.example olive oil'
    const task = 'Configured retail task and public query data.'
    const search = vi.fn().mockResolvedValue({
      outcome: {
        kind: 'done',
        data: {
          results: [
            { title: 'Retailer', url: 'https://retailer.example/product' },
            { title: 'Other', url: 'https://other.example/article' },
          ],
        },
      },
    })
    const result = await publicSearchFallback(query, 'model', 5, {}, task, search)
    expect(search).toHaveBeenCalledWith(task, 'model', {}, {})
    expect(result).toMatchObject({
      query,
      results: [{ title: 'Retailer', url: 'https://retailer.example/product' }],
    })
  })

  it('distinguishes provider outages from missing evidence or a policy refusal', () => {
    expect(publicSearchUnavailable({ error: 'Public search fallback unavailable' })).toBe(true)
    expect(
      publicSearchUnavailable({ error: 'Public search fallback unavailable', detail: 'silent' }),
    ).toBe(true)
    expect(
      publicSearchUnavailable({
        error: 'Public search fallback unavailable',
        detail: 'model_refused',
      }),
    ).toBe(false)
    expect(
      publicSearchUnavailable({ error: 'Public search fallback found no matching URLs' }),
    ).toBe(false)
    expect(publicSearchUnavailable({ results: [] })).toBe(false)
  })

  it('triggers for failed and empty searches, and for a missing requested site', () => {
    expect(needsPublicSearch('olive oil', { error: 'offline' })).toBe(true)
    expect(needsPublicSearch('olive oil', { results: [] })).toBe(true)
    expect(
      needsPublicSearch('site:costco.com oil', { results: [{ url: 'https://notcostco.com/' }] }),
    ).toBe(true)
    expect(
      needsPublicSearch('site:costco.com oil', { results: [{ url: 'https://www.costco.com/' }] }),
    ).toBe(false)
    expect(needsPublicSearch('olive oil', { results: [{ url: 'https://example.com/' }] })).toBe(
      false,
    )
  })

  it.each([
    '(site:costco.com OR site:costcobusinessdelivery.com) 1221092 Costco item',
    '(SITE:costco.com) oil',
  ])('requires a requested domain in parenthesized query %s', (query) => {
    for (const url of [
      'https://bing.com/irrelevant',
      'https://notcostco.com/item',
      'https://costco.com.example.com/item',
      'https://costco.com@other.example/item',
      'https://costco.com:invalid/item',
      'not a URL',
    ])
      expect(needsPublicSearch(query, { results: [{ url }] })).toBe(true)
  })

  it.each([
    '(site:costco.com OR site:costcobusinessdelivery.com) oil',
    'site:costco.com OR site:costcobusinessdelivery.com oil',
  ])('accepts any requested domain or its subdomains in %s', (query) => {
    for (const url of [
      'https://costco.com/item',
      'https://www.costco.com/item',
      'https://costcobusinessdelivery.com/item',
      'https://www.costcobusinessdelivery.com/item',
    ])
      expect(needsPublicSearch(query, { results: [{ url }] })).toBe(false)
  })

  it('filters fallback results to every domain in a parenthesized OR scope', async () => {
    const search = vi.fn().mockResolvedValue({
      outcome: {
        kind: 'done',
        data: {
          results: [
            { title: 'Other', url: 'https://example.com/item' },
            { title: 'Spoofed suffix', url: 'https://costco.com.example.com/item' },
            { title: 'Malformed', url: 'not a URL' },
            { title: 'Costco', url: 'https://www.costco.com/item' },
            { title: 'Business', url: 'https://www.costcobusinessdelivery.com/item' },
          ],
        },
      },
    })
    const result = await publicSearchFallback(
      '(site:costco.com OR site:costcobusinessdelivery.com) 1221092 Costco item',
      'model',
      5,
      {},
      undefined,
      search,
    )
    expect(result).toMatchObject({
      result_count: 2,
      results: [
        { rank: 1, title: 'Costco', url: 'https://www.costco.com/item' },
        { rank: 2, title: 'Business', url: 'https://www.costcobusinessdelivery.com/item' },
      ],
    })
    expect(search).toHaveBeenCalledWith(
      '(site:costco.com OR site:costcobusinessdelivery.com) 1221092 Costco item',
      'model',
      {},
      {},
    )
  })

  it('reports no matching URLs when an OR-scoped fallback returns only unrelated URLs', async () => {
    const search = vi.fn().mockResolvedValue({
      outcome: {
        kind: 'done',
        data: { results: [{ title: 'Other', url: 'https://example.com/' }] },
      },
    })
    expect(
      await publicSearchFallback(
        '(site:costco.com OR site:costcobusinessdelivery.com) oil',
        'model',
        5,
        {},
        undefined,
        search,
      ),
    ).toMatchObject({ error: 'Public search fallback found no matching URLs' })
  })

  it('resolves only Google grounding redirects and filters the actual destination', async () => {
    const search = vi.fn().mockResolvedValue({
      outcome: {
        kind: 'done',
        data: {
          results: [
            {
              title: 'Costco',
              url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/example',
            },
            { title: 'Other', url: 'https://example.com/' },
          ],
        },
      },
    })
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://www.costco.com/item' } }),
      )
    const result = await publicSearchFallback(
      'site:costco.com oil',
      'gemini-3.8-flash',
      5,
      {},
      undefined,
      search,
      fetcher,
    )
    expect(result).toMatchObject({
      provider: 'agy-search-web',
      results: [{ title: 'Costco', url: 'https://www.costco.com/item' }],
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1]).toEqual({ redirect: 'manual' })
  })

  it('returns an unavailable result on failure and no unrelated results on an empty match', async () => {
    const fail = vi.fn().mockResolvedValue({ outcome: { kind: 'error' } })
    expect(await publicSearchFallback('query', 'model', 5, {}, undefined, fail)).toMatchObject({
      error: 'Public search fallback unavailable',
    })
    const other = vi.fn().mockResolvedValue({
      outcome: {
        kind: 'done',
        data: { results: [{ title: 'wrong', url: 'https://example.com/' }] },
      },
    })
    expect(
      await publicSearchFallback('site:costco.com oil', 'model', 5, {}, undefined, other),
    ).toMatchObject({
      error: 'Public search fallback found no matching URLs',
    })
  })
})
