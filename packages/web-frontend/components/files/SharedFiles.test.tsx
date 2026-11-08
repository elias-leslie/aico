import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharedFiles } from './SharedFiles'

const base = {
  createdAt: '2026-10-27T10:00:00.000Z',
  kind: 'files',
  paths: ['/srv/out/image.png'],
}

function renderShares(
  shows: unknown[],
  sessionName: (id: string) => string | null,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ shows }))),
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SharedFiles sessionName={sessionName} onOpenPath={vi.fn()} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SharedFiles', () => {
  it('names the session when it is known, and claims no cause when it is not', async () => {
    renderShares(
      [
        { ...base, id: 'aaaaaaaaaaa1', session: 'ab12cd34', title: 'Known' },
        {
          ...base,
          id: 'bbbbbbbbbbb2',
          session: 'zz99zz99',
          title: 'Unmatched',
        },
        { ...base, id: 'ccccccccccc3', session: null, title: 'None' },
      ],
      (id) => (id === 'ab12cd34' ? 'Research' : null),
    )
    const tip = async (title: string) =>
      (await screen.findByText(title)).parentElement?.getAttribute('title')
    expect(await tip('Known')).toMatch(/^Shared by session “Research”,/)
    for (const title of ['Unmatched', 'None']) {
      const text = await tip(title)
      expect(text).toMatch(/^Shared by an agent,/)
      expect(text).not.toMatch(/ended/)
    }
  })
})
