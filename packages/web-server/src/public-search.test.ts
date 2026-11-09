import { describe, expect, it, vi } from 'vitest'
import settings from '../data/service-apps.json' with { type: 'json' }
import { needsPublicSearch, publicSearchFallback, publicSearchUnavailable } from './public-search'

describe('public URL discovery', () => {
  const policy = settings.evidence.purposes.product_offers.non_purchase_urls
  const retailSearch = async (urls: string[], rejectedUrls: string[] = [], query = 'oil') => {
    const search = vi.fn().mockResolvedValue({
      outcome: { kind: 'done', data: { results: urls.map((url) => ({ title: url, url })) } },
    })
    return publicSearchFallback(query, 'model', 5, {}, 'Retail task', search, undefined, {
      rejectedUrls,
      nonPurchaseUrls: policy,
    })
  }

  it('diversifies hosts in stable rounds before limiting retail leads', async () => {
    const urls = [
      'https://a.example/1',
      'https://a.example/2',
      'https://b.example/1',
      'https://a.example/3',
      'https://c.example/1',
      'https://b.example/2',
      'https://d.example/1',
    ]
    const result = await retailSearch(urls)
    expect(result.results).toEqual(
      [urls[0], urls[2], urls[4], urls[6], urls[1]].map((url, i) => ({
        rank: i + 1,
        title: url,
        url,
      })),
    )
  })

  it('prefers new hosts but retains rejected hosts as a stable fallback', async () => {
    const urls = [
      'https://www.old.example/1',
      'https://new.example/1',
      'https://old.example/2',
      'https://new.example/2',
      'https://other.example/1',
    ]
    const result = await retailSearch(urls, ['https://old.example/failed'])
    expect((result.results as { url: string }[]).map(({ url }) => url)).toEqual([
      urls[1],
      urls[4],
      urls[3],
      urls[0],
      urls[2],
    ])
    const same = await retailSearch(
      urls.filter((url) => url.includes('old.example')),
      [urls[0] as string],
    )
    expect((same.results as { url: string }[]).map(({ url }) => url)).toEqual([urls[0], urls[2]])
  })

  it('filters only configured non-purchase roles while retaining product routes', async () => {
    const urls = [
      'https://www.target.com/s/oil',
      'https://www.target.com/p/item?showOnlyQuestions=true',
      'https://www.walmart.com/browse/food/oil',
      'https://www.walmart.com/c/kp/olive-oil',
      'https://www.californiaoliveranch.com/collections/oil',
      'https://www.target.com/p/item?showOnlyQuestions=false',
      'https://www.walmart.com/ip/item',
      'https://www.californiaoliveranch.com/collections/oil/products/item',
      'https://www.californiaoliveranch.com/products/item',
    ]
    const result = await retailSearch(urls)
    expect((result.results as { url: string }[]).map(({ url }) => url)).toEqual([
      urls[5],
      urls[6],
      urls[7],
      urls[8],
    ])
    expect(await retailSearch(urls.slice(0, 5))).toMatchObject({
      status: 'no_results',
      results: [],
    })
    expect(await retailSearch([])).toMatchObject({ status: 'no_results', results: [] })
  })

  it('preserves deduplication and site constraints, and reports invalid excluded mixes as failures', async () => {
    const url = 'https://www.target.com/p/item'
    const result = await retailSearch(
      [url, url, 'https://target.com.example.com/p/item'],
      [],
      'site:target.com oil',
    )
    expect(result.results).toEqual([{ rank: 1, title: url, url }])
    for (const bad of [
      'not a URL',
      'http://127.0.0.1/private',
      'https://target.com.example.com/p/item',
    ]) {
      expect(
        await retailSearch(['https://target.com/s/oil', bad], [], 'site:target.com oil'),
      ).toHaveProperty('error')
    }
    const failure = vi.fn().mockResolvedValue({ outcome: { kind: 'error' } })
    expect(
      await publicSearchFallback('oil', 'model', 5, {}, 'Retail task', failure, undefined, {
        rejectedUrls: [],
        nonPurchaseUrls: policy,
      }),
    ).toMatchObject({ error: 'Public search fallback unavailable', detail: 'error' })
    const malformed = vi.fn().mockResolvedValue({
      outcome: { kind: 'done', data: { results: [{ url: 'https://target.com/s/oil' }] } },
    })
    expect(
      await publicSearchFallback('oil', 'model', 5, {}, 'Retail task', malformed, undefined, {
        rejectedUrls: [],
        nonPurchaseUrls: policy,
      }),
    ).toMatchObject({ error: 'Public search fallback malformed result' })
  })
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
