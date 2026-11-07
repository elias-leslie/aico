import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LoginsPage } from './LoginsPage'

vi.mock('@/lib/hooks/use-hosts', () => ({
  useHosts: () => ({
    hosts: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))
vi.mock('./HostsSheet', () => ({ HostSignIn: () => null }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const entry = {
  name: 'scratch',
  kind: 'password',
  notes: 'Scratch entry',
  state: 'Unused',
  machines: ['local'],
  roles: ['*'],
  created: '2026-11-04T12:00:00Z',
  rotated: null,
  lastUsed: null,
}
it('reveals only after a recorded API request and hides again after thirty seconds', async () => {
  const fetcher = vi.fn(async (path: string) =>
    Response.json(
      path.endsWith('/reveal')
        ? { value: 'fixture-private-value' }
        : path.endsWith('/sessions')
          ? { sessions: [] }
          : path.endsWith('/audit')
            ? { events: [] }
            : { entries: [entry], assignments: {}, revealSeconds: 30 },
    ),
  )
  vi.stubGlobal('fetch', fetcher)
  render(<LoginsPage />)
  expect(await screen.findByText('scratch')).toBeInTheDocument()
  expect(screen.queryByText('fixture-private-value')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /scratch/ }))
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
  })
  expect(screen.getByText('fixture-private-value')).toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledWith(
    '/api/logins/scratch/reveal',
    expect.objectContaining({ method: 'POST' }),
  )
  await act(async () => {
    vi.advanceTimersByTime(30000)
  })
  expect(screen.queryByText('fixture-private-value')).toBeNull()
  expect(screen.getByRole('button', { name: 'Reveal' })).toBeInTheDocument()
})
it('shows a failed list separately from an empty store', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ detail: 'Logins could not load.' }, { status: 503 }),
    ),
  )
  render(<LoginsPage />)
  expect(await screen.findByText('Logins could not load.')).toBeInTheDocument()
  expect(
    screen.queryByText('No logins saved yet. Add one to get started.'),
  ).toBeNull()
})
it.each(['add', 'replace'])(
  'clears the %s form after a saved value even when a machine is offline',
  async (mode) => {
    const warning =
      'Saved here. An offline machine will sync when it reconnects.'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, options?: RequestInit) =>
        Response.json(
          options?.method === 'POST'
            ? { warning }
            : _path.endsWith('/sessions')
              ? { sessions: [] }
              : { entries: [entry], assignments: {}, revealSeconds: 30 },
        ),
      ),
    )
    render(<LoginsPage />)
    await screen.findByText('scratch')
    if (mode === 'replace')
      fireEvent.click(screen.getByRole('button', { name: /scratch/ }))
    fireEvent.click(
      screen.getByRole('button', {
        name: mode === 'add' ? 'Add login' : 'Replace',
      }),
    )
    if (mode === 'add')
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'new-scratch' },
      })
    fireEvent.change(
      screen.getByLabelText(
        mode === 'add' ? 'Value (hidden)' : 'New value (hidden)',
      ),
      { target: { value: 'fixture-only' } },
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: mode === 'add' ? 'Save login' : 'Replace login',
      }),
    )
    await screen.findByText(warning)
    expect(
      screen.queryByLabelText(
        mode === 'add' ? 'Value (hidden)' : 'New value (hidden)',
      ),
    ).toBeNull()
  },
)
