import { describe, expect, it, vi } from 'vitest'
import { needsPublicSearch, publicSearchFallback, publicSearchUnavailable } from './public-search'

describe('public URL discovery', () => {
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
    expect(await publicSearchFallback('query', 'model', 5, {}, fail)).toMatchObject({
      error: 'Public search fallback unavailable',
    })
    const other = vi.fn().mockResolvedValue({
      outcome: {
        kind: 'done',
        data: { results: [{ title: 'wrong', url: 'https://example.com/' }] },
      },
    })
    expect(await publicSearchFallback('site:costco.com oil', 'model', 5, {}, other)).toMatchObject({
      error: 'Public search fallback found no matching URLs',
    })
  })
})
