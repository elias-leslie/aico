import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ContextFillBadge } from './ContextFillBadge'

function show(mode: string, contextTokens: number | null) {
  const fetcher = vi.fn(async (_url: string) =>
    Response.json({ items: [{ tool: mode, startedAt: 1, contextTokens }] }),
  )
  vi.stubGlobal('fetch', fetcher)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ContextFillBadge sessionId="abc12345" mode={mode} />
    </QueryClientProvider>,
  )
  return fetcher
}
afterEach(() => vi.unstubAllGlobals())

it("shows an agent session's context in use", async () => {
  const fetcher = show('claude-code', 206_151)
  const badge = await screen.findByTestId('context-fill')
  expect(badge).toHaveTextContent('206k')
  expect(badge).toHaveAttribute(
    'title',
    'Context in use: 206,151 tokens at the latest reply',
  )
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    '/api/history?session=abc12345&limit=5',
  )
})

it('shows nothing for a shell, or before a count is read', async () => {
  const shell = show('shell', 5)
  await Promise.resolve()
  expect(shell).not.toHaveBeenCalled()
  expect(screen.queryByTestId('context-fill')).toBeNull()
})

it('shows nothing, not zero, when no count is read yet', async () => {
  const fetcher = show('codex', null)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
  await Promise.resolve()
  expect(screen.queryByTestId('context-fill')).toBeNull()
})
