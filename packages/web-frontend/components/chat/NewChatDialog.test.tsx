import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NewChatDialog } from './NewChatDialog'

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
afterEach(() => vi.unstubAllGlobals())
it.each(['hunting', 'recon'])(
  'starts the chosen contained role through the ordinary dialog: %s',
  async (role) => {
    const options = {
      defaultRole: 'implementation',
      projects: [{ id: 'scratch', name: 'Scratch', root: '/scratch' }],
      roles: ['implementation', 'hunting', 'recon'].map((role) => ({
        role,
        description: 'Role rules apply.',
        chain: [{ id: 'first', effort: 'high', reason: 'From routing' }],
        error: null,
      })),
    }
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === 'POST' ? { id: '1234abcd' } : options,
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetcher)
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <NewChatDialog onClose={vi.fn()} />
      </QueryClientProvider>,
    )
    fireEvent.click(
      await screen.findByRole('radio', { name: new RegExp(role, 'i') }),
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Work within the role rules.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([, init]) => init?.method === 'POST'),
      ).toBe(true),
    )
    const request = fetcher.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    )
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      role,
      cwd: '/scratch',
    })
    expect(push).toHaveBeenCalledWith('/?session=1234abcd')
  },
)
