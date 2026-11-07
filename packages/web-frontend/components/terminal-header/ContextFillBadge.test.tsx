import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContextFillBadge } from './ContextFillBadge'

const registry = vi.hoisted(() => ({
  tools: [] as Array<{ slug: string; aliases: string[]; status_line: boolean }>,
  isLoading: false,
}))
vi.mock('@/lib/hooks/use-agent-tools', () => ({
  useAgentTools: () => ({
    agentTools: registry.tools,
    isLoading: registry.isLoading,
  }),
}))

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
beforeEach(() => {
  registry.isLoading = false
  registry.tools = [
    { slug: 'claude-code', aliases: ['claude'], status_line: true },
    { slug: 'codex', aliases: [], status_line: true },
    { slug: 'pi', aliases: [], status_line: false },
  ]
})
afterEach(() => vi.unstubAllGlobals())

it("shows a session's context in use for a tool with no status line of its own", async () => {
  const fetcher = show('pi', 206_151)
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

it.each([['claude-code'], ['claude'], ['codex']])(
  'leaves it to %s’s own status line, and does not even ask for the count',
  async (mode) => {
    const fetcher = show(mode, 133_000)
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.queryByTestId('context-fill')).toBeNull()
  },
)

it('shows nothing while the tool registry is loading, rather than flash and hide', async () => {
  registry.isLoading = true
  const fetcher = show('pi', 5_000)
  await Promise.resolve()
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.queryByTestId('context-fill')).toBeNull()
})

it('shows nothing for a shell, or before a count is read', async () => {
  const shell = show('shell', 5)
  await Promise.resolve()
  expect(shell).not.toHaveBeenCalled()
  expect(screen.queryByTestId('context-fill')).toBeNull()
})

it('shows nothing, not zero, when no count is read yet', async () => {
  const fetcher = show('pi', null)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
  await Promise.resolve()
  expect(screen.queryByTestId('context-fill')).toBeNull()
})
